/**
 * AStudio desktop credential resolution for the omp connect extension.
 *
 * AStudio (iFLYTEK "AstronClaw", publisher TokenSpark) never keeps a static
 * API key on disk. What it keeps is the account session it obtained at sign-in
 * (`userdata/astron-session.json` in the app's data root): an SSO session id,
 * an account id and an opaque account token. The model bearer token used for
 * inference is *derived* from that session — the desktop exchanges it against
 * the studio API on every launch (see `upstream.ts`) — so this module only has
 * to find and read those files read-only.
 *
 * The data root is machine-specific: the installer records it under
 * `HKCU\Software\AStudioStorage` (`<Profile>DataRoot`), and a machine that has
 * never run the installer falls back to a directory named `AStudio Data`
 * sitting next to the executable. Both are probed, cheapest first.
 */

import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/** Points at the AStudio data root directly (`D:\App\AStudio Data`). */
export const ASTUDIO_DATA_ROOT_ENV = "ASTUDIO_DATA_ROOT"
/** Supplies the account SSO session id without reading the desktop app. */
export const ASTUDIO_SSO_SESSION_ID_ENV = "ASTUDIO_SSO_SESSION_ID"
/** Supplies the account token without reading the desktop app. */
export const ASTUDIO_ACCOUNT_TOKEN_ENV = "ASTUDIO_ACCOUNT_TOKEN"

/** Registry key the installer uses to publish its data locations. */
const STORAGE_REGISTRY_KEY = String.raw`HKCU\Software\AStudioStorage`
const UNINSTALL_REGISTRY_KEYS = [
  String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`,
  String.raw`HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall`,
  String.raw`HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`,
] as const
/** Directory name the app appends to the install dir when the registry is silent. */
const PORTABLE_DATA_DIR_NAME = "AStudio Data"
/** Session file locations inside the data root, in probe order. */
const SESSION_RELATIVE_PATHS = [
  ["userdata", "astron-session.json"],
  ["dev", "astron-session.json"],
] as const

/** The account state AStudio persists; only the fields the bridge needs are typed. */
export interface AstronSession {
  accountId?: string
  uid?: string
  /** Opaque account token, sent as the `token` cookie to the account API. */
  token?: string
  /** SSO session id; the only credential the model-config exchange needs. */
  ssoSessionId: string
  /** Bearer token minted for inference; a cache the exchange can rebuild. */
  modelBearerToken?: string
  nickname?: string
  mobile?: string
  loginMethod?: string
  banned?: boolean
}

export type DesktopSessionRead =
  | { state: "signed-in"; session: AstronSession; source: string }
  | { state: "signed-out" }
  | { state: "unreadable"; detail: string }

/** Ask `reg.exe` for a key's values; an absent key is an empty answer, not an error. */
function queryRegistry(key: string, recursive: boolean): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>()
  const systemRoot = process.env.SystemRoot?.trim()
  if (systemRoot === undefined || systemRoot === "") {
    resolve("")
    return promise
  }
  const args = recursive ? ["query", key, "/s"] : ["query", key]
  execFile(
    join(systemRoot, "System32", "reg.exe"),
    args,
    { maxBuffer: 4 * 1024 * 1024, timeout: 5_000, windowsHide: true },
    (error, stdout) => {
      resolve(error == null ? stdout : "")
    },
  )
  return promise
}

/** Every `<something>DataRoot` value the installer recorded, in registry order. */
function dataRootsFromStorageKey(output: string): string[] {
  const roots: string[] = []
  for (const line of output.split(/\r?\n/u)) {
    const value = /^\s+(\S+)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*?)\s*$/iu.exec(line)
    if (value === null) continue
    const name = value[1] ?? ""
    const path = (value[2] ?? "").trim()
    if (!name.endsWith("DataRoot") || path === "") continue
    roots.push(path)
  }
  return roots
}

/** Data roots inferred from an uninstall record whose icon points at the app. */
function dataRootsFromUninstallKey(output: string): string[] {
  const roots: string[] = []
  for (const line of output.split(/\r?\n/u)) {
    const value = /^\s+(\S+)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*?)\s*$/iu.exec(line)
    if (value === null) continue
    const path = (value[2] ?? "").trim().replace(/,\d+$/u, "")
    if (!/AStudio\.exe$/iu.test(path.replace(/"/gu, ""))) continue
    const match = /^(.*)[\\/][^\\/]+$/u.exec(path.replace(/"/gu, ""))
    if (match?.[1] === undefined) continue
    roots.push(join(match[1], PORTABLE_DATA_DIR_NAME))
  }
  return roots
}

/**
 * Candidate AStudio data roots, cheapest source first. The caller probes each
 * in order and stops at the first that holds a session file, so the (slow)
 * `reg.exe` spawns only happen when the environment override is absent.
 */
export async function resolveDataRoots(): Promise<string[]> {
  const override = process.env[ASTUDIO_DATA_ROOT_ENV]?.trim()
  if (override !== undefined && override !== "") return [override]

  const roots: string[] = []
  for (const root of dataRootsFromStorageKey(await queryRegistry(STORAGE_REGISTRY_KEY, false))) {
    roots.push(root)
  }
  for (const key of UNINSTALL_REGISTRY_KEYS) {
    if (roots.length > 0) break
    for (const root of dataRootsFromUninstallKey(await queryRegistry(key, true))) {
      roots.push(root)
    }
  }
  return roots
}

/** Validate a parsed session document; `undefined` means "not a usable session". */
function parseSession(value: unknown): AstronSession | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const text = (key: string): string | undefined => {
    const raw = record[key]
    return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined
  }
  const ssoSessionId = text("ssoSessionId")
  if (ssoSessionId === undefined) return undefined
  return {
    ssoSessionId,
    accountId: text("accountId"),
    uid: text("uid"),
    token: text("token"),
    modelBearerToken: text("modelBearerToken"),
    nickname: text("nickname"),
    mobile: text("mobile"),
    loginMethod: text("loginMethod"),
    banned: record.banned === true,
  }
}

/**
 * The credential the operator pinned through the environment. This exists for
 * containers and non-default installs, and it bypasses the desktop app
 * entirely: the studio API only needs the SSO session id.
 */
function readEnvSession(): AstronSession | undefined {
  const ssoSessionId = process.env[ASTUDIO_SSO_SESSION_ID_ENV]?.trim()
  if (ssoSessionId === undefined || ssoSessionId === "") return undefined
  const token = process.env[ASTUDIO_ACCOUNT_TOKEN_ENV]?.trim()
  return { ssoSessionId, ...(token === undefined || token === "" ? {} : { token }) }
}

/**
 * Read the desktop app's account session.
 *
 * "signed-out" and "unreadable" are kept apart on purpose: the first tells the
 * operator to sign in, the second that the bridge looked in the wrong place
 * (or the file is corrupt), and only the second is a bug in this extension.
 */
export async function readDesktopSession(): Promise<DesktopSessionRead> {
  const env = readEnvSession()
  if (env !== undefined) return { state: "signed-in", session: env, source: `env:${ASTUDIO_SSO_SESSION_ID_ENV}` }

  let roots: string[]
  try {
    roots = await resolveDataRoots()
  } catch (error: unknown) {
    return { state: "unreadable", detail: error instanceof Error ? error.message : String(error) }
  }
  if (roots.length === 0) {
    return {
      state: "unreadable",
      detail: `未找到 AStudio 数据目录（注册表 ${STORAGE_REGISTRY_KEY} 无 DataRoot，或设置 ${ASTUDIO_DATA_ROOT_ENV}）`,
    }
  }

  let lastError: string | undefined
  for (const root of roots) {
    for (const relative of SESSION_RELATIVE_PATHS) {
      const path = join(root, ...relative)
      if (!existsSync(path)) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(path, "utf8"))
      } catch (error: unknown) {
        lastError = `${path}: ${error instanceof Error ? error.message : String(error)}`
        continue
      }
      const session = parseSession(parsed)
      if (session === undefined) {
        lastError = `${path}: 缺少 ssoSessionId 字段`
        continue
      }
      if (session.banned === true) {
        return { state: "unreadable", detail: `${path}: 账号已被封禁（banned: true）` }
      }
      return { state: "signed-in", session, source: path }
    }
  }
  if (lastError !== undefined) return { state: "unreadable", detail: lastError }
  return { state: "signed-out" }
}

/**
 * Cookie for every studio-API call.
 *
 * The desktop app sends the session id under both spellings plus the account
 * id and account token; the model-config exchange and the account endpoints
 * differ only in which of those they actually need, so one header covers both
 * (verified live against production).
 */
export function astronCookie(session: AstronSession): string {
  return [
    `ssoSessionId=${session.ssoSessionId}`,
    `sso_sessionid=${session.ssoSessionId}`,
    session.accountId === undefined ? undefined : `account_id=${session.accountId}`,
    session.token === undefined ? undefined : `token=${session.token}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join("; ")
}
