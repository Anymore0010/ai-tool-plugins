/**
 * Loomy upstream client.
 *
 * Everything the bridge needs is behind one account session:
 *
 * - `GET {base}/models` answers the account's model catalogue with far more
 *   than the OpenAI shape: `protocol` (chat vs image), `context_length`,
 *   `max_output_tokens`, `reasoning_efforts`, the default effort, and a
 *   `capabilities` block (reasoning / vision / function calling / modalities).
 *   The catalogue is server-controlled, so nothing here is hard-coded.
 * - `POST {base}/chat/completions` is plain OpenAI chat completions, including
 *   SSE deltas, tool calls and a `reasoning_content` field. Its `usage` also
 *   carries magpie-style `points_consumed`, which is what a request actually
 *   costs the plan.
 * - The account's points balance lives on the Loomy integration service
 *   (`GET /api/v1/team-points/balance` → `data.data.currentBalance`).
 *
 * Two things are Loomy-specific and matter:
 *
 * - The credential is sent **twice**, as `token` and as
 *   `Authorization: Bearer`, because different surfaces read different ones.
 * - A **`traceparent`** must be present. Without it `chat/completions` hangs
 *   until the client times out (the desktop app's own comment records this),
 *   so the shim always mints one.
 */

import type { LoomyCredential } from "./auth"

/** Production inference base; a live install can override it. */
export const DEFAULT_API_BASE = "https://loomyad.xunfei.cn/api/v1"
/** Points/account service, where the balance lives. */
export const DEFAULT_POINTS_BASE = "https://ossptest.voicecloud.cn/loomy/integration"
/** Overrides the inference base outright. */
export const LOOMY_API_BASE_ENV = "LOOMY_API_BASE"

/** Product name the platform expects in the version header. */
const PRODUCT_VERSION = "1.3.0"
/**
 * `chat/completions` needs a `traceparent`; the desktop app reproduces the W3C
 * shape, and so does this. A fresh span id per request keeps traces distinct.
 */
const TRACE_FLAGS = "01"

/** The account's model catalogue, normalized out of Loomy's richer shape. */
export interface LoomyModel {
  id: string
  /** Display name as the platform spells it, minus the points multiplier. */
  name: string
  object: string
  /** `chat` or `image`; only chat models are usable as a provider. */
  type: string
  /** `openai_chat` for every model seen; kept for future protocols. */
  protocol: string
  contextLength?: number
  maxOutputTokens?: number
  /** Levels the platform accepts for this model, including `none`. */
  reasoningEfforts: string[]
  defaultReasoningEffort?: string
  reasoning: boolean
  vision: boolean
  functionCalling: boolean
  streaming: boolean
  inputModalities: string[]
  /** Points multiplier parsed off the display name (`x2.0`), when present. */
  rate?: number
  isDefault: boolean
  isDefaultSmall: boolean
}

/** Plan/points snapshot, for diagnostics. */
export interface LoomyAccountSnapshot {
  balance?: number
}

export class LoomyUpstreamError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "LoomyUpstreamError"
  }
}

/** Raised when the account session itself is rejected: sign in again. */
export class LoomySessionExpiredError extends LoomyUpstreamError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "LoomySessionExpiredError"
  }
}

/** Cold discovery must answer inside omp's `fetchDynamicModels` budget. */
const REQUEST_TIMEOUT_MS = 12_000

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/** Non-empty trimmed string, or `undefined` — absent and blank mean the same. */
function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

/** Number, or a numeric string; anything else (including `null`) is `undefined`. */
function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  const text = asText(value)
  if (text === undefined) return undefined
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * The points multiplier is published **inside the display name** — `DeepSeek
 * V4.1 Flash(x2.0)`, `qwen 3.8 flash（x0.8）`, `Spark-X2.5（限时免费）(x0.0)` —
 * in both ASCII and full-width brackets, so both are matched.
 */
function parseRate(name: string): { name: string; rate?: number } {
  const match = /[(（]\s*x\s*([\d.]+)\s*[)）]\s*$/u.exec(name)
  if (match?.[1] === undefined) return { name }
  const rate = asNumber(match[1])
  const base = name.slice(0, match.index).trim()
  return { name: base === "" ? name : base, ...(rate === undefined ? {} : { rate }) }
}

function parseModelRow(value: unknown): LoomyModel | undefined {
  const row = asRecord(value)
  if (row === undefined) return undefined
  const id = asText(row.id)
  if (id === undefined) return undefined
  const rawName = asText(row.name) ?? id
  const named = parseRate(rawName)
  const capabilities = asRecord(row.capabilities) ?? {}
  const efforts = Array.isArray(row.reasoning_efforts)
    ? row.reasoning_efforts.map(asText).filter((effort): effort is string => effort !== undefined)
    : []
  const modalities = Array.isArray(capabilities.input_modalities)
    ? capabilities.input_modalities.map(asText).filter((entry): entry is string => entry !== undefined)
    : []
  return {
    id,
    name: named.name,
    object: asText(row.object) ?? "model",
    type: asText(row.type) ?? "chat",
    protocol: asText(row.protocol) ?? "",
    contextLength: asNumber(row.context_length),
    maxOutputTokens: asNumber(row.max_output_tokens) ?? asNumber(row.max_completion_tokens),
    reasoningEfforts: efforts,
    defaultReasoningEffort: asText(row.default_reasoning_effort),
    reasoning: capabilities.reasoning === true || efforts.length > 0,
    vision: capabilities.vision === true || modalities.includes("image"),
    functionCalling: capabilities.function_calling === true,
    streaming: capabilities.streaming !== false,
    inputModalities: modalities,
    ...(named.rate === undefined ? {} : { rate: named.rate }),
    isDefault: row.is_default_model === true,
    isDefaultSmall: row.is_default_small_model === true,
  }
}

/**
 * The auth headers every Loomy call carries.
 *
 * The session goes out under both names because the surfaces disagree on which
 * they read, and `traceparent` is mandatory on the chat path.
 */
export function authHeaders(credential: LoomyCredential): Record<string, string> {
  const traceId = randomHex(16)
  return {
    Accept: "application/json",
    token: credential.session,
    Authorization: `Bearer ${credential.session}`,
    "loomy-version": PRODUCT_VERSION,
    traceparent: `00-${traceId}-${randomHex(8)}-${TRACE_FLAGS}`,
    InvokeOrigin: "loomy-desktop",
    "X-Loomy-Source": "desktop",
  }
}

function randomHex(bytes: number): string {
  // A trace id only has to be unique per request, and this runs on Node's
  // global crypto, which every supported runtime provides.
  const values = new Uint8Array(bytes)
  crypto.getRandomValues(values)
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("")
}

/** Effective inference base: the env override, else production. */
export function resolveApiBase(): string {
  const override = process.env[LOOMY_API_BASE_ENV]?.trim()
  const base = override !== undefined && override !== "" ? override : DEFAULT_API_BASE
  return base.replace(/\/+$/u, "")
}

async function requestJson(url: string, credential: LoomyCredential, what: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      headers: { ...authHeaders(credential), ...(init?.headers as Record<string, string> | undefined) },
      signal: controller.signal,
    })
  } catch (error: unknown) {
    throw new LoomyUpstreamError(
      `${what}：请求失败（${error instanceof Error ? error.message : String(error)}）`,
      { cause: error },
    )
  } finally {
    clearTimeout(timer)
  }
  if (response.status === 401 || response.status === 403) {
    throw new LoomySessionExpiredError(
      `${what}：Loomy 账号会话被拒绝（HTTP ${response.status}），请在 Loomy 桌面端重新登录`,
    )
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch (error: unknown) {
    throw new LoomyUpstreamError(`${what}：返回的不是 JSON（HTTP ${response.status}）`, { cause: error })
  }
  if (!response.ok) {
    const record = asRecord(payload)
    const detail =
      record === undefined ? undefined : (asText(record.message) ?? asText(record.detail) ?? asText(record.error))
    throw new LoomyUpstreamError(`${what}：${detail ?? `HTTP ${response.status}`}`)
  }
  return payload
}

export class LoomyUpstreamClient {
  /** The account's catalogue, chat models only (image models are not a provider). */
  async fetchModels(credential: LoomyCredential, base = resolveApiBase()): Promise<LoomyModel[]> {
    const payload = await requestJson(`${base}/models`, credential, "拉取 Loomy 模型列表")
    const record = asRecord(payload)
    const rows = Array.isArray(record?.data) ? (record.data as unknown[]) : []
    const models: LoomyModel[] = []
    for (const row of rows) {
      const parsed = parseModelRow(row)
      if (parsed !== undefined && parsed.type === "chat") models.push(parsed)
    }
    if (models.length === 0) {
      throw new LoomyUpstreamError("拉取 Loomy 模型列表：响应里没有可用的对话模型")
    }
    return models
  }

  /** The account's points balance, for status reporting. */
  async fetchBalance(credential: LoomyCredential, pointsBase: string): Promise<LoomyAccountSnapshot> {
    // `/api/v1/points/records` is the only balance a personal account has:
    // `team-points/balance` answers "not switched to a team" for it, and the
    // records envelope carries the spendable total.
    const payload = await requestJson(
      `${pointsBase.replace(/\/+$/u, "")}/api/v1/points/records?pageNo=1&pageSize=1&recordType=all`,
      credential,
      "查询 Loomy 积分",
    )
    const outer = asRecord(payload)
    const code = asText(outer?.code)
    if (code !== undefined && code !== "000000") {
      throw new LoomyUpstreamError(`查询 Loomy 积分：${asText(outer?.desc) ?? code}`)
    }
    const inner = asRecord(outer?.data)
    const balance =
      inner === undefined ? undefined : asNumber(inner.availableBalance ?? inner.balance ?? inner.currentBalance)
    return balance === undefined ? {} : { balance }
  }
}
