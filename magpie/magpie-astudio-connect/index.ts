/**
 * magpie-astudio-connect — AStudio (iFLYTEK "AstronClaw") as a magpie provider.
 *
 * AStudio's desktop app never keeps an inference key on disk. It keeps the
 * *account* session it obtained at sign-in (`userdata/astron-session.json` in
 * the data root the installer recorded under `HKCU\Software\AStudioStorage`),
 * and every launch exchanges that session for a model bearer token plus the
 * account's model roster. This plugin performs the same exchange, inside
 * magpie's own plugin host, so the account works in magpie with no second
 * sign-in and no dependency on omp (or on the desktop app being open).
 *
 * Nothing is copied out of the desktop app: the session file is read (never
 * written) on each use, exactly as the app keeps it, and the minted token
 * lives in memory only.
 *
 * Protocol facts this plugin is built on, all measured against a live account:
 *
 * - `GET {studio}/xingchen-studio/bot/models/configs` with the account cookie
 *   answers the per-account roster: each entry carries its own `base_url`,
 *   `api_key` (shared by the account) and `point_multiplier`.
 * - Inference is plain OpenAI chat completions at `{base_url}/chat/completions`
 *   with `Authorization: Bearer <api_key>`; SSE deltas, tool calls and the
 *   `reasoning_content` field all behave as usual.
 * - The thinking switch is Qwen-style `enable_thinking`, **not**
 *   `reasoning_effort`: GLM / DeepSeek / Kimi / MiniMax answer with no
 *   reasoning at all when only `reasoning_effort` is sent, so the loader adds
 *   the switch whenever an effort was asked for.
 * - The model id must be the exact wire id; display names and studio ids are
 *   answered with `400 {"code":10404,"message":"no category route found"}`.
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/** Provider id agents use as `<id>/<model>`. */
export const PROVIDER = "astudio"
/** The OpenAI-compatible transport every backend speaks. */
const NPM = "@ai-sdk/openai-compatible"
/** MaaS gateway: serves Auto, Spark-Agent, GLM, DeepSeek, Kimi, Qwen, MiniMax. */
const MAAS_BASE = "https://maas-api.cn-huabei-1.xf-yun.com/v2"
/** iFLYTEK's open Spark gateway: serves the legacy `spark-x` id. */
const SPARK_BASE = "https://spark-api-open.xf-yun.com/agent/v1"
/** Studio origin that mints the token and answers the roster. */
const STUDIO_ORIGIN = "https://agent.xfyun.cn"
const STUDIO_PREFIX = "xingchen-studio"
/** The studio API answers bare HTTP clients with a generic failure. */
const USER_AGENT = "AStudio"
/**
 * Conservative input ceiling: no endpoint publishes context windows, and
 * over-reporting makes magpie build a prompt the gateway rejects while
 * under-reporting only compacts earlier.
 */
const CONTEXT_WINDOW = 200_000
/** Fallback output budget for models whose bound could not be measured. */
const DEFAULT_OUTPUT = 32_768

/** Data root override, for installs the registry does not describe. */
const DATA_ROOT_ENV = "ASTUDIO_DATA_ROOT"
/** Supplies the SSO session id without the desktop app. */
const SSO_ENV = "ASTUDIO_SSO_SESSION_ID"
/** Supplies the account token alongside the session id. */
const TOKEN_ENV = "ASTUDIO_ACCOUNT_TOKEN"
/** Overrides the studio origin (pre-production / delivery environments). */
const ORIGIN_ENV = "ASTUDIO_STUDIO_ORIGIN"

const STORAGE_KEY = String.raw`HKCU\Software\AStudioStorage`
const SESSION_PATHS = [
  ["userdata", "astron-session.json"],
  ["dev", "astron-session.json"],
] as const

/** Reasoning levels the account offers: "off" and "high", plus "max" on some. */
const DEFAULT_EFFORTS = ["none", "high"]
const EXTENDED_EFFORTS = ["none", "high", "max"]

interface ModelSpec {
  slug: string
  name: string
  /** Backend family: picks the gateway when a roster row is unavailable. */
  family: "maas" | "iflytek"
  /** Measured `max_tokens` bound, or `DEFAULT_OUTPUT` when unmetered. */
  output: number
  efforts: string[]
  images?: boolean
}

/**
 * The roster a fresh account sees, captured from a live one. The account's own
 * list always wins; this fills the picker before the first exchange, and adds
 * the ids the account roster omits but the gateways still serve.
 */
const FALLBACK_MODELS: ModelSpec[] = [
  { slug: "astronclaw-auto", name: "Auto", family: "maas", output: 393_216, efforts: DEFAULT_EFFORTS, images: true },
  { slug: "xsparkx2agent", name: "Spark-X2-Agent", family: "maas", output: DEFAULT_OUTPUT, efforts: DEFAULT_EFFORTS },
  { slug: "spark-x", name: "Spark-X2-Flash", family: "iflytek", output: DEFAULT_OUTPUT, efforts: DEFAULT_EFFORTS },
  { slug: "spark-x2.5", name: "Spark-X2.5", family: "maas", output: DEFAULT_OUTPUT, efforts: DEFAULT_EFFORTS },
  { slug: "spark-x2.6-preview", name: "Spark-X2.6-Preview", family: "maas", output: DEFAULT_OUTPUT, efforts: DEFAULT_EFFORTS },
  { slug: "xopglm52", name: "GLM-5.2", family: "maas", output: 131_072, efforts: EXTENDED_EFFORTS },
  { slug: "xopglm51", name: "GLM-5.1", family: "maas", output: 131_072, efforts: DEFAULT_EFFORTS },
  { slug: "xminimaxm25", name: "MiniMax-M2.5", family: "maas", output: 131_072, efforts: DEFAULT_EFFORTS },
  { slug: "xopkimik26", name: "Kimi-K2.6", family: "maas", output: 131_072, efforts: DEFAULT_EFFORTS },
  { slug: "xopqwen36v35b", name: "Qwen3.6-35B-A3B", family: "maas", output: 131_072, efforts: DEFAULT_EFFORTS },
  { slug: "xopdeepseekv4pro", name: "DeepSeek-V4-Pro", family: "maas", output: 393_216, efforts: DEFAULT_EFFORTS },
  { slug: "xopdeepseekv4pro0813", name: "DeepSeek-V4-Pro", family: "maas", output: 393_216, efforts: EXTENDED_EFFORTS },
  { slug: "xopdsv4flash0731in", name: "DeepSeek-V4-Flash", family: "maas", output: DEFAULT_OUTPUT, efforts: EXTENDED_EFFORTS },
]

/** One roster row, normalized out of the studio API's field naming. */
interface RosterModel {
  /** Studio-side id (`lm_glm52`), used for alias matching. */
  id: string
  /** Wire id the request body must carry. */
  slug: string
  /** Name the desktop app shows. */
  name: string
  baseUrl: string
  apiKey: string
  pointMultiplier?: number
  isDefault: boolean
  isCurrent: boolean
}

/** The minted token plus the roster it belongs to. */
interface Catalog {
  models: RosterModel[]
  apiKey: string
}

interface DesktopSession {
  ssoSessionId: string
  accountId?: string
  token?: string
  uid?: string
  nickname?: string
}

/** The auth magpie stores for this provider: a desktop sign-in owns no token. */
interface StoredAuth {
  type?: string
  source?: string
  accountId?: string
  uid?: string
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

/** `point_multiplier` arrives as `"x2.0"` (the studio spelling) or a number. */
function asMultiplier(value: unknown): number | undefined {
  const direct = asNumber(value)
  if (direct !== undefined) return direct
  const text = asText(value)
  if (text === undefined) return undefined
  const match = /^x\s*([\d.]+)$/iu.exec(text)
  return match?.[1] === undefined ? undefined : asNumber(match[1])
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
 * Where AStudio keeps its state, from the installer's own record.
 *
 * Cached for the process: this costs a `reg.exe` spawn, and the answer changes
 * only when the app is reinstalled.
 */
let cachedRoots: string[] | undefined

function dataRoots(): string[] {
  if (cachedRoots !== undefined) return cachedRoots
  const override = asText(process.env[DATA_ROOT_ENV])
  if (override !== undefined) {
    cachedRoots = [override]
    return cachedRoots
  }
  const roots: string[] = []
  try {
    const output = execFileSync(
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe"),
      ["query", STORAGE_KEY],
      { encoding: "utf8", timeout: 5_000, windowsHide: true },
    )
    for (const line of output.split(/\r?\n/u)) {
      const value = /^\s+(\S+)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*?)\s*$/iu.exec(line)
      if (value === null) continue
      const name = value[1] ?? ""
      const path = asText(value[2])
      if (path !== undefined && name.endsWith("DataRoot")) roots.push(path)
    }
  } catch {
    // No registry entry (or not Windows): the environment override is the way in.
  }
  cachedRoots = roots
  return roots
}

/** The account session the desktop app is signed in with, or a reason there is none. */
function readDesktopSession(): { session: DesktopSession; source: string } | { error: string } {
  const sso = asText(process.env[SSO_ENV])
  if (sso !== undefined) {
    const token = asText(process.env[TOKEN_ENV])
    return {
      session: { ssoSessionId: sso, ...(token === undefined ? {} : { token }) },
      source: `env:${SSO_ENV}`,
    }
  }
  const roots = dataRoots()
  for (const root of roots) {
    for (const relative of SESSION_PATHS) {
      const path = join(root, ...relative)
      if (!existsSync(path)) continue
      const parsed = asRecord(safeParse(readFileSync(path, "utf8")))
      const ssoSessionId = parsed === undefined ? undefined : asText(parsed.ssoSessionId)
      if (ssoSessionId === undefined) continue
      if (parsed?.banned === true) return { error: `The AStudio account is banned (${path})` }
      return {
        session: {
          ssoSessionId,
          accountId: asText(parsed?.accountId),
          token: asText(parsed?.token),
          uid: asText(parsed?.uid),
          nickname: asText(parsed?.nickname),
        },
        source: path,
      }
    }
  }
  return {
    error:
      `AStudio desktop isn't signed in. Sign in there, or set ${SSO_ENV}` +
      (roots.length === 0 ? ` (${DATA_ROOT_ENV} can point at its data folder)` : ""),
  }
}

/** The account cookie every studio call uses; the app sends all four fields. */
function astronCookie(session: DesktopSession): string {
  return [
    `ssoSessionId=${session.ssoSessionId}`,
    `sso_sessionid=${session.ssoSessionId}`,
    session.accountId === undefined ? undefined : `account_id=${session.accountId}`,
    session.token === undefined ? undefined : `token=${session.token}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join("; ")
}

function studioUrl(path: string): string {
  const origin = asText(process.env[ORIGIN_ENV]) ?? STUDIO_ORIGIN
  return `${origin.replace(/\/+$/u, "")}/${STUDIO_PREFIX}/${path}`
}

/**
 * The studio envelope is `{flag, code, desc, data}`; `flag: false` and a
 * non-zero `code` both mean the call failed even though the transport worked.
 */
async function studioGet(path: string, cookie: string): Promise<unknown> {
  const response = await fetch(studioUrl(path), {
    headers: { Accept: "application/json", Cookie: cookie, "User-Agent": USER_AGENT },
  })
  if (response.status === 401 || response.status === 403) {
    throw new Error("AStudio refused the account session; sign in on the desktop app again")
  }
  const payload: unknown = await response.json().catch(() => undefined)
  const record = asRecord(payload)
  const failed = record !== undefined && (record.flag === false || (asNumber(record.code) ?? 0) !== 0)
  if (!response.ok || failed) {
    const detail = record === undefined ? undefined : (asText(record.message) ?? asText(record.desc))
    throw new Error(`AStudio answered ${response.status}${detail === undefined ? "" : `: ${detail}`}`)
  }
  return record?.data
}

function parseRosterRow(value: unknown): RosterModel | undefined {
  const row = asRecord(value)
  const slug = row === undefined ? undefined : asText(row.model)
  const baseUrl = row === undefined ? undefined : asText(row.base_url)
  const apiKey = row === undefined ? undefined : asText(row.api_key)
  if (row === undefined || slug === undefined || baseUrl === undefined || apiKey === undefined) return undefined
  const multiplier = asMultiplier(row.point_multiplier)
  return {
    id: asText(row.id) ?? slug,
    slug,
    name: asText(row.name) ?? slug,
    baseUrl: baseUrl.replace(/\/+$/u, ""),
    apiKey,
    ...(multiplier === undefined ? {} : { pointMultiplier: multiplier }),
    isDefault: row.is_default === true,
    isCurrent: row.is_current === true,
  }
}

/** Narrow out roster rows the studio API sends without a usable model. */
function isRosterModel(value: RosterModel | undefined): value is RosterModel {
  return value !== undefined
}

/**
 * Exchanged credentials, keyed by the session they were minted from.
 *
 * A desktop sign-in stores no token, so this is where the minted one lives: in
 * memory, for this process, thrown away with it. Keying by session id means a
 * re-sign-in (a new id) mints a new token instead of reusing a stale one.
 */
const exchanges = new Map<string, Promise<Catalog>>()

function catalogFor(session: DesktopSession): Promise<Catalog> {
  const cached = exchanges.get(session.ssoSessionId)
  if (cached !== undefined) return cached
  const minted = (async (): Promise<Catalog> => {
    const data = await studioGet("bot/models/configs", astronCookie(session))
    const models = (Array.isArray(data) ? data : []).map(parseRosterRow).filter(isRosterModel)
    if (models.length === 0) throw new Error("AStudio answered no models for this account")
    const preferred = models.find((model) => model.isCurrent) ?? models.find((model) => model.isDefault) ?? models[0]
    if (preferred === undefined) throw new Error("AStudio answered no model credential")
    return { models, apiKey: preferred.apiKey }
  })()
  exchanges.set(session.ssoSessionId, minted)
  // A failed exchange must not be remembered, or every later request fails fast.
  minted.catch(() => exchanges.delete(session.ssoSessionId))
  return minted
}

/** The signed-in account, re-read from the desktop app on every use. */
function currentOrThrow(auth: StoredAuth): { session: DesktopSession; source: string } {
  if (auth.source !== "desktop") throw new Error("AStudio isn't signed in")
  const read = readDesktopSession()
  if ("error" in read) throw new Error(read.error)
  return read
}

// -- wire shaping --------------------------------------------------------------

/** The roster row behind a requested id, matched by wire id, display name or studio id. */
function resolveRow(catalog: Catalog, requested: string): RosterModel | undefined {
  const wanted = requested.trim().toLowerCase()
  return catalog.models.find(
    (model) =>
      model.slug.toLowerCase() === wanted ||
      model.name.toLowerCase() === wanted ||
      model.id.toLowerCase() === wanted,
  )
}

/**
 * Rewrite the request body: the wire id the backend insists on, and the
 * thinking switch it needs. Everything else passes through untouched — the
 * gateway ignores unknown fields, so there is nothing to strip.
 */
function fitBody(body: string, row: RosterModel): string {
  const parsed = asRecord(safeParse(body))
  if (parsed === undefined) return body
  parsed.model = row.slug
  const asked = asText(parsed.reasoning_effort)
  if (asked !== undefined && parsed.enable_thinking === undefined && parsed.thinking === undefined) {
    parsed.enable_thinking = asked.toLowerCase() !== "none"
  }
  return JSON.stringify(parsed)
}

/** Base URL for a model the account roster does not list. */
function familyBase(family: ModelSpec["family"]): string {
  return family === "iflytek" ? SPARK_BASE : MAAS_BASE
}

/** The spec behind a wire id, for limits, families and reasoning levels. */
function specFor(slug: string): ModelSpec | undefined {
  const wanted = slug.trim().toLowerCase()
  return FALLBACK_MODELS.find((spec) => spec.slug.toLowerCase() === wanted)
}

/** Variants are how OpenCode hands reasoning levels to the AI SDK. */
function variants(efforts: string[]): Record<string, { reasoningEffort: string }> {
  return Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }]))
}

/** One model as OpenCode describes it, from a wire id and its details. */
function modelOf(providerId: string, row: RosterModel): Record<string, unknown> {
  const spec = specFor(row.slug)
  const efforts = spec?.efforts ?? DEFAULT_EFFORTS
  const images = spec?.images === true
  return {
    id: row.slug,
    providerID: providerId,
    name: row.name,
    // `api.url` is per model on purpose: the account's models live on two
    // gateways (MaaS and the open Spark one), and this is how magpie is told
    // where each is served.
    api: { id: row.slug, url: row.baseUrl, npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: CONTEXT_WINDOW, output: spec?.output ?? DEFAULT_OUTPUT },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: images,
      toolcall: true,
      input: { text: true, image: images, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: variants(efforts),
    // magpie's own: served at no cost to the plan's credits.
    free: false,
    // magpie's own: what a request costs, as a multiple. The studio API
    // publishes exactly that as `point_multiplier` ("x2.0", "x0.5").
    rate: row.pointMultiplier ?? 0,
  }
}

/** The model shape the `config` hook declares, used before the account is read. */
function configModels(): Record<string, unknown> {
  return Object.fromEntries(
    FALLBACK_MODELS.map((spec) => [
      spec.slug,
      {
        name: spec.name,
        limit: { context: CONTEXT_WINDOW, output: spec.output },
        tool_call: true,
        reasoning: true,
        variants: variants(spec.efforts),
      },
    ]),
  )
}

/** The account's point balance and plan, as magpie's quota card shows them. */
function usageOf(balance: Record<string, unknown>, membership: Record<string, unknown>): Record<string, unknown> {
  const total = asNumber(balance.totalAmount)
  const left = asNumber(balance.totalBalance)
  const plan = asText(membership.planName) ?? asText(membership.planCode)
  const until = asText(balance.activityNextExpireTime)
  const display = left !== undefined && total !== undefined ? `${left} / ${total} 分` : undefined
  const used = left !== undefined && total !== undefined && total > 0 ? ((total - left) / total) * 100 : undefined
  return {
    ...(plan === undefined ? {} : { plan }),
    ...(display === undefined ? {} : { balance: display }),
    ...(until === undefined ? {} : { until }),
    windows: used === undefined ? [] : [{ name: "积分", used, ...(display === undefined ? {} : { display }) }],
    // Reading the balance says nothing about the sign-in, so the account keeps
    // whatever state it had.
    signIn: "kept",
  }
}

// -- the plugin ----------------------------------------------------------------

/**
 * The provider plugin. This module must not export another function, or magpie
 * would call it as a second plugin.
 */
export const AStudioAuthPlugin = async () => ({
  config: async (config: Record<string, unknown>) => {
    const providers = (config.provider ??= {}) as Record<string, Record<string, unknown>>
    const provider = (providers[PROVIDER] ??= {})
    provider.name ??= "AStudio"
    provider.npm ??= NPM
    provider.api ??= MAAS_BASE
    // The account's own roster replaces this as soon as it can be read; the
    // merge keeps whatever the user configured by hand.
    provider.models = { ...configModels(), ...(asRecord(provider.models) ?? {}) }
  },
  provider: {
    id: PROVIDER,
    /**
     * The account's own models, when it can be read; the declared list
     * otherwise — magpie keeps its own list when a hook returns nothing.
     */
    async models(provider: Record<string, unknown>, input?: { auth?: StoredAuth }) {
      const declared = (provider.models ?? {}) as Record<string, unknown>
      const auth = input?.auth
      if (auth?.source !== "desktop") return declared
      try {
        const { session } = currentOrThrow(auth)
        const catalog = await catalogFor(session)
        const listed = new Set(catalog.models.map((model) => model.slug.toLowerCase()))
        // The account's roster is narrower than what the gateways serve: the
        // bundled kernel's own list offers ids it omits (e.g. `spark-x2.5`,
        // which answers on MaaS with the account's key). Offering those too
        // costs nothing and keeps the picker from hiding a working model.
        const extras = FALLBACK_MODELS.filter((spec) => !listed.has(spec.slug.toLowerCase())).map(
          (spec): [string, unknown] => [
            spec.slug,
            modelOf(PROVIDER, {
              id: spec.slug,
              slug: spec.slug,
              name: spec.name,
              baseUrl: familyBase(spec.family),
              apiKey: catalog.apiKey,
              isDefault: false,
              isCurrent: false,
            }),
          ],
        )
        return Object.fromEntries([
          ...catalog.models.map((row): [string, unknown] => [row.slug, modelOf(PROVIDER, row)]),
          ...extras,
        ])
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
        label: "AStudio desktop's sign-in",
        /**
         * Uses the account the desktop app is signed in to. Nothing is copied:
         * the session file is re-read on every request, so a rotation or a
         * sign-out in the app is picked up here without a re-login.
         */
        authorize: () => ({
          url: "",
          instructions: "Uses the account the AStudio desktop app is signed in to.",
          method: "auto",
          async callback() {
            const read = readDesktopSession()
            if ("error" in read) return { type: "failed", error: read.error }
            const name = read.session.nickname ?? read.session.accountId ?? PROVIDER
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
              ...(read.session.uid === undefined ? {} : { uid: read.session.uid }),
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
          const request = input instanceof Request ? input : undefined
          // The sign-in is re-read per request: the desktop app owns it, and it
          // can be rotated or dropped between two calls.
          const auth = await getAuth()
          if (auth?.source !== "desktop") throw new Error("AStudio isn't signed in")
          const { session } = currentOrThrow(auth)
          let catalog = await catalogFor(session)

          const headers = new Headers(init?.headers ?? request?.headers)
          headers.delete("authorization")
          headers.delete("x-api-key")
          headers.delete("content-length")

          let raw: unknown = init?.body
          if (raw === undefined && request !== undefined) raw = await request.clone().text()
          const text = typeof raw === "string" ? raw : undefined
          const asked = text === undefined ? undefined : asRecord(safeParse(text))
          const requested = asked === undefined ? undefined : asText(asked.model)
          let row = requested === undefined ? undefined : resolveRow(catalog, requested)

          const current = request?.url ?? String(input)
          const send = async (chosen: RosterModel | undefined, body: string | undefined): Promise<Response> => {
            headers.set("authorization", `Bearer ${catalog.apiKey}`)
            // A model on the other gateway (the open Spark one) must not be
            // sent to the address magpie built for its sibling.
            const url =
              chosen === undefined || current.startsWith(`${chosen.baseUrl}/`)
                ? current
                : `${chosen.baseUrl}/chat/completions${current.includes("?") ? current.slice(current.indexOf("?")) : ""}`
            return fetch(url, {
              ...init,
              method: init?.method ?? request?.method ?? "POST",
              headers,
              ...(body === undefined ? {} : { body }),
            })
          }

          const body = text === undefined || row === undefined ? text : fitBody(text, row)
          let response = await send(row, body)
          if (response.status === 401 || response.status === 403) {
            // The minted token is per desktop launch, so a sign-out or a
            // rotation invalidates it; re-minting costs one small GET.
            exchanges.delete(session.ssoSessionId)
            catalog = await catalogFor(session)
            row = requested === undefined ? undefined : resolveRow(catalog, requested)
            response = await send(row, body)
          }
          return response
        },
      }
    },
    async usage(getAuth: () => Promise<StoredAuth | undefined>) {
      const auth = await getAuth()
      if (auth?.source !== "desktop") return { error: "not signed in", signIn: "kept" }
      try {
        const { session } = currentOrThrow(auth)
        const cookie = astronCookie(session)
        const [balance, membership] = await Promise.all([
          studioGet("points/balance", cookie),
          studioGet("membership/me", cookie),
        ])
        const user = session.nickname ?? session.accountId
        return {
          ...usageOf(asRecord(balance) ?? {}, asRecord(membership) ?? {}),
          ...(user === undefined ? {} : { user }),
        }
      } catch (error: unknown) {
        return { error: error instanceof Error ? error.message : String(error), signIn: "kept" }
      }
    },
  },
})

/** Exported for tests only; magpie calls the module's plugin function. */
export const _internal = {
  dataRoots,
  readDesktopSession,
  astronCookie,
  parseRosterRow,
  resolveRow,
  fitBody,
  modelOf,
  usageOf,
  studioUrl,
  FALLBACK_MODELS,
  exchanges,
}
