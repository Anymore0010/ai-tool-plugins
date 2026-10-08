/**
 * iKooky (WingWork) desktop credential resolution for the omp connect
 * extension.
 *
 * The desktop app is an Electron client whose renderer keeps the signed-in
 * account in `localStorage.super-assistant-userInfo`. That JSON carries the
 * One-platform `access_token` (an RS256 JWT, ~15-year `exp`) the app uses as
 * `Authorization: Bearer` against `https://one.iflytek.com/kooky-api/*`.
 * The token that actually bills inference (`sk-…`) is *not* stored anywhere on
 * disk: the renderer exchanges the JWT for it through
 * `/kooky-api/api/client/v3/cli/config` on every launch and injects the answer
 * into the bundled Claude Code settings. So this plugin does the same exchange
 * (`upstream.ts`) instead of scraping a key file.
 *
 * Chromium keeps `localStorage` in a LevelDB store, so the JWT has to be read
 * out of the store's write-ahead log (or an SST file after a compaction) as
 * UTF-16 record bytes; see `readDesktopAccessToken`.
 *
 * Nothing here writes to the desktop app's files.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const WINGWORK_ACCESS_TOKEN_ENV = "WINGWORK_ACCESS_TOKEN"
/** Where the desktop app keeps Chromium's user-data directory. */
export const WINGWORK_USER_DATA_ENV = "WINGWORK_USER_DATA"

/** localStorage key holding the signed-in account document. */
export const USER_INFO_KEY = "super-assistant-userInfo"

/** Cap on how much of a LevelDB file is scanned (the store can be large). */
const MAX_SCAN_BYTES = 64 * 1024 * 1024

export interface WingWorkCredential {
  /** One-platform JWT used as `Authorization: Bearer` on the kooky-api surface. */
  accessToken: string
  /** Account name (`userId` / `userName`) when the store carried one. */
  user?: string
}

export type DesktopTokenRead =
  | { state: "signed-in"; credential: WingWorkCredential; source: string }
  | { state: "signed-out" }
  | { state: "unreadable"; detail: string }

/**
 * Chromium user-data roots for the desktop app, in probe order. `Kooky` is the
 * release profile; `KookyCodeOss-prod` belongs to the bundled editor and is
 * probed only as a fallback because it usually holds no account.
 */
export function defaultUserDataRoots(): string[] {
  const roots: string[] = []
  const override = process.env[WINGWORK_USER_DATA_ENV]?.trim()
  if (override !== undefined && override !== "") roots.push(override)
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")
    roots.push(join(appData, "Kooky"), join(appData, "KookyCodeOss-prod"))
  } else if (process.platform === "darwin") {
    const support = join(homedir(), "Library", "Application Support")
    roots.push(join(support, "Kooky"), join(support, "KookyCodeOss-prod"))
  } else {
    const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
    roots.push(join(configHome, "Kooky"), join(configHome, "KookyCodeOss-prod"))
  }
  return roots
}

/** LevelDB directories holding `localStorage`, in probe order. */
export function localStorageDirs(root: string): string[] {
  return [
    join(root, "Local Storage", "leveldb"),
    // The bundled editor's own window uses a partition-scoped store.
    join(root, "Partitions", "kode", "Local Storage", "leveldb"),
  ]
}

/** Decode the JSON account document out of a raw record slice. */
function parseUserInfo(text: string): WingWorkCredential | undefined {
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
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== "object") return undefined
  const record = parsed as Record<string, unknown>
  const token = record["access_token"]
  if (typeof token !== "string" || token.length < 40 || !token.startsWith("eyJ")) return undefined
  const user = record["userId"] ?? record["userName"] ?? record["name"]
  return {
    accessToken: token,
    ...(typeof user === "string" && user !== "" ? { user } : {}),
  }
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
function decodeCandidates(slice: Buffer): WingWorkCredential | undefined {
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
 * Pull the account document out of one LevelDB file.
 *
 * A write-ahead log stores `localStorage` records as UTF-16 value bytes after
 * the ASCII key, so the precise read is: find the key, read its value-length
 * varint, slice. After a compaction the record lands in an `.sst`/`.ldb` file,
 * where the values may also be Snappy-compressed; that case is covered only by
 * the plain byte scan and can legitimately come up empty.
 */
function readTokenFromFile(path: string): WingWorkCredential | undefined {
  let buffer: Buffer
  try {
    if (statSync(path).size > MAX_SCAN_BYTES) return undefined
    buffer = readFileSync(path)
  } catch {
    return undefined
  }
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
    // Fallback for records whose framing we cannot parse (compacted stores).
    const window = buffer.subarray(at + marker.length, at + marker.length + 4 * 1024 * 1024)
    const decoded = decodeCandidates(window)
    if (decoded !== undefined) return decoded
  }
}

/** The literal token override, if the operator set one. */
function readEnvCredential(): WingWorkCredential | undefined {
  const token = process.env[WINGWORK_ACCESS_TOKEN_ENV]?.trim()
  if (token === undefined || token === "" ) return undefined
  return { accessToken: token }
}

/**
 * Read the desktop app's account token. Distinguishes "nobody is signed in"
 * from "the store exists but the token could not be recovered", because the
 * second case has a different fix (sign in to the desktop app again, or export
 * `WINGWORK_ACCESS_TOKEN`).
 */
export function readDesktopAccessToken(): DesktopTokenRead {
  const fromEnv = readEnvCredential()
  if (fromEnv !== undefined) {
    return { state: "signed-in", credential: fromEnv, source: `${WINGWORK_ACCESS_TOKEN_ENV} environment variable` }
  }
  const roots = defaultUserDataRoots()
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
        const credential = readTokenFromFile(path)
        if (credential !== undefined) {
          return { state: "signed-in", credential, source: path }
        }
      }
    }
  }
  if (!sawStore) {
    return {
      state: "unreadable",
      detail: `未找到 iKooky (WingWork) 的 Local Storage 目录（已探测：${roots.join("、")}）`,
    }
  }
  return { state: "signed-out" }
}

