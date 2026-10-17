/**
 * Loomy desktop credential resolution for the omp connect extension.
 *
 * Loomy has no inference API key. It signs in to the iFLYTEK account service
 * and keeps the resulting **account session token** in a plain `electron-store`
 * file; that same token is what every model request carries. So this module
 * only has to find the store and read it — nothing is copied, nothing is
 * exchanged, and nothing is written.
 *
 * The state root is machine-specific and **not** the usual Electron one: on
 * Windows Loomy redirects its own state to
 * `C:\Users\Public\Loomy\<sha256(用户名) 前 12 位>\`, with `userData/` holding the
 * stores (the Electron `%APPDATA%\Loomy` directory only keeps Chromium caches).
 * On other platforms it uses Electron's own `userData`, which is where the
 * packaged app name points.
 */

import { existsSync, readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir, userInfo } from "node:os"
import { join } from "node:path"

/** Points at Loomy's config root (`C:\Users\Public\Loomy\<hash>`). */
export const LOOMY_CONFIG_ROOT_ENV = "LOOMY_CONFIG_ROOT"
/** Supplies the account session token without reading the desktop app. */
export const LOOMY_SESSION_ENV = "LOOMY_SESSION"

/** The store's file name inside `<root>/userData`. */
const SESSION_STORE = "auth-session.json"
/** The Electron app name, for the non-Windows userData location. */
const APP_NAME = "Loomy"

/** The account session Loomy persists; only the fields the bridge needs. */
export interface LoomyCredential {
  /** The account session token, sent as both `token` and `Authorization`. */
  session: string
  userid?: string
  phone?: string
}

export type DesktopCredentialRead =
  | { state: "signed-in"; credential: LoomyCredential; source: string }
  | { state: "signed-out" }
  | { state: "unreadable"; detail: string }

/**
 * `C:\Users\Public\Loomy\<hash>` — Loomy's own rule, reproduced:
 * the first 12 hex characters of the SHA-256 of the operating-system user name.
 */
function windowsConfigRoot(): string {
  let name: string
  try {
    name = userInfo().username
  } catch {
    name = process.env.USERNAME ?? ""
  }
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 12)
  return join("C:", "Users", "Public", "Loomy", hash)
}

/**
 * Candidate config roots, cheapest and most specific first.
 *
 * The environment override exists for containers and for installs whose
 * username differs from the one Loomy hashed (a renamed account leaves the
 * public directory under the old name).
 */
export function configRoots(): string[] {
  const override = process.env[LOOMY_CONFIG_ROOT_ENV]?.trim()
  if (override !== undefined && override !== "") return [override]
  const roots: string[] = []
  if (process.platform === "win32") roots.push(windowsConfigRoot())
  if (process.platform === "darwin") {
    roots.push(join(homedir(), "Library", "Application Support", APP_NAME))
  } else if (process.platform !== "win32") {
    const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
    roots.push(join(configHome, APP_NAME))
  }
  return roots
}

/** Where the session store lives under a config root. */
export function sessionStorePath(root: string): string {
  return join(root, "userData", SESSION_STORE)
}

function parseCredential(value: unknown): LoomyCredential | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const session = record.session
  if (typeof session !== "string" || session.trim() === "") return undefined
  const userid = record.userid
  const phone = record.phone
  return {
    session: session.trim(),
    ...(typeof userid === "string" && userid.trim() !== "" ? { userid: userid.trim() } : {}),
    ...(typeof phone === "string" && phone.trim() !== "" ? { phone: phone.trim() } : {}),
  }
}

/**
 * Read the desktop app's account session.
 *
 * "signed-out" and "unreadable" are kept apart on purpose: the first tells the
 * operator to sign in, the second that the bridge looked in the wrong place
 * (or the file is corrupt), and only the second is a bug in this extension.
 */
export function readDesktopCredential(): DesktopCredentialRead {
  const override = process.env[LOOMY_SESSION_ENV]?.trim()
  if (override !== undefined && override !== "") {
    return {
      state: "signed-in",
      credential: { session: override },
      source: `env:${LOOMY_SESSION_ENV}`,
    }
  }
  const roots = configRoots()
  let sawStore = false
  let lastError: string | undefined
  for (const root of roots) {
    const path = sessionStorePath(root)
    if (!existsSync(path)) continue
    sawStore = true
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"))
    } catch (error: unknown) {
      lastError = `${path}: ${error instanceof Error ? error.message : String(error)}`
      continue
    }
    const credential = parseCredential(parsed)
    if (credential === undefined) {
      lastError = `${path}: 缺少 session 字段`
      continue
    }
    return { state: "signed-in", credential, source: path }
  }
  if (lastError !== undefined) return { state: "unreadable", detail: lastError }
  if (!sawStore) {
    return {
      state: "unreadable",
      detail: `未找到 Loomy 的登录态文件（已探测：${roots.map(sessionStorePath).join("、")}；可用 ${LOOMY_CONFIG_ROOT_ENV} 指定）`,
    }
  }
  return { state: "signed-out" }
}
