/**
 * magpie-loomy-connect — Loomy as a magpie provider.
 *
 * Loomy has no inference API key: it signs in to the iFLYTEK account service
 * and keeps the resulting **account session token** in a plain `electron-store`
 * file, and that same token is what every model request carries. This plugin
 * reads that store (never writes it) inside magpie's plugin host, so the
 * account works in magpie with no second sign-in and no API key — and without
 * needing the desktop app to be open.
 *
 * The model surface is OpenAI chat completions, and the catalogue is
 * server-controlled, so nothing about the models is hard-coded here beyond the
 * fallback the picker shows before the account can be read.
 *
 * Two Loomy-specific details are handled in the loader rather than leaked to
 * magpie:
 *
 * - the session is sent as **both** `token` and `Authorization: Bearer`,
 *   because the platform's surfaces disagree on which they read, and
 * - every request carries a fresh **`traceparent`**. Without one
 *   `chat/completions` hangs until the client times out — the desktop app's own
 *   source records exactly that.
 *
 * The state root is not the usual Electron one: on Windows Loomy redirects its
 * own state to `C:\Users\Public\Loomy\<sha256(用户名)前 12 位>\`.
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { join } from "node:path"

/** Provider id agents use as `<id>/<model>`. */
export const PROVIDER = "loomy"
/** The transport the platform speaks. */
const NPM = "@ai-sdk/openai-compatible"
/** Production inference base. */
const DEFAULT_API_BASE = "https://loomyad.xunfei.cn/api/v1"
/** Points/account service, where the balance lives. */
const DEFAULT_POINTS_BASE = "https://ossptest.voicecloud.cn/loomy/integration"
/** Product version the platform expects in the version header. */
const PRODUCT_VERSION = "1.3.0"

/** Points at Loomy's config root. */
const CONFIG_ROOT_ENV = "LOOMY_CONFIG_ROOT"
/** Supplies the account session without the desktop app. */
const SESSION_ENV = "LOOMY_SESSION"
/** Overrides the inference base outright. */
const API_BASE_ENV = "LOOMY_API_BASE"
/** Overrides the points service base. */
const POINTS_BASE_ENV = "LOOMY_POINTS_BASE"

/** The store's file name inside `<root>/userData`. */
const SESSION_STORE = "auth-session.json"
const APP_NAME = "Loomy"

/** Conservative limits for a catalogue row that omits its own. */
const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_OUTPUT = 32_768

/**
 * The platform's daily free allowance, in points.
 *
 * Loomy grants every account a fresh daily pool and keeps a separate long-term
 * pool (earned from tasks, or topped up by a reset). The daily total is not
 * published anywhere, so this constant is the fallback for the one moment it
 * cannot be recovered from the ledger — it is a platform number, not a guess
 * at the account's balance.
 */
const DAILY_ALLOWANCE = 5_000

interface Credential {
  session: string
  userid?: string
  phone?: string
}

/** The stored auth magpie keeps: a desktop sign-in owns no token of its own. */
interface StoredAuth {
  type?: string
  source?: string
  accountId?: string
}

/** One catalogue row, normalized out of Loomy's richer shape. */
interface CatalogueModel {
  id: string
  name: string
  contextLength?: number
  maxOutputTokens?: number
  reasoningEfforts: string[]
  defaultReasoningEffort?: string
  reasoning: boolean
  vision: boolean
  functionCalling: boolean
  inputModalities: string[]
  /** Points multiplier parsed off the display name (`x2.0`), when present. */
  rate?: number
  isDefault: boolean
  isDefaultSmall: boolean
}

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

/** Parse JSON without throwing; `undefined` for anything that is not JSON. */
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// -- the desktop's sign-in -----------------------------------------------------

/**
 * `C:\Users\Public\Loomy\<hash>` — Loomy's own rule, reproduced: the first 12
 * hex characters of the SHA-256 of the operating-system user name.
 */
function windowsConfigRoot(): string {
  let name: string
  try {
    name = userInfo().username
  } catch {
    name = process.env.USERNAME ?? ""
  }
  return join("C:", "Users", "Public", "Loomy", createHash("sha256").update(name).digest("hex").slice(0, 12))
}

/** Candidate config roots, most specific first. */
function configRoots(): string[] {
  const override = asText(process.env[CONFIG_ROOT_ENV])
  if (override !== undefined) return [override]
  if (process.platform === "win32") return [windowsConfigRoot()]
  if (process.platform === "darwin") return [join(homedir(), "Library", "Application Support", APP_NAME)]
  return [join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), APP_NAME)]
}

/**
 * The account session the desktop app is signed in with.
 *
 * There is no exchange and nothing expires quickly: the token is used as-is,
 * so it is simply re-read on every use — a sign-out in the app is picked up
 * here without a re-login.
 */
function readDesktopCredential(): { credential: Credential; source: string } | { error: string } {
  const override = asText(process.env[SESSION_ENV])
  if (override !== undefined) return { credential: { session: override }, source: `env:${SESSION_ENV}` }
  const roots = configRoots()
  let sawStore = false
  for (const root of roots) {
    const path = join(root, "userData", SESSION_STORE)
    if (!existsSync(path)) continue
    sawStore = true
    const record = asRecord(safeParse(readFileSync(path, "utf8")))
    const session = record === undefined ? undefined : asText(record.session)
    if (session === undefined) continue
    return {
      credential: {
        session,
        userid: asText(record?.userid),
        phone: asText(record?.phone),
      },
      source: path,
    }
  }
  if (!sawStore) {
    return { error: `Loomy desktop isn't installed where expected (${roots.join(", ")}; ${CONFIG_ROOT_ENV} can point at it)` }
  }
  return { error: "Loomy desktop isn't signed in" }
}

/** The credential the hooks work from, or a thrown reason there is none. */
function currentOrThrow(auth: StoredAuth): { credential: Credential; source: string } {
  if (auth.source !== "desktop") throw new Error("Loomy isn't signed in")
  const read = readDesktopCredential()
  if ("error" in read) throw new Error(read.error)
  return read
}

// -- the platform --------------------------------------------------------------

/** The inference base: the override, then the app's own deployed config, then production. */
function liveApiBase(): string {
  const override = asText(process.env[API_BASE_ENV])
  if (override !== undefined) return override.replace(/\/+$/u, "")
  for (const root of configRoots()) {
    const config = asRecord(safeParse(safeRead(join(root, "opencode", "opencode.json"))))
    const providers = asRecord(config?.provider)
    for (const provider of Object.values(providers ?? {})) {
      const options = asRecord(asRecord(provider)?.options)
      const baseUrl = asText(options?.baseURL)
      if (baseUrl !== undefined) return baseUrl.replace(/\/+$/u, "")
    }
  }
  return DEFAULT_API_BASE
}

/**
 * The points service.
 *
 * The inference origin wins over the stored `points-config.json`: those are two
 * independent settings, and a machine can hold a points base for a *different*
 * environment than the session it is signed in with (the stored one here points
 * at the integration environment, whose service rejects the production
 * session). Points live on the same host as inference in practice, so that is
 * the trustworthy default.
 */
function livePointsBase(): string {
  const override = asText(process.env[POINTS_BASE_ENV])
  if (override !== undefined) return override.replace(/\/+$/u, "")
  try {
    return new URL(liveApiBase()).origin
  } catch {
    // A malformed base falls through to the stored setting.
  }
  for (const root of configRoots()) {
    const config = asRecord(safeParse(safeRead(join(root, "userData", "points-config.json"))))
    const baseUrl = asText(config?.baseUrl)
    if (baseUrl !== undefined) return baseUrl.replace(/\/+$/u, "")
  }
  return DEFAULT_POINTS_BASE
}

function safeRead(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : ""
  } catch {
    return ""
  }
}

/**
 * The headers every Loomy call carries. The session goes out under both names,
 * and the trace context is minted fresh so two requests never share a span.
 */
function authHeaders(credential: Credential): Record<string, string> {
  return {
    Accept: "application/json",
    token: credential.session,
    Authorization: `Bearer ${credential.session}`,
    "loomy-version": PRODUCT_VERSION,
    traceparent: `00-${randomHex(16)}-${randomHex(8)}-01`,
    InvokeOrigin: "loomy-desktop",
    "X-Loomy-Source": "desktop",
  }
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes)
  crypto.getRandomValues(values)
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("")
}

/**
 * The account's point buckets, and how much of today's has been spent.
 *
 * The platform publishes no total for the daily bucket, but it does not need
 * one: records are newest-first and carry the cycle date, so the bucket's
 * starting grant is what is left plus what was spent out of it today —
 * `dailyBalance + consumedToday`. Coverage of *today* is what makes that
 * honest, so `consumed` stays undefined unless every record of the newest
 * cycle was read (a short page, or the first record of an older cycle, ends
 * the walk).
 */
interface PointsSnapshot {
  /** The long-term pool as it stands. */
  balance?: number
  /** Today's pool as it stands. */
  dailyBalance?: number
  /** The two pools together: what a request may spend. */
  available?: number
  /** Net points taken out of today's pool (credits count negative). */
  consumed?: number
  /** What today's pool started with; derived, not published. */
  grant?: number
  /** Net points ever taken out of the long-term pool. */
  longSpent?: number
  /**
   * Everything ever credited into the long-term pool: what is left plus what
   * was spent out of it. Only set when the whole ledger was read, because a
   * partial read would put a wrong denominator under the bar.
   */
  longEarned?: number
  cycleDate?: string
}

const LEDGER_PAGE_SIZE = 100
/** How many ledger pages the walk may span before it gives up. */
const LEDGER_MAX_PAGES = 10

/**
 * Read the account's two point pools and what has been spent from each.
 *
 * The platform publishes no total for either pool, but the ledger supplies
 * both. Records are newest-first and carry their cycle date, so today's pool
 * started at `dailyBalance + consumedToday`; the long-term pool has held
 * `balance + spentFromIt` since it began. Coverage is what keeps that honest:
 * today's pool needs every record of the newest cycle, and the long-term pool
 * needs the whole ledger, so each is derived only from rows actually read.
 */
async function pointsSnapshot(credential: Credential): Promise<PointsSnapshot> {
  const rows: Record<string, unknown>[] = []
  const snapshot: PointsSnapshot = {}
  let total: number | undefined
  let covered = false
  for (let pageNo = 1; pageNo <= LEDGER_MAX_PAGES; pageNo++) {
    const payload = await requestJson(
      `${livePointsBase()}/api/v1/points/records?pageNo=${pageNo}&pageSize=${LEDGER_PAGE_SIZE}&recordType=all`,
      credential,
      "points balance",
    )
    const outer = asRecord(payload)
    const code = asText(outer?.code)
    if (code !== undefined && code !== "000000") {
      throw new Error(asText(outer?.desc) ?? `Loomy answered ${code}`)
    }
    const data = asRecord(outer?.data)
    if (data === undefined) break
    if (pageNo === 1) {
      snapshot.balance = asNumber(data.balance)
      snapshot.dailyBalance = asNumber(data.dailyBalance)
      snapshot.available = asNumber(data.availableBalance)
    }
    const list = Array.isArray(data.list) ? data.list : []
    total = asNumber(data.total) ?? total
    for (const entry of list) {
      const row = asRecord(entry)
      if (row !== undefined) rows.push(row)
    }
    if (rows.length === 0) {
      covered = true
      break
    }
    snapshot.cycleDate ??= asText(rows[0]?.dailyCycleDate)
    // Rows are newest-first, so a short page, the end of the ledger, or a row
    // from an older cycle all mean the newest cycle is fully in hand.
    if (list.length < LEDGER_PAGE_SIZE || (total !== undefined && rows.length >= total)) {
      covered = true
      break
    }
    const lastCycle = asText(rows[rows.length - 1]?.dailyCycleDate)
    if (lastCycle !== undefined && lastCycle !== snapshot.cycleDate) {
      covered = true
      break
    }
  }
  // Long-term pool: what it holds plus everything spent out of it. Non-daily
  // spends are the only debits that touch it — the daily pool is drained first.
  let longSpent = 0
  for (const row of rows) {
    if (asText(row.consumeSource) === "daily") continue
    if (asText(row.direction) !== "debit") continue
    longSpent += asNumber(row.pointsActual) ?? 0
  }
  snapshot.longSpent = longSpent
  if (total !== undefined && rows.length >= total && snapshot.balance !== undefined) {
    snapshot.longEarned = snapshot.balance + longSpent
  }
  const cycle = snapshot.cycleDate
  if (!covered || cycle === undefined) return snapshot
  let consumed = 0
  for (const row of rows) {
    if (asText(row.dailyCycleDate) !== cycle) continue
    // Only today's pool is measured here; the long-term one is separate.
    if (asText(row.consumeSource) !== "daily") continue
    const points = asNumber(row.pointsActual) ?? 0
    consumed += asText(row.direction) === "credit" ? -points : points
  }
  snapshot.consumed = consumed
  if (snapshot.dailyBalance !== undefined && consumed >= 0) {
    snapshot.grant = snapshot.dailyBalance + consumed
  }
  return snapshot
}

/**
 * When the daily pool refills: the next local midnight after the cycle date
 * the ledger reports. The platform states the cycle as a calendar date, which
 * is the only boundary it ever names.
 */
function nextCycleStart(cycleDate: string | undefined): string | undefined {
  const match = cycleDate === undefined ? null : /^(\d{4})-(\d{2})-(\d{2})$/u.exec(cycleDate)
  if (match === null) return undefined
  const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (Number.isNaN(start.getTime())) return undefined
  start.setDate(start.getDate() + 1)
  return start.toISOString()
}

/**
 * The points multiplier is published **inside the display name** — `DeepSeek
 * V4.1 Flash(x2.0)`, `qwen 3.8 flash（x0.8）` — in both ASCII and full-width
 * brackets, so both are matched.
 */
function parseRate(name: string): { name: string; rate?: number } {
  const match = /[(（]\s*x\s*([\d.]+)\s*[)）]\s*$/u.exec(name)
  if (match?.[1] === undefined) return { name }
  const rate = asNumber(match[1])
  const base = name.slice(0, match.index).trim()
  return { name: base === "" ? name : base, ...(rate === undefined ? {} : { rate }) }
}

function parseModelRow(value: unknown): CatalogueModel | undefined {
  const row = asRecord(value)
  const id = row === undefined ? undefined : asText(row.id)
  if (row === undefined || id === undefined) return undefined
  // Image models share the protocol but are not a chat provider; only the
  // platform's own `type` tells them apart.
  if ((asText(row.type) ?? "chat") !== "chat") return undefined
  const named = parseRate(asText(row.name) ?? id)
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
    contextLength: asNumber(row.context_length),
    maxOutputTokens: asNumber(row.max_output_tokens) ?? asNumber(row.max_completion_tokens),
    reasoningEfforts: efforts,
    defaultReasoningEffort: asText(row.default_reasoning_effort),
    reasoning: capabilities.reasoning === true || efforts.length > 0,
    vision: capabilities.vision === true || modalities.includes("image"),
    functionCalling: capabilities.function_calling === true,
    inputModalities: modalities,
    ...(named.rate === undefined ? {} : { rate: named.rate }),
    isDefault: row.is_default_model === true,
    isDefaultSmall: row.is_default_small_model === true,
  }
}

async function requestJson(
  url: string,
  credential: Credential,
  what: string,
): Promise<unknown> {
  const response = await fetch(url, { headers: authHeaders(credential) })
  if (response.status === 401 || response.status === 403) {
    throw new Error("The Loomy platform refused the sign-in; sign in on the desktop app again")
  }
  const payload: unknown = await response.json().catch(() => undefined)
  if (!response.ok) throw new Error(`${what}: Loomy answered ${response.status}`)
  return payload
}

// -- the catalogue -------------------------------------------------------------

/**
 * The catalogue fetched once per process. It is server-controlled and changes
 * rarely, and magpie asks for it per account, so one small GET is cached.
 */
let catalogue: Promise<CatalogueModel[]> | undefined

function catalogueFor(credential: Credential): Promise<CatalogueModel[]> {
  catalogue ??= (async () => {
    const payload = await requestJson(`${liveApiBase()}/models`, credential, "model list")
    const rows = asRecord(payload)?.data
    const models = (Array.isArray(rows) ? rows : []).map(parseModelRow).filter(isCatalogueModel)
    if (models.length === 0) throw new Error("Loomy answered no usable chat models")
    return models
  })()
  catalogue.catch(() => {
    catalogue = undefined
  })
  return catalogue
}

/** Narrow out rows the platform sends without a usable id. */
function isCatalogueModel(value: CatalogueModel | undefined): value is CatalogueModel {
  return value !== undefined
}

/** Variants are how OpenCode hands reasoning levels to the AI SDK. */
function variants(efforts: string[]): Record<string, { reasoningEffort: string }> {
  return Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }]))
}

/** The levels a model advertises, ignoring the "off" entry OpenCode has no slot for. */
function reasoningLevels(model: CatalogueModel): string[] {
  const usable = model.reasoningEfforts.filter((effort) => effort !== "none")
  return usable.length > 0 ? usable : ["low", "medium", "high"]
}

/** The model shape the `config` hook declares, used before the account is read. */
function configModels(): Record<string, unknown> {
  return Object.fromEntries(
    FALLBACK_MODELS.map((spec) => [
      spec.id,
      {
        name: spec.name,
        limit: { context: DEFAULT_CONTEXT_WINDOW, output: DEFAULT_OUTPUT },
        tool_call: true,
        reasoning: true,
        variants: variants(["low", "medium", "high", "xhigh"]),
      },
    ]),
  )
}

/** One catalogue row as an OpenCode model. */
function modelOf(providerId: string, model: CatalogueModel): Record<string, unknown> {
  const images = model.vision
  return {
    id: model.id,
    providerID: providerId,
    name: model.name,
    api: { id: model.id, url: liveApiBase(), npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: {
      context: model.contextLength ?? DEFAULT_CONTEXT_WINDOW,
      output: model.maxOutputTokens ?? DEFAULT_OUTPUT,
    },
    capabilities: {
      temperature: true,
      reasoning: model.reasoning,
      attachment: images,
      toolcall: model.functionCalling,
      input: { text: true, image: images, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: variants(reasoningLevels(model)),
    // magpie's own: what a request costs, as a multiple. The platform prints it
    // in the display name ("DeepSeek V4.1 Flash(x2.0)"); `x0.0` is free.
    free: model.rate === 0,
    rate: model.rate ?? 0,
  }
}

/** The picker's list before the account can be read. */
const FALLBACK_MODELS: { id: string; name: string }[] = [
  { id: "DeepSeek-V4.1-Flash", name: "DeepSeek V4.1 Flash" },
  { id: "deepseek-v4-flash-0731", name: "DeepSeek V4 Flash 0731" },
  { id: "MiniMax-M3", name: "MiniMax M3" },
  { id: "Kimi-k2.6", name: "Kimi k2.6" },
  { id: "qwen-3.8-max", name: "Qwen 3.8 Max" },
  { id: "GLM-5.3-Flash", name: "GLM 5.3 Flash" },
  { id: "qwen3.8-flash", name: "qwen 3.8 flash" },
  { id: "spark-x", name: "Spark-X2.5" },
  { id: "mimo-v2.5", name: "MiMo V2.5" },
  { id: "auto", name: "自动 · 均衡" },
]

// -- the plugin ----------------------------------------------------------------

/**
 * The provider plugin. This module must not export another function, or magpie
 * would call it as a second plugin.
 */
export const LoomyAuthPlugin = async () => ({
  config: async (config: Record<string, unknown>) => {
    const providers = (config.provider ??= {}) as Record<string, Record<string, unknown>>
    const provider = (providers[PROVIDER] ??= {})
    provider.name ??= "Loomy"
    provider.npm ??= NPM
    provider.api ??= DEFAULT_API_BASE
    // The account's own catalogue replaces this as soon as it can be read; the
    // merge keeps whatever the user configured by hand.
    provider.models = { ...configModels(), ...(asRecord(provider.models) ?? {}) }
  },
  provider: {
    id: PROVIDER,
    /**
     * The account's own models, when the platform answers; the declared list
     * otherwise — magpie keeps its own list when a hook returns nothing.
     */
    async models(provider: Record<string, unknown>, input?: { auth?: StoredAuth }) {
      const declared = (provider.models ?? {}) as Record<string, unknown>
      const auth = input?.auth
      if (auth?.source !== "desktop") return declared
      try {
        const { credential } = currentOrThrow(auth)
        const models = await catalogueFor(credential)
        return Object.fromEntries(models.map((model) => [model.id, modelOf(PROVIDER, model)]))
      } catch {
        return declared
      }
    },
  },
  auth: {
    provider: PROVIDER,
    methods: [
      {
        type: "oauth",
        label: "Loomy desktop's sign-in",
        /**
         * Uses the account the desktop app is signed in to. Nothing is copied:
         * the store is re-read on every use, so a sign-out there is picked up
         * here without a re-login.
         */
        authorize: () => ({
          url: "",
          instructions: "Uses the account the Loomy desktop app is signed in to.",
          method: "auto",
          async callback() {
            const read = readDesktopCredential()
            if ("error" in read) return { type: "failed", error: read.error }
            const name = read.credential.phone ?? read.credential.userid ?? PROVIDER
            return {
              type: "success",
              // magpie stores an OAuth result by its token fields, so they are
              // present and empty: this sign-in owns no token of its own, and
              // `source` is what the hooks below read to find the real one.
              refresh: "",
              access: "",
              expires: 0,
              source: "desktop",
              accountId: name,
            }
          },
        }),
      },
    ],
    async loader(getAuth: () => Promise<StoredAuth | undefined>) {
      const initial = await getAuth()
      if (initial?.source !== "desktop") return {}
      return {
        async fetch(input: Request | URL | string, init?: RequestInit): Promise<Response> {
          // The token is the desktop app's, so it is re-read per request: the
          // app owns it and can drop it between two calls.
          const auth = await getAuth()
          if (auth?.source !== "desktop") throw new Error("Loomy isn't signed in")
          const { credential } = currentOrThrow(auth)

          const request = input instanceof Request ? input : undefined
          const headers = new Headers(init?.headers ?? request?.headers)
          // The platform's own headers replace whatever the transport built —
          // notably the trace context, which must be minted per request.
          for (const [name, value] of Object.entries(authHeaders(credential))) headers.set(name, value)
          headers.set("content-type", "application/json")

          return fetch(request?.url ?? String(input), {
            ...init,
            method: init?.method ?? request?.method ?? "POST",
            headers,
          })
        },
      }
    },
    async usage(getAuth: () => Promise<StoredAuth | undefined>) {
      const auth = await getAuth()
      if (auth?.source !== "desktop") return { error: "not signed in", signIn: "kept" }
      try {
        const { credential } = currentOrThrow(auth)
        // `/api/v1/points/records` is the only balance a personal account has:
        // `team-points/balance` answers "not switched to a team" for it, and
        // this envelope carries both buckets — the long-term one (`balance`)
        // Neither pool publishes a total, so both denominators come from the
        // ledger: today's pool started at what is left plus what was spent out
        // of it today, and the long-term pool has held what is left plus what
        // was spent out of it since it began. The daily one falls back to the
        // platform's allowance when today's rows could not all be read; the
        // long-term one is simply left out unless the whole ledger was read,
        // because a partial read would put a wrong denominator under its bar.
        const points = await pointsSnapshot(credential)
        const spendable = points.dailyBalance
        const consumed = points.consumed ?? (spendable === undefined ? undefined : DAILY_ALLOWANCE - spendable)
        const grant = points.grant ?? DAILY_ALLOWANCE
        const resetsAt = nextCycleStart(points.cycleDate)
        const windows = [
          ...(spendable === undefined || consumed === undefined || grant <= 0
            ? []
            : [
                {
                  name: "每日积分",
                  used: (consumed / grant) * 100,
                  display: `${spendable} / ${grant} 分`,
                  ...(resetsAt === undefined ? {} : { resetsAt }),
                  span: 86_400,
                },
              ]),
          ...(points.longEarned === undefined || points.longSpent === undefined || points.longEarned <= 0
            ? []
            : [
                {
                  name: "长期积分",
                  used: (points.longSpent / points.longEarned) * 100,
                  display: `${points.balance} / ${points.longEarned} 分`,
                },
              ]),
        ]
        return {
          plan: "Loomy",
          balance: points.available === undefined ? undefined : `${points.available} 分`,
          windows,
          // Reading the balance says nothing about the sign-in, so the account
          // keeps whatever state it had.
          signIn: "kept",
        }
      } catch (error: unknown) {
        return { error: error instanceof Error ? error.message : String(error), signIn: "kept" }
      }
    },
  },
})

/** Exported for tests only; magpie calls the module's plugin function. */
export const _internal = {
  configRoots,
  readDesktopCredential,
  catalogueFor,
  parseModelRow,
  parseRate,
  modelOf,
  liveApiBase,
  livePointsBase,
}
