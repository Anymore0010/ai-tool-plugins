/**
 * AStudio (AstronClaw) studio-API client.
 *
 * Everything the bridge needs is served by one origin — `agent.xfyun.cn`
 * (production) — behind the account session cookie:
 *
 * - `bot/models/configs` mints the per-account **model bearer token** and lists
 *   the account's models together with the OpenAI-compatible base URL of the
 *   backend that serves each one (`.../v2` for the MaaS gateway, `.../agent/v1`
 *   for the iFLYTEK Spark gateway). The desktop app calls this on every launch
 *   and copies the token into the bundled `acode` kernel's config, so calling
 *   it here reuses the same session rather than duplicating a login.
 * - `points/balance` and `membership/me` describe the plan and the point
 *   balance that AStudio bills inference against.
 *
 * The response envelope is `{flag, code, desc, data, traceId}`; a `flag: false`
 * body is a normal business error and is turned into a thrown error here so
 * callers never mistake an empty roster for "the account has no models".
 */

import { astronCookie, type AstronSession } from "./auth"

/** Production studio origin. */
export const DEFAULT_STUDIO_ORIGIN = "https://agent.xfyun.cn"
/** Overrides the studio origin (pre-production / delivery environments). */
export const ASTRON_STUDIO_ORIGIN_ENV = "ASTUDIO_STUDIO_ORIGIN"
/** Studio API path prefix on that origin. */
const STUDIO_PATH_PREFIX = "xingchen-studio"
/**
 * The studio API answers script clients with a generic failure when the
 * `User-Agent` is a bare HTTP-client default, so send the product name.
 */
const STUDIO_USER_AGENT = "AStudio"
/**
 * Cold discovery must answer inside omp's 15 s `fetchDynamicModels` budget.
 * These are single small GETs, so a short ceiling keeps a hung studio API from
 * stalling model discovery.
 */
const REQUEST_TIMEOUT_MS = 12_000

/** One roster entry, normalized out of the studio API's field naming. */
export interface AstronModelConfig {
  /** Studio-side model id (`lm_auto`), used only for logging. */
  id: string
  /** The id inference expects in the request body (`astronclaw-auto`). */
  slug: string
  /** Human name the desktop app shows (`Auto`, `GLM-5.2`). */
  name: string
  /** Backend family (`maas`, `iflytek`). */
  provider: string
  /** OpenAI-compatible base URL that serves this model. */
  baseUrl: string
  /** Bearer token for that base URL. Shared by every model on the account. */
  apiKey: string
  /** Points charged per token relative to the account's base rate (`x2.0`). */
  pointMultiplier?: number
  isDefault: boolean
  isCurrent: boolean
}

/** The result of the credential exchange. */
export interface AstronModelCatalog {
  models: AstronModelConfig[]
  /** Minted bearer token; identical for every model on the account. */
  apiKey: string
  fetchedAt: number
}

/** Plan/balance snapshot for diagnostics. */
export interface AstronAccountSnapshot {
  planName?: string
  planCode?: string
  autoRenew?: boolean
  balance?: number
  total?: number
  expiresAt?: string
}

export class AstronUpstreamError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "AstronUpstreamError"
  }
}

/** Raised when the studio session itself is rejected: the operator must sign in again. */
export class AstronSessionExpiredError extends AstronUpstreamError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "AstronSessionExpiredError"
  }
}

/** Absolute studio-API URL for `path`, honouring the origin override. */
function studioUrl(path: string): string {
  const override = process.env[ASTRON_STUDIO_ORIGIN_ENV]?.trim()
  const origin = override !== undefined && override !== "" ? override : DEFAULT_STUDIO_ORIGIN
  return `${origin.replace(/\/+$/u, "")}/${STUDIO_PATH_PREFIX}/${path.replace(/^\/+/u, "")}`
}

/** Type guard: the envelope and every row inside it are untyped JSON. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Non-empty trimmed string, or `undefined`. Absent and blank mean the same here. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

/** Number, or a numeric string; anything else (including `null`) is `undefined`. */
function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  const text = asString(value)
  if (text === undefined) return undefined
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * `point_multiplier` arrives either as `"x2.0"` (the studio API's own spelling)
 * or as a bare number, depending on which backend answered.
 */
function parseMultiplier(value: unknown): number | undefined {
  const direct = asNumber(value)
  if (direct !== undefined) return direct
  const text = asString(value)
  if (text === undefined) return undefined
  const match = /^x\s*([\d.]+)$/iu.exec(text)
  return match?.[1] === undefined ? undefined : asNumber(match[1])
}

function parseModelRow(value: unknown): AstronModelConfig | undefined {
  const row = asRecord(value)
  if (row === undefined) return undefined
  const slug = asString(row.model)
  const baseUrl = asString(row.base_url)
  const apiKey = asString(row.api_key)
  if (slug === undefined || baseUrl === undefined || apiKey === undefined) return undefined
  const multiplier = parseMultiplier(row.point_multiplier)
  return {
    id: asString(row.id) ?? slug,
    slug,
    name: asString(row.name) ?? slug,
    provider: asString(row.provider) ?? "unknown",
    baseUrl: baseUrl.replace(/\/+$/u, ""),
    apiKey,
    ...(multiplier === undefined ? {} : { pointMultiplier: multiplier }),
    isDefault: row.is_default === true,
    isCurrent: row.is_current === true,
  }
}

/** Narrow out the rows the studio API sends that carry no usable model. */
function isModelConfig(value: AstronModelConfig | undefined): value is AstronModelConfig {
  return value !== undefined
}

/**
 * Unwrap the studio envelope. `flag: false`, a non-zero `code` and a non-2xx
 * status all mean the call failed even though the transport succeeded. 401/403
 * raises the session-expired error the store turns into "sign in again".
 */
async function unwrap(response: Response, what: string): Promise<unknown> {
  if (response.status === 401 || response.status === 403) {
    throw new AstronSessionExpiredError(
      `${what}：AStudio 账号会话被拒绝（HTTP ${response.status}），请在 AStudio 桌面端重新登录`,
    )
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch (error: unknown) {
    throw new AstronUpstreamError(`${what}：返回的不是 JSON（HTTP ${response.status}）`, { cause: error })
  }
  const record = asRecord(payload)
  const failed = record !== undefined && (record.flag === false || (asNumber(record.code) ?? 0) !== 0)
  if (!response.ok || failed) {
    const detail = record === undefined ? undefined : (asString(record.message) ?? asString(record.desc))
    throw new AstronUpstreamError(
      `${what}：${detail ?? `HTTP ${response.status}`}${response.status === 200 ? "" : `（HTTP ${response.status}）`}`,
    )
  }
  return record?.data
}

async function getJson(path: string, cookie: string, what: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(studioUrl(path), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: cookie,
        "User-Agent": STUDIO_USER_AGENT,
      },
      signal: controller.signal,
    })
  } catch (error: unknown) {
    throw new AstronUpstreamError(
      `${what}：请求失败（${error instanceof Error ? error.message : String(error)}）`,
      { cause: error },
    )
  } finally {
    clearTimeout(timer)
  }
  return unwrap(response, what)
}

export class AstronUpstreamClient {
  /**
   * Mint the account's inference token and model roster.
   *
   * The desktop app calls this on every launch, so this is a re-read of a
   * cache the account already rebuilds, not a second login.
   */
  async fetchModelCatalog(session: AstronSession): Promise<AstronModelCatalog> {
    const data = await getJson("bot/models/configs", astronCookie(session), "拉取 AStudio 模型列表")
    const models = Array.isArray(data) ? data.map(parseModelRow).filter(isModelConfig) : []
    if (models.length === 0) {
      throw new AstronUpstreamError("拉取 AStudio 模型列表：响应里没有可用模型（账号可能没有可用套餐）")
    }
    // The desktop app prefers the selected model's key, then the default
    // model's, then the first. Every row carries the same key today, so this
    // only keeps that assumption from mattering later.
    const preferred = models.find((model) => model.isCurrent) ?? models.find((model) => model.isDefault) ?? models[0]
    if (preferred === undefined) throw new AstronUpstreamError("拉取 AStudio 模型列表：响应里没有 api_key")
    return { models, apiKey: preferred.apiKey, fetchedAt: Date.now() }
  }

  /** Plan and point balance, for status reporting. */
  async fetchAccount(session: AstronSession): Promise<AstronAccountSnapshot> {
    const cookie = astronCookie(session)
    const [balance, membership] = await Promise.all([
      getJson("points/balance", cookie, "查询 AStudio 积分"),
      getJson("membership/me", cookie, "查询 AStudio 套餐"),
    ])
    const balanceRecord = asRecord(balance)
    const membershipRecord = asRecord(membership)
    const remaining = balanceRecord === undefined ? undefined : asNumber(balanceRecord.totalBalance)
    const total = balanceRecord === undefined ? undefined : asNumber(balanceRecord.totalAmount)
    const expiresAt = balanceRecord === undefined ? undefined : asString(balanceRecord.activityNextExpireTime)
    return {
      ...(membershipRecord === undefined
        ? {}
        : {
            planName: asString(membershipRecord.planName),
            planCode: asString(membershipRecord.planCode),
            ...(membershipRecord.autoRenew === true ? { autoRenew: true } : {}),
          }),
      ...(remaining === undefined ? {} : { balance: remaining }),
      ...(total === undefined ? {} : { total }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    }
  }
}
