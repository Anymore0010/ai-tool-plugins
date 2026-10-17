/**
 * magpie-sub2api-claudecode — a sub2api site as a magpie provider, with every
 * request dressed as the Claude Code CLI.
 *
 * A sub2api site can restrict a group to Claude Code clients only
 * (`claude_code_only`; the gateway answers `No available accounts: this group
 * only allows Claude Code clients` to anyone else). That check is not a
 * header check alone — a forged User-Agent is not enough. Measured against
 * sub2api's own validator (`backend/internal/service/claude_code_validator.go`,
 * which in turn says it learned it from claude-relay-service), a request to
 * `/v1/messages` passes only when all of this holds:
 *
 * - User-Agent matches `^claude-cli/<major>.<minor>.<patch>` (case-insensitive);
 * - `x-app`, `anthropic-beta` and `anthropic-version` are all present;
 * - `metadata.user_id` parses as either the JSON form
 *   `{device_id, account_uuid, session_id}` (Claude Code ≥ 2.1.78) or the
 *   legacy `user_<64 hex>_account_<uuid>_session_<uuid>`;
 * - `system` is an **array** of `{type:"text", text}` blocks, and one of those
 *   texts either starts with the billing attribution block
 *   (`x-anthropic-billing-header`, carrying `cc_entrypoint=`) or is within
 *   0.5 Dice similarity of an official Claude Code prompt.
 *
 * A plain provider entry in magpie's config can set headers but cannot touch
 * the body, which is why the same request sent with only the headers is still
 * turned away. This plugin's loader owns the request, so it can do both: the
 * header set a real CLI 2.1.280 sends, and a body rewritten into the shape the
 * validator (and Anthropic's first-party judgement) expects.
 *
 * The disguise is faithful to the measured client rather than invented:
 * `system[0]` is the billing block, `system[1]` the identity banner, the rest
 * follows untouched, and the version in the User-Agent and in `cc_version` is
 * the same one. The billing fingerprint is sub2api's own reconstruction
 * (sha256 of a salt plus three bytes of the first user text plus the version,
 * first three hex digits) so the block reads the same as the traffic the site
 * injects itself.
 *
 * The models and usage halves follow the reference plugin for this kind of
 * site, `magpie-sub2api` by Randy (broven), MIT: `GET /v1/models` for the
 * key's roster, `/backend-api/codex/models` for thinking levels, and
 * `GET /v1/usage` mapped to magpie's usage windows.
 */

const PROVIDER = "sub2api-cc"
const MESSAGES = "@ai-sdk/anthropic"
const CHAT = "@ai-sdk/openai-compatible"
const RESPONSES = "@ai-sdk/openai"
const TIMEOUT = 15_000

const DEFAULT_CLI_VERSION = "2.1.280"

// What a real Claude Code 2.1.280 sends. Only the User-Agent, x-app and the
// two anthropic-* headers are read by the site's validator; the rest is here
// so the whole fingerprint is the client's, not a near miss.
const BILLING_PREFIX = "x-anthropic-billing-header"
const BANNER = "You are Claude Code, Anthropic's official CLI for Claude."
const BETAS =
  "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05"
const STAINLESS: Record<string, string> = {
  "x-stainless-arch": "arm64",
  "x-stainless-lang": "js",
  "x-stainless-os": "MacOS",
  "x-stainless-package-version": "0.112.1",
  "x-stainless-retry-count": "0",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "v26.3.0",
  "x-stainless-timeout": "600",
}

// The official identity prompts (validator's own list, prefixes only): a body
// already carrying one of them is not dressed twice.
const BANNER_PREFIXES = [
  "You are Claude Code, Anthropic's official CLI for Claude",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK",
  "You are a file search specialist for Claude Code",
  "You are a helpful AI assistant tasked with summarizing conversations",
]

// sub2api's salt for the cc_version suffix (gateway_billing_block.go).
const FINGERPRINT_SALT = "59cf53e54c78"

const HOUR = 3600
const DAY = 24 * HOUR
const SPANS: Record<string, [string, number]> = {
  "5h": ["5 hours", 5 * HOUR],
  "1d": ["24 hours", DAY],
  "7d": ["7 days", 7 * DAY],
}

const encoder = new TextEncoder()

// -- small helpers -------------------------------------------------------------

type Json = Record<string, unknown>

function asRecord(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

async function sha256(...parts: Uint8Array[]): Promise<string> {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const joined = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    joined.set(part, at)
    at += part.length
  }
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", joined)))
}

// -- the site ------------------------------------------------------------------

// root is the site's address as typed, without the /v1 an OpenAI client's base
// URL would have, nor a trailing slash.
function root(url: unknown): string {
  return String(url ?? "").trim().replace(/\/+$/, "").replace(/\/v1$/, "")
}

function checkURL(value: unknown): string | undefined {
  try {
    const url = new URL(root(value))
    if (url.protocol !== "https:" && url.protocol !== "http:") return "The address starts with https://"
  } catch {
    return "An address such as https://api.example.com"
  }
  return undefined
}

function hostOf(base: string): string {
  try {
    return new URL(base).host
  } catch {
    return base
  }
}

// -- the sign-in ---------------------------------------------------------------

interface StoredAuth {
  type?: string
  key?: string
  accountId?: string
  metadata?: { baseURL?: string; name?: string }
  [key: string]: unknown
}

// label is how magpie names the account: the name given at sign-in, else the
// site's host and the end of the key. magpie keys an account's own settings by
// this name, so it stays as it was given.
function label(auth: StoredAuth | undefined, base: string): string {
  const given = asText(auth?.metadata?.name)?.trim().slice(0, 60) ?? ""
  if (given) return given
  const key = asText(auth?.key) ?? ""
  const tail = key.length >= 8 ? " …" + key.slice(-4) : ""
  return base ? hostOf(base) + tail : ""
}

// named saves the label on the account, where magpie reads an account's name.
// magpie's API-key sign-in keeps only {type, key, metadata}, so the name is
// written the first time the account is used, in its own scope.
async function named(client: unknown, auth: StoredAuth, base: string): Promise<void> {
  const name = label(auth, base)
  if (!name || auth.accountId === name) return
  const host = asRecord(client)?.["auth"]
  const set = asRecord(host)?.["set"]
  if (typeof set !== "function") return
  // magpie's host API: client.auth.set({path, body}) replaces the account's
  // sign-in with the body given.
  const setAuth = set as (input: unknown) => Promise<unknown>
  try {
    await setAuth.call(host, {
      path: { id: PROVIDER },
      body: { ...auth, accountId: name },
    })
  } catch {
    // a name that cannot be saved is only cosmetic
  }
}

async function get(base: string, path: string, key: string): Promise<unknown> {
  const res = await fetch(base + path, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  })
  const text = await res.text()
  const body: unknown = safeParse(text)
  if (!res.ok) {
    const record = asRecord(body)
    const inner = asRecord(record?.["error"])
    const why =
      asText(inner?.["message"]) ??
      asText(record?.["message"]) ??
      asText(record?.["code"]) ??
      (text.trim().slice(0, 200) || res.statusText)
    const err: Error & { signIn?: string } = new Error(`${res.status} ${why}`)
    if (res.status === 401) err.signIn = "expired"
    throw err
  }
  if (body === undefined) throw new Error(`${path}: not JSON`)
  return body
}

// -- the Claude Code disguise --------------------------------------------------

interface Identity {
  version: string
  deviceID: string
  sessionID: string
}

// One identity per account, made when the loader runs: the version every
// request claims, a device id (64 hex, as the CLI's device_id) and a session
// id (a UUID, as the CLI's per-process one, so a conversation keeps its own).
function newIdentity(version: string): Identity {
  const noise = new Uint8Array(32)
  crypto.getRandomValues(noise)
  return { version, deviceID: hex(noise), sessionID: crypto.randomUUID() }
}

function textOf(block: unknown): string | undefined {
  const record = asRecord(block)
  return record?.["type"] === "text" ? asText(record["text"]) : undefined
}

// systemBlocks is what the request's `system` is, as the array of blocks the
// API takes: a plain string (what the AI SDK sends) is one text block, and
// nothing at all is no blocks.
function systemBlocks(system: unknown): unknown[] {
  if (Array.isArray(system)) return system.filter((block) => asRecord(block) !== undefined)
  if (typeof system === "string" && system.trim() !== "") return [{ type: "text", text: system }]
  return []
}

// firstUserText is the first user message's first text, which is what the
// billing fingerprint is taken from.
function firstUserText(body: Json): string {
  const messages = body["messages"]
  if (!Array.isArray(messages)) return ""
  for (const message of messages) {
    const row = asRecord(message)
    if (row === undefined || row["role"] !== "user") continue
    const content = row["content"]
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
      for (const block of content) {
        const text = textOf(block)
        if (text !== undefined) return text
      }
    }
  }
  return ""
}

// billingHeader is the attribution block the CLI puts first in `system`.
// sub2api rebuilds the same thing for the traffic it forwards: the version, a
// dot, a three-hex fingerprint over the salt, three bytes of the first user
// text (offsets 4, 7 and 20; a zero byte where the text is shorter) and the
// version again. Bytes rather than characters, as the site hashes them.
async function billingHeader(body: Json, id: Identity): Promise<string> {
  const text = encoder.encode(firstUserText(body))
  const picked = new Uint8Array([4, 7, 20].map((at) => (at < text.length ? (text[at] ?? 0) : 0)))
  const digest = await sha256(encoder.encode(FINGERPRINT_SALT), picked, encoder.encode(id.version))
  return `${BILLING_PREFIX}: cc_version=${id.version}.${digest.slice(0, 3)}; cc_entrypoint=cli;`
}

// userID is `metadata.user_id`: the JSON form Claude Code ≥ 2.1.78 sends. The
// site's validator refuses a request whose user_id it cannot parse, so ours is
// always written and always well formed.
function userID(id: Identity): string {
  return JSON.stringify({ device_id: id.deviceID, account_uuid: "", session_id: id.sessionID })
}

// dressBody rewrites one Anthropic Messages request into the CLI's shape:
// `system` becomes an array led by the billing block and the identity banner,
// and `metadata.user_id` is set.
async function dressBody(raw: string, id: Identity): Promise<string> {
  const body = asRecord(safeParse(raw))
  if (body === undefined) return raw
  const blocks = systemBlocks(body["system"])
  const texts = blocks.map((block) => textOf(block) ?? "")
  const billing = texts.findIndex((text) => text.startsWith(BILLING_PREFIX) && text.includes("cc_entrypoint="))
  const banner = texts.findIndex((text) => BANNER_PREFIXES.some((prefix) => text.startsWith(prefix)))
  // Anything already carrying either block is dropped and rebuilt, so a second
  // pass (or another proxy's block) cannot leave two of them behind.
  const kept = blocks.filter((_, at) => at !== billing && at !== banner)
  body["system"] = [
    { type: "text", text: await billingHeader(body, id) },
    { type: "text", text: BANNER },
    ...kept,
  ]
  body["metadata"] = { ...(asRecord(body["metadata"]) ?? {}), user_id: userID(id) }
  return JSON.stringify(body)
}

function dressHeaders(headers: Headers, id: Identity, key: string): void {
  headers.set("user-agent", `claude-cli/${id.version} (external, cli)`)
  headers.set("x-app", "cli")
  headers.set("anthropic-version", "2023-06-01")
  headers.set("anthropic-beta", BETAS)
  headers.set("accept", "application/json")
  headers.set("x-claude-code-session-id", id.sessionID)
  for (const [name, value] of Object.entries(STAINLESS)) headers.set(name, value)
  // A real CLI on a subscription sends the bearer it was issued, not an
  // x-api-key; the site takes either.
  headers.delete("x-api-key")
  headers.set("authorization", `Bearer ${key}`)
}

// -- models --------------------------------------------------------------------

// npmOf is the AI SDK package, and so the endpoint, a model is spoken to on:
// Claude on /v1/messages, OpenAI's on /v1/responses, anything else on
// /v1/chat/completions. The disguise is for /v1/messages; the other two get
// the headers only, which is all the site asks of them.
function npmOf(id: string): string {
  const lower = id.toLowerCase()
  if (lower.startsWith("claude-") || lower.startsWith("anthropic/")) return MESSAGES
  if (/^(gpt-|o\d|codex-|chatgpt-)/.test(lower)) return RESPONSES
  return CHAT
}

const LEVELS = ["low", "medium", "high"]

function variantsOf(levels: readonly string[]): Record<string, Json> {
  return Object.fromEntries(levels.map((level) => [level, {}]))
}

// runtimeModel is magpie's model. Its variants are its reasoning levels: the
// levels the site tells, else the variants magpie already has for the model,
// else low/medium/high for a model that thinks.
function runtimeModel(
  id: string,
  name: string,
  url: string,
  providerID: string,
  told: string[] | undefined,
  was: Json | undefined,
): Json {
  const npm = npmOf(id)
  const variants = asRecord(was?.["variants"])
  const kept = variants !== undefined && Object.keys(variants).length > 0 ? variants : undefined
  const reasoning = (told?.length ?? 0) > 0 || kept !== undefined || npm !== CHAT || /think|reason/i.test(id)
  return {
    id,
    providerID,
    name,
    api: { id, url, npm },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 0, output: 0 },
    capabilities: {
      temperature: true,
      reasoning,
      attachment: npm !== CHAT,
      toolcall: true,
      input: { text: true, image: npm !== CHAT, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: told?.length ? variantsOf(told) : (kept ?? (reasoning ? variantsOf(LEVELS) : {})),
  }
}

// efforts are each model's reasoning levels, by id, as the site's Codex models
// manifest tells them. Only a help: a site that cannot tell gives no levels.
async function efforts(base: string, key: string): Promise<Record<string, string[]>> {
  let body: unknown
  try {
    body = await get(base, "/backend-api/codex/models", key)
  } catch {
    return {}
  }
  const out: Record<string, string[]> = {}
  const list = asRecord(body)?.["models"]
  for (const entry of Array.isArray(list) ? list : []) {
    const row = asRecord(entry)
    const slug = asText(row?.["slug"])
    const levels = row?.["supported_reasoning_levels"]
    if (slug === undefined || !Array.isArray(levels)) continue
    const found: string[] = []
    for (const level of levels) {
      const effort = asText(level) ?? asText(asRecord(level)?.["effort"])
      if (effort !== undefined && effort.trim() !== "" && !found.includes(effort.trim())) found.push(effort.trim())
    }
    // sub2api lists a model it knows nothing of as ["none"] alone, which tells
    // no levels either; "none" next to others is one.
    if (found.some((level) => level !== "none")) out[slug] = found
  }
  return out
}

async function models(base: string, auth: StoredAuth, was: Json): Promise<Json> {
  const key = asText(auth.key) ?? ""
  const [body, told] = await Promise.all([get(base, "/v1/models", key), efforts(base, key)])
  const out: Json = {}
  const list = asRecord(body)?.["data"]
  for (const entry of Array.isArray(list) ? list : []) {
    const row = asRecord(entry)
    const id = asText(row?.["id"])
    if (id === undefined || id === "") continue
    const name = asText(row?.["display_name"]) ?? id
    out[id] = runtimeModel(id, name, base + "/v1", PROVIDER, told[id], asRecord(was[id]))
  }
  if (Object.keys(out).length === 0) throw new Error("/v1/models: an empty list")
  return out
}

// -- usage ---------------------------------------------------------------------

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

// money is how a dollar figure reads in magpie's usage rows; the rounding is
// the site's own (its limits carry cents, not more).
const money = (value: number): string => "$" + (Math.round(value * 100) / 100).toFixed(2)

function win(name: string, used: number, limit: number, extra: Json = {}): Json {
  return {
    name,
    used: limit > 0 ? (100 * used) / limit : used > 0 ? 100 : 0,
    display: money(used) + " / " + money(limit),
    ...extra,
  }
}

// offsetOf is the UTC offset a timestamp from the site carries (+08:00 → 480).
// The site's own clock is what its windows roll on, so its timestamps are the
// only place its time zone is written down.
function offsetOf(iso: unknown): number | undefined {
  const found = typeof iso === "string" ? /([+-])(\d{2}):?(\d{2})$/.exec(iso.trim()) : null
  if (found === null) return undefined
  const sign = found[1] === "-" ? -1 : 1
  return sign * (Number(found[2]) * 60 + Number(found[3]))
}

// nextMidnight is when the site's day window starts again: the next midnight
// on the site's clock. Its daily figures are per calendar day, so this one is
// known rather than guessed (the site's own card counts down to it; the week
// and the month are anchored blocks, and only the week's start is reported).
function nextMidnight(offsetMinutes: number, now: number = Date.now()): string {
  const site = new Date(now + offsetMinutes * 60_000)
  const midnight =
    Date.UTC(site.getUTCFullYear(), site.getUTCMonth(), site.getUTCDate() + 1) - offsetMinutes * 60_000
  return new Date(midnight).toISOString()
}

// fromUsage is magpie's usage from /v1/usage's reply, one of three:
//   - "quota_limited": the key has its own quota or rate limits;
//   - a subscription group: its day, week and month, each a window when the
//     group limits it;
//   - a balance group: the wallet, shown but not a window, since a balance has
//     no span to route by.
function fromUsage(u: Json): Json {
  const rate = (r: Json): Json | undefined => {
    const limit = num(r["limit"])
    if (limit === undefined || !(limit > 0)) return undefined
    const span = SPANS[asText(r["window"]) ?? ""]
    const resetsAt = asText(r["reset_at"])
    return win(
      span?.[0] ?? asText(r["window"]) ?? "Window",
      num(r["used"]) ?? 0,
      limit,
      resetsAt !== undefined ? { resetsAt } : {},
    )
  }

  if (u["mode"] === "quota_limited") {
    const out: Json = { plan: "API key limits", windows: [] }
    const windows: Json[] = []
    const quota = asRecord(u["quota"])
    const quotaLimit = num(quota?.["limit"])
    if (quotaLimit !== undefined && quotaLimit > 0) windows.push(win("Key quota", num(quota?.["used"]) ?? 0, quotaLimit))
    const limits = u["rate_limits"]
    for (const entry of Array.isArray(limits) ? limits : []) {
      const row = asRecord(entry)
      if (row === undefined) continue
      const window = rate(row)
      if (window === undefined) continue
      const span = SPANS[asText(row["window"]) ?? ""]
      windows.push(span === undefined ? window : { ...window, span: span[1] })
    }
    out["windows"] = windows
    const expires = asText(u["expires_at"])
    if (expires !== undefined) out["until"] = expires
    if (u["status"] === "quota_exhausted") out["error"] = "The key's quota is used up"
    else if (u["status"] === "expired") out["error"] = "The key has expired"
    return out
  }

  const plan = asText(u["planName"])?.trim()
  const subscription = asRecord(u["subscription"])
  if (subscription !== undefined) {
    const out: Json = { plan: plan === "" ? undefined : plan, windows: [] }
    const windows: Json[] = []
    // A window's reset time is the one sub2api tells (daily_reset_at and
    // friends; absent on 0.2.14). It is not worked out from the window starts:
    // the day resets at the next midnight in the server's time zone, and the
    // day's and the month's windows roll over only when next used, so a start
    // + 24 hours would be a wrong guess. The week is a rolling 7 days from its
    // start upstream, so its start + 7 days stands in until weekly_reset_at is
    // told.
    const resetOf = (value: unknown): string | undefined => {
      const text = asText(value)
      return text !== undefined && Number.isFinite(Date.parse(text)) ? text : undefined
    }
    const weeklyStart = subscription["weekly_window_start"]
    const weeklyAt = typeof weeklyStart === "string" ? Date.parse(weeklyStart) : NaN
    const weekReset =
      resetOf(subscription["weekly_reset_at"]) ??
      (Number.isFinite(weeklyAt) ? new Date(weeklyAt + 7 * DAY * 1000).toISOString() : undefined)
    const siteOffset = offsetOf(subscription["weekly_window_start"]) ?? offsetOf(subscription["expires_at"])
    const rows: Array<[string, unknown, unknown, number, string | undefined]> = [
      [
        "24 hours",
        subscription["daily_usage_usd"],
        subscription["daily_limit_usd"],
        DAY,
        resetOf(subscription["daily_reset_at"]) ?? (siteOffset === undefined ? undefined : nextMidnight(siteOffset)),
      ],
      ["7 days", subscription["weekly_usage_usd"], subscription["weekly_limit_usd"], 7 * DAY, weekReset],
      ["30 days", subscription["monthly_usage_usd"], subscription["monthly_limit_usd"], 30 * DAY, resetOf(subscription["monthly_reset_at"])],
    ]
    for (const [name, used, limit, span, resetsAt] of rows) {
      const cap = num(limit)
      if (cap === undefined || !(cap > 0)) continue // null or 0: no limit on this window
      windows.push(win(name, num(used) ?? 0, cap, { span, ...(resetsAt !== undefined ? { resetsAt } : {}) }))
    }
    out["windows"] = windows
    const expires = asText(subscription["expires_at"])
    if (expires !== undefined) {
      out["until"] = expires
      if (Date.parse(expires) <= Date.now()) out["error"] = "The subscription has expired"
    }
    if (windows.length === 0) out["balance"] = "Unlimited"
    return out
  }
  const balance = num(u["balance"])
  if (balance !== undefined) return { plan, balance: money(balance) }
  // a subscription group the user has no subscription to: the site lets the
  // request through to fail, and tells no usage
  return { plan, error: "No active subscription for this key's group", windows: [] }
}

async function usage(client: unknown, auth: StoredAuth | undefined, base: string): Promise<Json> {
  if (auth?.type !== "api" || !auth.key) return { error: "not signed in" }
  if (!base) return { error: "No sub2api address saved with this key; sign in again" }
  await named(client, auth, base)
  const user = label(auth, base)
  try {
    const body = asRecord(await get(base, "/v1/usage", asText(auth.key) ?? ""))
    return { user, ...fromUsage(body ?? {}) }
  } catch (e) {
    const err = e as Error & { signIn?: string }
    return { user, error: String(err?.message ?? e), windows: [], ...(err?.signIn !== undefined ? { signIn: err.signIn } : {}) }
  }
}

// -- the plugin ----------------------------------------------------------------

/**
 * The provider plugin. This module must not export another function, or magpie
 * would call it as a second plugin.
 */
export const Sub2apiClaudeCodePlugin = async (context?: unknown, options?: unknown) => {
  const opts = asRecord(options) ?? {}
  const version = asText(opts["cliVersion"])?.trim() || DEFAULT_CLI_VERSION
  const disguise = opts["masquerade"] !== false

  return {
    // A name for the picker without the user's own config having to give one.
    config(raw: Json) {
      const providers = asRecord(raw["provider"]) ?? {}
      const mine = asRecord(providers[PROVIDER]) ?? {}
      providers[PROVIDER] = { ...mine, name: asText(mine["name"]) ?? "sub2api (Claude Code)" }
      raw["provider"] = providers
    },
    provider: {
      id: PROVIDER,
      /**
       * The key's group's list, asked of the account's site. magpie keeps its
       * own list when this returns nothing.
       */
      async models(provider: Json, input?: { auth?: StoredAuth }) {
        const declared = asRecord(provider["models"]) ?? {}
        const auth = input?.auth
        const base = root(auth?.metadata?.baseURL)
        if (auth?.type !== "api" || !auth.key || !base) return declared
        try {
          return await models(base, auth, declared)
        } catch (e) {
          // magpie marks the account as needing a new sign-in when the error
          // says so; anything else leaves magpie's own list in place.
          if (e instanceof Error && "signIn" in e) throw e
          return declared
        }
      },
    },
    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "api",
          label: "sub2api API key",
          placeholder: "sk-…",
          prompts: [
            {
              type: "text",
              key: "baseURL",
              message: "sub2api address",
              placeholder: "https://api.example.com",
              validate: checkURL,
            },
            {
              type: "text",
              key: "name",
              message: "Account name (optional; empty for the site's host and the key's end)",
              placeholder: "",
            },
          ],
        },
      ],
      /**
       * The account's site, and the request itself: magpie calls this once per
       * account, and every request the account makes goes through the fetch
       * returned here.
       */
      async loader(getAuth: () => Promise<StoredAuth | undefined>) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        const base = root(auth.metadata?.baseURL)
        if (!base) return {}
        await named(context, auth, base)
        const key = asText(auth.key) ?? ""
        const identity = newIdentity(version)
        return {
          baseURL: base + "/v1",
          apiKey: key,
          async fetch(input: Request | URL | string, init?: RequestInit): Promise<Response> {
            const request = input instanceof Request ? input : undefined
            const url = request?.url ?? String(input)
            const headers = new Headers(init?.headers ?? request?.headers)
            headers.delete("content-length")
            if (!disguise) {
              headers.set("authorization", `Bearer ${key}`)
              return fetch(url, { ...init, headers })
            }
            dressHeaders(headers, identity, key)
            const path = new URL(url).pathname
            const method = init?.method ?? request?.method ?? "POST"
            let outgoing: BodyInit | undefined = init?.body ?? undefined
            // Only the Messages endpoint is judged as a Claude Code client;
            // /messages/count_tokens and everything else passes on the
            // User-Agent alone, and a body rewritten there would only be
            // counted as extra tokens.
            if (path.endsWith("/messages") && method.toUpperCase() === "POST") {
              const original = typeof outgoing === "string" ? outgoing : await request?.clone().text()
              if (typeof original === "string") outgoing = await dressBody(original, identity)
            }
            return fetch(url, { ...init, method, headers, body: outgoing })
          },
        }
      },
      // magpie's own hook: the plan and how much of it is used
      async usage(getAuth: () => Promise<StoredAuth | undefined>) {
        const auth = await getAuth()
        return usage(context, auth, root(auth?.metadata?.baseURL))
      },
    },
  }
}
