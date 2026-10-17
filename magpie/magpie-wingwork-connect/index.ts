/**
 * magpie-wingwork-connect — iKooky (WingWork) as a magpie provider.
 *
 * The desktop app signs in to the iFLYTEK One platform and keeps the account
 * JWT in its Chromium `localStorage`. It does not keep an inference key: on
 * every launch it exchanges that JWT for a short-lived `sk-…` token plus the
 * account's model roster, and hands both to the Claude Code it ships. This
 * plugin performs the same exchange inside magpie's plugin host, so the
 * account works in magpie with no second sign-in and no API key — and without
 * needing the desktop app to be open.
 *
 * Protocol facts this plugin is built on (established by the companion
 * `omp-wingwork-connect` extension and re-verified here):
 *
 * - The gateway speaks **Anthropic Messages** natively, so magpie talks to it
 *   through `@ai-sdk/anthropic`; there is no protocol translation anywhere.
 * - `GET {origin}/kooky-api/api/client/v3/cli/config` with
 *   `Authorization: Bearer <account JWT>` answers `ANTHROPIC_AUTH_TOKEN` (the
 *   `sk-…` inference key), `ANTHROPIC_BASE_URL`, and `models[]`. The One
 *   platform answers a bare HTTP-client `User-Agent` with an HTML 403, so the
 *   desktop app's own product name is sent.
 * - The account's model ids (`wingwork-snt-5.5`) are opaque aliases for real
 *   upstream models (`claude-sonnet-4-6`); the gateway does not report which
 *   family a row is, so the family table below is what tells them apart.
 * - Claude 5.5-generation rows **reject** `thinking.type: "enabled"` with a
 *   400 and require the adaptive wire (`thinking.type: "adaptive"` plus
 *   `output_config.effort`); older rows accept either. The loader therefore
 *   rewrites the thinking block per family.
 *
 * Nothing is copied out of the desktop app: its LevelDB store is read (never
 * written), and the minted key lives in memory only.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Provider id agents use as `<id>/<model>`. */
export const PROVIDER = "wingwork"
/** The transport the gateway speaks natively. */
const NPM = "@ai-sdk/anthropic"
/** One platform origin; overridable for the dev / test environments. */
const DEFAULT_ORIGIN = "https://one.iflytek.com"
const ORIGIN_ENV = "WINGWORK_ORIGIN"
/** Chromium user-data root override. */
const USER_DATA_ENV = "WINGWORK_USER_DATA"
/** Literal account JWT override, skipping the LevelDB read. */
const ACCESS_TOKEN_ENV = "WINGWORK_ACCESS_TOKEN"
/** Where the app keeps the signed-in account document. */
const USER_INFO_KEY = "super-assistant-userInfo"
/** The One platform's `/kooky-api` surface refuses script-client user agents. */
const GATEWAY_USER_AGENT = "WingWork"
/** Exchange path that mints the inference key. */
const CLI_CONFIG_PATH = "/kooky-api/api/client/v3/cli/config"
/** The provider-config surface: models, quota and enablements per provider. */
const PROVIDER_CONFIG_PATH = "/kooky-api/api/client/v1/provider-config"
/** Cap on how much of a LevelDB file is scanned; the store can be large. */
const MAX_SCAN_BYTES = 64 * 1024 * 1024

/** LevelDB's table footer: two block handles, padding, then the magic. */
const LEVELDB_FOOTER_SIZE = 48
/** Little-endian `0xdb4775248b80fb57`, which ends every table file. */
const LEVELDB_TABLE_MAGIC = "57fb808b247547db"

/**
 * Cold discovery must answer inside magpie's model-list budget, and the
 * exchange is one small GET.
 */
const EXCHANGE_TIMEOUT_MS = 12_000

/** Conservative input window until the roster advertises a real one. */
const DEFAULT_CONTEXT_WINDOW = 200_000
/** Input ceiling the shared gateway front enforces, whatever the backend. */
const GATEWAY_CONTEXT_CEILING = 500_000
/** Output ceiling accepted by every probed model on the gateway. */
const DEFAULT_OUTPUT = 64_000

/**
 * Thinking metadata per model family.
 *
 * `adaptive` marks the rows that require the adaptive wire (and lists the
 * efforts the gateway accepts for them); a row without it uses the classic
 * budget form, which magpie's transport already emits.
 */
interface ModelTraits {
  name: string
  adaptive?: string[]
  /** Adaptive `display: "summarized"` is accepted (Opus 4.7+ / Sonnet 5.5). */
  display?: boolean
  /** The gateway's non-Claude backends reject image input. */
  textOnly?: boolean
}

const ADAPTIVE_FULL = ["low", "medium", "high", "xhigh", "max"]
const ADAPTIVE_BASE = ["low", "medium", "high"]

/**
 * The account-facing ids and what they really are. The gateway maps
 * `wingwork-<x>` onto a real upstream model and never reports which, so this
 * table is the only source for names, thinking dialect and image support.
 */
const MODEL_TRAITS: Record<string, ModelTraits> = {
  "wingwork-snt-4.6": { name: "Claude Sonnet 4.6", adaptive: ADAPTIVE_BASE },
  "wingwork-snt-5.5": { name: "Claude Sonnet 5.5", adaptive: ADAPTIVE_FULL, display: true },
  "wingwork-os-4.8": { name: "Claude Opus 4.8", adaptive: ADAPTIVE_FULL, display: true },
  "wingwork-os-5": { name: "Claude Opus 5", adaptive: ADAPTIVE_FULL, display: true },
  "wingwork-os-5.5": { name: "Claude Opus 5.5", adaptive: ADAPTIVE_FULL, display: true },
  "wingwork-gk-4.6": { name: "Grok 4.6", textOnly: true },
  "wingwork-qw-3.8-flash": { name: "Qwen 3.8 Flash", textOnly: true },
  "wingwork-km-k3": { name: "Kimi K3", textOnly: true },
  "wingwork-ds-v4.1-flash": { name: "DeepSeek V4.1 Flash" },
  "wingwork-ds-v4-pro-0813": { name: "DeepSeek V4 Pro" },
  "wingwork-ds-v4-flash-0731": { name: "DeepSeek V4 Flash" },
}

/** The roster shown before the first successful exchange. */
const FALLBACK_MODELS = [
  "wingwork-ds-v4.1-flash",
  "wingwork-ds-v4-pro-0813",
  "wingwork-ds-v4-flash-0731",
  "wingwork-snt-4.6",
  "wingwork-snt-5.5",
  "wingwork-os-5.5",
  "wingwork-os-5",
  "wingwork-os-4.8",
  "wingwork-gk-4.6",
  "wingwork-qw-3.8-flash",
  "wingwork-km-k3",
]

interface RosterModel {
  id: string
  name: string
  contextLimit?: number
}

interface Credential {
  /** `ANTHROPIC_AUTH_TOKEN`: the `sk-…` key that bills inference. */
  apiKey: string
  /** `ANTHROPIC_BASE_URL`: where `/v1/messages` lives. */
  baseUrl: string
  models: RosterModel[]
}

/** The stored auth magpie keeps: a desktop sign-in owns no token of its own. */
interface StoredAuth {
  type?: string
  source?: string
  accountId?: string
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

/** Chromium user-data roots, in probe order. */
function userDataRoots(): string[] {
  const override = asText(process.env[USER_DATA_ENV])
  if (override !== undefined) return [override]
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")
    // `Kooky` is the release profile; the bundled editor's store usually holds
    // no account, so it is only a fallback.
    return [join(appData, "Kooky"), join(appData, "KookyCodeOss-prod")]
  }
  if (process.platform === "darwin") {
    const support = join(homedir(), "Library", "Application Support")
    return [join(support, "Kooky"), join(support, "KookyCodeOss-prod")]
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  return [join(configHome, "Kooky"), join(configHome, "KookyCodeOss-prod")]
}

/** LevelDB directories holding `localStorage`, in probe order. */
function localStorageDirs(root: string): string[] {
  return [join(root, "Local Storage", "leveldb"), join(root, "Partitions", "kode", "Local Storage", "leveldb")]
}

/** Decode the JSON account document out of a raw record slice. */
function parseUserInfo(text: string): { accessToken: string; user?: string } | undefined {
  const start = text.indexOf("{")
  if (start === -1) return undefined
  // The record is followed by further LevelDB bytes, so cut at the matching brace.
  let depth = 0
  let end = -1
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (char === "{") depth++
    else if (char === "}") {
      depth--
      if (depth === 0) {
        end = index + 1
        break
      }
    }
  }
  if (end === -1) return undefined
  const parsed = asRecord(safeParse(text.slice(start, end)))
  if (parsed === undefined) return undefined
  const token = asText(parsed.access_token)
  if (token === undefined || token.length < 40 || !token.startsWith("eyJ")) return undefined
  const user = asText(parsed.userId) ?? asText(parsed.userName) ?? asText(parsed.name)
  return { accessToken: token, ...(user === undefined ? {} : { user }) }
}

/** Read a LevelDB base-128 varint at `offset`; returns the value and byte length. */
function readVarint(buffer: Buffer, offset: number): { value: number; bytes: number } | undefined {
  let value = 0
  let shift = 0
  for (let index = 0; index < 5; index++) {
    const byte = buffer[offset + index]
    if (byte === undefined) return undefined
    value += (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value, bytes: index + 1 }
    shift += 7
  }
  return undefined
}

/** Try every plausible decoding of a record slice; return the first valid one. */
function decodeCandidates(slice: Buffer): { accessToken: string; user?: string } | undefined {
  for (const encoding of ["utf16le", "utf8", "latin1"] as const) {
    const decoded = parseUserInfo(slice.toString(encoding))
    if (decoded !== undefined) return decoded
  }
  // The store mixes endianness between Chromium builds; byte-swap as a fallback.
  const even = slice.length - (slice.length % 2)
  const swapped = Buffer.from(slice.subarray(0, even))
  swapped.swap16()
  return parseUserInfo(swapped.toString("utf16le"))
}

/**
 * Raw Snappy, as LevelDB stores compressed table blocks.
 *
 * Chromium compacts its `localStorage` store into `.ldb`/`.sst` files whose
 * data blocks are Snappy-compressed, which is why the account document can be
 * present yet invisible to a plain byte scan. This is the raw format (not the
 * framed one): a varint of the output length, then literals and copies.
 */
function snappyUncompress(input: Buffer): Buffer | undefined {
  let pos = 0
  let length = 0
  let shift = 0
  for (;;) {
    const byte = input[pos++]
    if (byte === undefined) return undefined
    length += (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) break
    shift += 7
    if (shift > 28) return undefined
  }
  if (length === 0) return Buffer.alloc(0)
  const out = Buffer.alloc(length)
  let written = 0
  while (pos < input.length && written < length) {
    const tag = input[pos++]
    if (tag === undefined) return undefined
    const kind = tag & 3
    if (kind === 0) {
      let literal = tag >> 2
      if (literal >= 60) {
        const extra = literal - 59
        literal = 0
        for (let index = 0; index < extra; index++) {
          const byte = input[pos + index]
          if (byte === undefined) return undefined
          literal |= byte << (8 * index)
        }
        pos += extra
      }
      literal += 1
      if (pos + literal > input.length || written + literal > length) return undefined
      input.copy(out, written, pos, pos + literal)
      pos += literal
      written += literal
      continue
    }
    let copyLength: number
    let offset: number
    if (kind === 1) {
      copyLength = 4 + ((tag >> 2) & 7)
      const next = input[pos++]
      if (next === undefined) return undefined
      offset = ((tag >> 5) << 8) | next
    } else if (kind === 2) {
      copyLength = 1 + (tag >> 2)
      const low = input[pos]
      const high = input[pos + 1]
      if (low === undefined || high === undefined) return undefined
      offset = low | (high << 8)
      pos += 2
    } else {
      copyLength = 1 + (tag >> 2)
      const bytes = input.subarray(pos, pos + 4)
      if (bytes.length < 4) return undefined
      offset = bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)
      pos += 4
    }
    if (offset === 0 || offset > written || written + copyLength > length) return undefined
    for (let index = 0; index < copyLength; index++) {
      out[written] = out[written - offset]!
      written++
    }
  }
  return written === length ? out : undefined
}

/** Find the account document anywhere in a byte range and decode it. */
function scanForAccount(buffer: Buffer): { accessToken: string; user?: string } | undefined {
  const marker = Buffer.from(USER_INFO_KEY, "latin1")
  let searchFrom = 0
  for (;;) {
    const at = buffer.indexOf(marker, searchFrom)
    if (at === -1) return undefined
    searchFrom = at + marker.length
    const length = readVarint(buffer, at + marker.length)
    if (length !== undefined && length.value > 0 && length.value <= MAX_SCAN_BYTES) {
      for (const skew of [0, -1, 1, -2, 2]) {
        const start = at + marker.length + length.bytes + skew
        const slice = buffer.subarray(start, start + length.value)
        if (slice.length < 32) continue
        const decoded = decodeCandidates(slice)
        if (decoded !== undefined) return decoded
      }
    }
    // Fallback for records whose framing cannot be parsed.
    const window = buffer.subarray(at + marker.length, at + marker.length + 4 * 1024 * 1024)
    const decoded = decodeCandidates(window)
    if (decoded !== undefined) return decoded
  }
}

/**
 * Pull the account document out of one LevelDB file.
 *
 * Two layouts hold it:
 * - A **write-ahead log** keeps `localStorage` records as UTF-16 value bytes
 *   after the ASCII key, so the precise read is: find the key, read its
 *   value-length varint, slice.
 * - A **table** (`.ldb`/`.sst`), which is what a compaction leaves behind,
 *   keeps the same records inside data blocks, whose payload is usually
 *   Snappy-compressed. Such a file is a proper table: a 48-byte footer names
 *   the index block, the index names every data block, and each block ends
 *   with a one-byte compression type and a CRC. Compressed blocks are shorter
 *   than the 4 KiB they hold, so blocks cannot be found by walking fixed
 *   strides — the chain is followed instead.
 */
function readTokenFromFile(path: string): { accessToken: string; user?: string } | undefined {
  let buffer: Buffer
  try {
    if (statSync(path).size > MAX_SCAN_BYTES) return undefined
    buffer = readFileSync(path)
  } catch {
    return undefined
  }
  const fromLog = scanForAccount(buffer)
  if (fromLog !== undefined) return fromLog
  return readTable(buffer)
}

/** A block's payload, decompressed according to its trailer. */
function blockPayload(file: Buffer, offset: number, size: number): Buffer | undefined {
  if (size <= 0 || offset < 0 || offset + size + 5 > file.length) return undefined
  const compression = file[offset + size]
  const raw = file.subarray(offset, offset + size)
  if (compression === 0) return raw
  return compression === 1 ? snappyUncompress(raw) : undefined
}

/** Read a block handle: `offset` then `size`, both varints. */
function readBlockHandle(buffer: Buffer, pos: number): { offset: number; size: number; bytes: number } | undefined {
  const offset = readVarint(buffer, pos)
  if (offset === undefined) return undefined
  const size = readVarint(buffer, pos + offset.bytes)
  if (size === undefined) return undefined
  return { offset: offset.value, size: size.value, bytes: offset.bytes + size.bytes }
}

/**
 * Walk a LevelDB table: footer → index block → every data block.
 *
 * The footer's last eight bytes are the table magic, which is what tells this
 * layout apart from a write-ahead log that happens to be the same size.
 */
function readTable(buffer: Buffer): { accessToken: string; user?: string } | undefined {
  if (buffer.length < LEVELDB_FOOTER_SIZE) return undefined
  const footer = buffer.subarray(buffer.length - LEVELDB_FOOTER_SIZE)
  if (footer.subarray(LEVELDB_FOOTER_SIZE - 8).toString("hex") !== LEVELDB_TABLE_MAGIC) return undefined
  const metaindex = readBlockHandle(footer, 0)
  if (metaindex === undefined) return undefined
  const index = readBlockHandle(footer, metaindex.bytes)
  if (index === undefined) return undefined
  const indexBlock = blockPayload(buffer, index.offset, index.size)
  if (indexBlock === undefined) return undefined
  let pos = 0
  while (pos < indexBlock.length) {
    const shared = readVarint(indexBlock, pos)
    if (shared === undefined) break
    pos += shared.bytes
    const nonShared = readVarint(indexBlock, pos)
    if (nonShared === undefined) break
    pos += nonShared.bytes
    const valueLength = readVarint(indexBlock, pos)
    if (valueLength === undefined) break
    pos += valueLength.bytes
    pos += nonShared.value
    const value = indexBlock.subarray(pos, pos + valueLength.value)
    pos += valueLength.value
    const handle = readBlockHandle(value, 0)
    if (handle === undefined) continue
    const block = blockPayload(buffer, handle.offset, handle.size)
    if (block === undefined) continue
    const found = scanForAccount(block)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * The desktop app's account JWT, or a reason there is none.
 *
 * "signed-out" and "unreadable" are kept apart because they need different
 * fixes: sign in to the app, versus point `WINGWORK_USER_DATA` at the store.
 */
function readDesktopToken(): { token: string; user?: string; source: string } | { error: string } {
  const override = asText(process.env[ACCESS_TOKEN_ENV])
  if (override !== undefined) return { token: override, source: `env:${ACCESS_TOKEN_ENV}` }
  const roots = userDataRoots()
  let sawStore = false
  for (const root of roots) {
    for (const dir of localStorageDirs(root)) {
      if (!existsSync(dir)) continue
      sawStore = true
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        continue
      }
      // Newest first: the current session's write-ahead log holds the live value.
      const ordered = entries
        .filter((name) => name.endsWith(".log") || name.endsWith(".ldb") || name.endsWith(".sst"))
        .map((name) => {
          const path = join(dir, name)
          let mtime: number
          try {
            mtime = statSync(path).mtimeMs
          } catch {
            mtime = 0
          }
          return { path, mtime }
        })
        .sort((left, right) => right.mtime - left.mtime)
        .map((entry) => entry.path)
      for (const path of ordered) {
        const found = readTokenFromFile(path)
        if (found !== undefined) return { token: found.accessToken, ...(found.user === undefined ? {} : { user: found.user }), source: path }
      }
    }
  }
  if (!sawStore) {
    return { error: `iKooky (WingWork) desktop isn't installed where expected (${roots.join(", ")})` }
  }
  return { error: "iKooky (WingWork) desktop isn't signed in" }
}

// -- the gateway ---------------------------------------------------------------

function resolveOrigin(): string {
  const override = asText(process.env[ORIGIN_ENV])
  if (override === undefined) return DEFAULT_ORIGIN
  return /^https?:\/\//iu.test(override) ? override.replace(/\/+$/u, "") : `https://${override.replace(/\/+$/u, "")}`
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

function parseModelRow(value: unknown): RosterModel | undefined {
  const row = asRecord(value)
  if (row === undefined) return undefined
  const id = asText(row.model_code) ?? asText(row.modelCode) ?? asText(row.id)
  if (id === undefined) return undefined
  const name = asText(row.model_name) ?? asText(row.modelName) ?? asText(row.name) ?? id
  for (const field of CONTEXT_LIMIT_FIELDS) {
    const limit = Number(row[field])
    if (Number.isFinite(limit) && limit > 0) return { id, name, contextLimit: limit }
  }
  return { id, name }
}

/** Normalize the exchange answer; both the flat and `{data:…}` envelopes occur. */
function parseCredential(value: unknown): Credential | undefined {
  const envelope = asRecord(value)
  if (envelope === undefined) return undefined
  const body = asRecord(envelope.data) ?? envelope
  const apiKey = asText(body.ANTHROPIC_AUTH_TOKEN)
  const baseUrl = asText(body.ANTHROPIC_BASE_URL)
  if (apiKey === undefined || baseUrl === undefined) return undefined
  const roster = Array.isArray(body.models) ? body.models.map(parseModelRow).filter(isRosterModel) : []
  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/u, ""),
    // The roster can repeat a row; the picker must not.
    models: roster.filter((row, index) => roster.findIndex((other) => other.id === row.id) === index),
  }
}

/** Narrow out roster rows the gateway sends without a usable id. */
function isRosterModel(value: RosterModel | undefined): value is RosterModel {
  return value !== undefined
}

/**
 * Minted credentials, keyed by the account token they came from.
 *
 * The desktop JWT is long-lived, so the store's job is exchange caching: the
 * `sk-…` key is minted per desktop launch, so it can be rotated at any time,
 * and re-minting costs one small GET. Keying by the account token means a
 * re-sign-in mints fresh instead of reusing a stale key.
 */
const exchanges = new Map<string, Promise<Credential>>()

function credentialFor(token: string): Promise<Credential> {
  const cached = exchanges.get(token)
  if (cached !== undefined) return cached
  const minted = (async (): Promise<Credential> => {
    const response = await fetch(`${resolveOrigin()}${CLI_CONFIG_PATH}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": GATEWAY_USER_AGENT,
      },
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    })
    if (response.status === 401 || response.status === 403) {
      throw new Error("The WingWork gateway refused the sign-in; sign in on the desktop app again")
    }
    if (!response.ok) throw new Error(`The WingWork gateway answered ${response.status}`)
    const payload: unknown = await response.json().catch(() => undefined)
    const credential = parseCredential(payload)
    if (credential === undefined) {
      throw new Error("The WingWork exchange answered no ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL")
    }
    return credential
  })()
  exchanges.set(token, minted)
  // A failed exchange must not be remembered, or every later request fails fast.
  minted.catch(() => exchanges.delete(token))
  return minted
}

/** The signed-in account, re-read from the desktop app on every use. */
function currentOrThrow(auth: StoredAuth): { token: string; user?: string; source: string } {
  if (auth.source !== "desktop") throw new Error("WingWork isn't signed in")
  const read = readDesktopToken()
  if ("error" in read) throw new Error(read.error)
  return read
}

/**
 * The account name the desktop app puts in `X-KC-Account`: the signed-in
 * account's own id, which the token carries as `sub` (the app's account
 * document calls the same value `userId`).
 */
function accountNameOf(token: string): string | undefined {
  const payload = asRecord(safeParse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")))
  return asText(payload?.sub) ?? asText(payload?.userId) ?? asText(payload?.username)
}

// -- wire shaping --------------------------------------------------------------

/** Traits of a roster row, falling back to the raw id. */
function traitsOf(id: string): ModelTraits | undefined {
  const wanted = id.trim().toLowerCase()
  for (const key of Object.keys(MODEL_TRAITS)) {
    if (key.toLowerCase() === wanted) return MODEL_TRAITS[key]
  }
  return undefined
}

/**
 * Give an adaptive-thinking model the wire it requires.
 *
 * The gateway's Claude 5.5-generation rows answer a 400 to
 * `thinking.type: "enabled"`, which is what a plain Anthropic client sends for
 * a reasoning request; they want `thinking.type: "adaptive"` with the effort
 * in `output_config`. Everything else — messages, tools, cache breakpoints —
 * passes through untouched.
 */
function fitBody(body: string, id: string): string {
  const traits = traitsOf(id)
  if (traits?.adaptive === undefined) return body
  const parsed = asRecord(safeParse(body))
  if (parsed === undefined) return body
  const thinking = asRecord(parsed.thinking)
  if (thinking === undefined) return body
  const asked = asText(thinking.effort)
  const budget = typeof thinking.budget_tokens === "number" ? thinking.budget_tokens : undefined
  if (asked === undefined && budget === undefined) return body
  const effort = asked ?? effortForBudget(budget, traits.adaptive)
  parsed.thinking = { type: "adaptive", ...(traits.display === true ? { display: "summarized" } : {}) }
  parsed.output_config = { ...asRecord(parsed.output_config), effort }
  return JSON.stringify(parsed)
}

/**
 * The effort a budget stands for. The classic form carries a token budget
 * rather than a level, and the adaptive wire has no budget field, so the
 * budget is bucketed onto the ladder the gateway accepts for this model.
 */
function effortForBudget(budget: number | undefined, ladder: string[]): string {
  if (budget === undefined) return ladder[Math.min(2, ladder.length - 1)] ?? "medium"
  if (budget <= 2_048) return "low"
  if (budget <= 8_192) return "medium"
  if (budget <= 16_384) return "high"
  if (budget <= 32_768) return "xhigh"
  return ladder.includes("max") ? "max" : "xhigh"
}

/** Variants are how OpenCode hands reasoning levels to the AI SDK. */
function variants(efforts: string[]): Record<string, { reasoningEffort: string }> {
  return Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }]))
}

/** The reasoning ladder a model advertises; the classic form has no fixed set. */
function effortsOf(id: string): string[] {
  const traits = traitsOf(id)
  if (traits?.adaptive !== undefined) return traits.adaptive
  return ["low", "medium", "high", "xhigh", "max"]
}

/** One model as OpenCode describes it. */
function modelOf(providerId: string, model: RosterModel): Record<string, unknown> {
  const traits = traitsOf(model.id)
  const images = traits?.textOnly !== true
  const context = Math.min(model.contextLimit ?? DEFAULT_CONTEXT_WINDOW, GATEWAY_CONTEXT_CEILING)
  return {
    id: model.id,
    providerID: providerId,
    name: traits?.name ?? model.name,
    api: { id: model.id, url: "", npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context, output: DEFAULT_OUTPUT },
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
    variants: variants(effortsOf(model.id)),
    // The plan is a subscription, not a credit meter: no per-request rate.
    free: false,
    rate: 0,
  }
}

/** The model shape the `config` hook declares, used before the account is read. */
function configModels(): Record<string, unknown> {
  return Object.fromEntries(
    FALLBACK_MODELS.map((id) => {
      const traits = traitsOf(id)
      const images = traits?.textOnly !== true
      return [
        id,
        {
          name: traits?.name ?? id,
          limit: { context: DEFAULT_CONTEXT_WINDOW, output: DEFAULT_OUTPUT },
          tool_call: true,
          reasoning: true,
          variants: variants(effortsOf(id)),
        },
      ]
    }),
  )
}

// -- the plugin ----------------------------------------------------------------

/**
 * The provider plugin. This module must not export another function, or magpie
 * would call it as a second plugin.
 */
export const WingWorkAuthPlugin = async () => ({
  config: async (config: Record<string, unknown>) => {
    const providers = (config.provider ??= {}) as Record<string, Record<string, unknown>>
    const provider = (providers[PROVIDER] ??= {})
    provider.name ??= "WingWork"
    provider.npm ??= NPM
    // The real base URL is per account and arrives with the exchange; the
    // loader's `baseURL` overrides this, which is only a placeholder.
    provider.api ??= `${DEFAULT_ORIGIN}/api/llm/console/chat`
    provider.models = { ...configModels(), ...(asRecord(provider.models) ?? {}) }
  },
  provider: {
    id: PROVIDER,
    /**
     * The account's own models, when the exchange answers; the declared list
     * otherwise — magpie keeps its own list when a hook returns nothing.
     */
    async models(provider: Record<string, unknown>, input?: { auth?: StoredAuth }) {
      const declared = (provider.models ?? {}) as Record<string, unknown>
      const auth = input?.auth
      if (auth?.source !== "desktop") return declared
      try {
        const { token } = currentOrThrow(auth)
        const credential = await credentialFor(token)
        if (credential.models.length === 0) return declared
        return Object.fromEntries(credential.models.map((row) => [row.id, modelOf(PROVIDER, row)]))
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
        label: "iKooky (WingWork) desktop's sign-in",
        /**
         * Uses the account the desktop app is signed in to. Nothing is copied:
         * the account token is re-read from the app's store on every use, so a
         * sign-out there is picked up here without a re-login.
         */
        authorize: () => ({
          url: "",
          instructions: "Uses the account the iKooky (WingWork) desktop app is signed in to.",
          method: "auto",
          async callback() {
            const read = readDesktopToken()
            if ("error" in read) return { type: "failed", error: read.error }
            return {
              type: "success",
              // magpie stores an OAuth result by its token fields, so they are
              // present and empty: this sign-in owns no token of its own, and
              // `source` is what the hooks below read to find the real one.
              refresh: "",
              access: "",
              expires: 0,
              source: "desktop",
              accountId: read.user ?? PROVIDER,
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
          // The account token is the desktop app's, so it is re-read per
          // request: the app owns it and can drop it between two calls.
          const auth = await getAuth()
          if (auth?.source !== "desktop") throw new Error("WingWork isn't signed in")
          const { token } = currentOrThrow(auth)
          let credential = await credentialFor(token)

          const headers = new Headers(init?.headers ?? request?.headers)
          // The gateway authenticates with `x-api-key`, which the transport
          // already set from the loader's apiKey; nothing inbound is kept.
          headers.delete("authorization")
          headers.delete("content-length")

          let raw: unknown = init?.body
          if (raw === undefined && request !== undefined) raw = await request.clone().text()
          const text = typeof raw === "string" ? raw : undefined
          const asked = text === undefined ? undefined : asRecord(safeParse(text))
          const model = asked === undefined ? undefined : asText(asked.model)

          const current = request?.url ?? String(input)
          const send = async (body: string | undefined): Promise<Response> => {
            headers.set("x-api-key", credential.apiKey)
            headers.set("anthropic-version", headers.get("anthropic-version") ?? "2023-06-01")
            // The transport built the URL from the config placeholder; the
            // account's real base URL is the one that works.
            const path = current.slice(current.indexOf("/", current.indexOf("://") + 3))
            const suffix = path.startsWith("/v1/") ? path.slice(3) : path
            return fetch(`${credential.baseUrl}${suffix}`, {
              ...init,
              method: init?.method ?? request?.method ?? "POST",
              headers,
              ...(body === undefined ? {} : { body }),
            })
          }

          const body = text === undefined || model === undefined ? text : fitBody(text, model)
          let response = await send(body)
          if (response.status === 401 || response.status === 403) {
            // The minted key is per desktop launch, so a sign-out or a
            // rotation invalidates it; re-minting costs one small GET.
            exchanges.delete(token)
            credential = await credentialFor(token)
            response = await send(body)
          }
          return response
        },
      }
    },
    /**
     * The plan's monthly allowance.
     *
     * WingWork publishes it on the provider-config surface the desktop app's
     * own settings page reads, as `quota`:
     *
     *   `{ balance, used, total, used_percent, fixed_quota, quota_type,
     *      reset_date, short_term_temp_quota }` — amounts in dollars per month.
     *
     * The `X-KC-Account` header carries the account name the app puts there.
     * Since 2026-10 the whole `/kooky-api` surface answers `Token tid required`
     * to tokens minted before that change, so this reports the platform's own
     * words rather than a blank card; a re-login in the desktop app mints a
     * token the surface accepts and the card fills in.
     */
    async usage(getAuth: () => Promise<StoredAuth | undefined>) {
      const auth = await getAuth()
      if (auth?.source !== "desktop") return { error: "not signed in", signIn: "kept" }
      try {
        const { token } = currentOrThrow(auth)
        const account = accountNameOf(token)
        const response = await fetch(`${resolveOrigin()}${PROVIDER_CONFIG_PATH}/providers/kooky?channel=all`, {
          headers: {
            Accept: "application/json",
            "User-Agent": GATEWAY_USER_AGENT,
            Authorization: `Bearer ${token}`,
            ...(account === undefined ? {} : { "X-KC-Account": account }),
          },
          signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
        })
        const payload: unknown = await response.json().catch(() => undefined)
        if (!response.ok) {
          const record = asRecord(payload)
          const detail = record === undefined ? undefined : (asText(record.detail) ?? asText(record.message))
          return {
            error: `${detail ?? `HTTP ${response.status}`}（额度接口与 /kooky-api 其余部分一样要求带 tid 的令牌；在 iKooky 桌面端重新登录后再试）`,
            // The refusal says nothing about the account's sign-in state.
            signIn: "kept",
          }
        }
        const quota = asRecord(asRecord(asRecord(payload)?.data)?.quota)
        if (quota === undefined) return { error: "the gateway answered no quota", signIn: "kept" }
        const total = asNumber(quota.total)
        const used = asNumber(quota.used)
        const percent =
          asNumber(quota.used_percent) ?? (total === undefined || total <= 0 ? undefined : ((used ?? 0) / total) * 100)
        const reset = asText(quota.reset_date)
        const kind = asText(quota.quota_type)
        return {
          plan: kind === undefined || kind === "free" ? "WingWork" : kind,
          balance:
            total === undefined ? undefined : `$${(total - (used ?? 0)).toFixed(2)} / $${total.toFixed(2)}`,
          windows:
            percent === undefined
              ? []
              : [
                  {
                    name: "每月额度",
                    used: percent,
                    ...(total === undefined ? {} : { display: `$${(used ?? 0).toFixed(2)} / $${total.toFixed(2)}` }),
                    ...(reset === undefined ? {} : { resetsAt: reset }),
                  },
                ],
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
  readDesktopToken,
  parseCredential,
  fitBody,
  effortForBudget,
  modelOf,
  traitsOf,
  credentialFor,
  resolveOrigin,
  FALLBACK_MODELS,
  exchanges,
}
