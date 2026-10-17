/**
 * WingWork (iKooky) upstream client.
 *
 * Two surfaces, both on the One platform gateway:
 *
 *  1. `GET {origin}/kooky-api/api/client/v3/cli/config` — exchanges the
 *     renderer's account JWT for the inference credential (`ANTHROPIC_AUTH_TOKEN`,
 *     an `sk-…` key) plus the account's model roster. This is exactly what the
 *     desktop app calls on launch; the key is never persisted to disk, so we
 *     must re-exchange it ourselves.
 *  2. `POST {baseUrl}/v1/messages` — Anthropic Messages wire. The gateway
 *     proxies straight through, including thinking tags, tool definitions with
 *     `strict`, and streaming SSE, so the shim forwards rather than translates.
 *
 * Wire facts verified against the live gateway:
 *  - `/kooky-api/*` requires a non-curl `User-Agent`; requests without one are
 *    answered with the One platform's HTML 403 page (not a JSON error).
 *  - `/v1/messages` accepts the credential as either `x-api-key` or
 *    `Authorization: Bearer`.
 *  - `?beta=true` on `/v1/messages` is accepted and ignored.
 */

import type { WingWorkCredential } from "./auth"

export const DEFAULT_ORIGIN = "https://one.iflytek.com"
/**
 * The desktop build can point at the One platform's dev / test / delivery
 * environments, so the origin is overridable for installs that are not on prod
 * (and for local testing).
 */
export const WINGWORK_ORIGIN_ENV = "WINGWORK_ORIGIN"
export const CLI_CONFIG_PATH = "/kooky-api/api/client/v3/cli/config"
/**
 * The gateway rejects requests whose `User-Agent` is a bare HTTP-client default
 * (`curl/…`, `Python-urllib/…`) with the platform's HTML 403 page. The desktop
 * app's own product name is accepted, so use it.
 */
const GATEWAY_USER_AGENT = "WingWork"
/**
 * Cold discovery must answer inside omp's 15 s `fetchDynamicModels` budget;
 * the exchange is a single small GET, so a short ceiling is plenty and keeps a
 * hung gateway from stalling model discovery.
 */
const CONFIG_TIMEOUT_MS = 12_000

export interface WingWorkUpstreamModel {
  id: string
  name: string
  /** Upstream-advertised input window, when the account's roster carries one. */
  contextLimit?: number
}

export interface WingWorkUpstreamConfig {
  /** `ANTHROPIC_AUTH_TOKEN` — the `sk-…` inference credential. */
  apiKey: string
  /** `ANTHROPIC_BASE_URL` — inference base the desktop app injects into Claude Code. */
  baseUrl: string
  models: WingWorkUpstreamModel[]
}

export class WingWorkUpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
  ) {
    super(message)
    this.name = "WingWorkUpstreamError"
  }
}

/** Raised when the account JWT itself is rejected and the operator must sign in again. */
export class WingWorkAuthError extends WingWorkUpstreamError {
  constructor(message: string) {
    super(message, 401)
    this.name = "WingWorkAuthError"
  }
}

/** Fields the roster may carry the input window under, in probe order. */
const CONTEXT_LIMIT_FIELDS = [
  "context_input_limit_tokens",
  "contextInputLimitTokens",
  "context_window_size",
  "contextWindowSize",
  "max_input_tokens",
  "maxInputTokens",
  "context_length",
  "contextLength",
] as const

function parseModelRow(value: unknown): WingWorkUpstreamModel | undefined {
  if (value === null || typeof value !== "object") return undefined
  const row = value as Record<string, unknown>
  const id = String(row["model_code"] ?? row["modelCode"] ?? row["id"] ?? "").trim()
  if (id === "") return undefined
  const alias = String(row["model_name"] ?? row["modelName"] ?? row["name"] ?? "").trim()
  for (const field of CONTEXT_LIMIT_FIELDS) {
    const limit = Number(row[field])
    if (Number.isFinite(limit) && limit > 0) {
      return { id, name: alias === "" ? id : alias, contextLimit: limit }
    }
  }
  return { id, name: alias === "" ? id : alias }
}

/** Normalize the exchange answer; both the flat and `{data:…}` envelope shapes occur. */
function parseConfig(value: unknown): WingWorkUpstreamConfig | undefined {
  if (value === null || typeof value !== "object") return undefined
  const envelope = value as Record<string, unknown>
  const nested = envelope["data"]
  const body =
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : envelope
  const apiKey = body["ANTHROPIC_AUTH_TOKEN"]
  const baseUrl = body["ANTHROPIC_BASE_URL"]
  if (typeof apiKey !== "string" || apiKey.trim() === "") return undefined
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") return undefined
  const roster = body["models"]
  const models = Array.isArray(roster) ? roster.map(parseModelRow).filter(row => row !== undefined) : []
  return {
    apiKey: apiKey.trim(),
    baseUrl: baseUrl.trim().replace(/\/+$/, ""),
    models: models.filter((row, index) => models.findIndex(other => other.id === row.id) === index),
  }
}

/** Human-readable message for a failed exchange, splitting auth from transport failures. */
async function describeFailure(response: Response): Promise<string> {
  let detail = ""
  try {
    const text = await response.text()
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown }; detail?: unknown; message?: unknown }
      const message = parsed.error?.message ?? parsed.detail ?? parsed.message
      if (typeof message === "string" && message !== "") detail = message
    } catch {
      detail = text.startsWith("<!DOCTYPE") || text.startsWith("<html")
        ? "网关返回 HTML 拦截页（凭据可能已失效）"
        : text.slice(0, 200)
    }
  } catch {
    // body already consumed or unreadable; the status alone is the diagnosis
  }
  return detail === "" ? `HTTP ${response.status}` : `HTTP ${response.status}: ${detail}`
}

/** Effective One-platform origin: the env override when set, else production. */
function resolveOrigin(): string {
  const override = process.env[WINGWORK_ORIGIN_ENV]?.trim()
  if (override === undefined || override === "") return DEFAULT_ORIGIN
  return /^https?:\/\//i.test(override) ? override.replace(/\/+$/, "") : `https://${override.replace(/\/+$/, "")}`
}

export class WingWorkUpstreamClient {
  constructor(private readonly origin: string = resolveOrigin()) {}

  /**
   * Exchange the account JWT for the inference credential and model roster.
   * Callers should treat {@link WingWorkAuthError} as "sign in to the desktop
   * app again" and every other failure as "the gateway is unreachable".
   */
  async fetchConfig(credential: WingWorkCredential, signal?: AbortSignal): Promise<WingWorkUpstreamConfig> {
    const timeout = AbortSignal.timeout(CONFIG_TIMEOUT_MS)
    const response = await fetch(`${this.origin}${CLI_CONFIG_PATH}`, {
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        Accept: "application/json",
        "User-Agent": GATEWAY_USER_AGENT,
      },
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    }).catch((error: unknown) => {
      throw new WingWorkUpstreamError(
        `连接 ${this.origin} 失败：${error instanceof Error ? error.message : String(error)}`,
        undefined,
      )
    })
    if (!response.ok) {
      const detail = await describeFailure(response)
      if (response.status === 401 || response.status === 403) {
        throw new WingWorkAuthError(`凭据被网关拒绝（${detail}）——请在 iKooky 桌面端重新登录`)
      }
      throw new WingWorkUpstreamError(detail, response.status)
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new WingWorkUpstreamError("凭据交换返回了非 JSON 响应", response.status)
    }
    const config = parseConfig(payload)
    if (config === undefined) {
      throw new WingWorkUpstreamError("凭据交换响应缺少 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL", response.status)
    }
    return config
  }
}
