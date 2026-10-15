/**
 * Credential store for the AStudio shim.
 *
 * The account session (`astron-session.json`) is long-lived, so the store's job
 * is not token refresh but *exchange caching*: `bot/models/configs` mints the
 * per-account inference token plus the model roster, and re-minting costs one
 * small GET. The answer is kept for the process lifetime and re-minted only
 * when it is invalidated (a backend rejected the token, or the operator asked
 * for a refresh), which keeps a rotating token from ever being cached to disk.
 */

import { readDesktopSession, type AstronSession } from "./auth"
import {
  AstronSessionExpiredError,
  AstronUpstreamError,
  type AstronModelCatalog,
  type AstronUpstreamClient,
} from "./upstream"

export type AstronConfigStatus =
  | { state: "ready"; catalog: AstronModelCatalog; session: AstronSession; source: string }
  | { state: "signed-out" }
  | { state: "unreadable"; detail: string }
  | { state: "unreachable"; detail: string }


/**
 * Why the bridge is or is not serving, phrased as the fix the operator needs.
 *
 * "unreadable" means the bridge looked in the wrong place (or the session file
 * is corrupt) while "unreachable" means a credential existed but the studio API
 * refused it. Those need different actions, so they read differently.
 */
export function describeStatus(status: AstronConfigStatus): string {
  switch (status.state) {
    case "ready":
      return `已就绪：${status.session.nickname ?? status.session.accountId ?? status.source}（${status.catalog.models.length} 个模型）`
    case "signed-out":
      return "AStudio 桌面端未登录：先登录桌面版，或设置 ASTUDIO_SSO_SESSION_ID"
    case "unreadable":
      return `无法读取 AStudio 登录态：${status.detail}`
    default:
      return `AStudio 凭据交换失败：${status.detail}`
  }
}

export class AstronCredentialStore {
  private cached: AstronModelCatalog | undefined
  private inflight: Promise<AstronModelCatalog | undefined> | undefined
  private session: AstronSession | undefined
  private source: string | undefined
  private lastError: string | undefined

  constructor(private readonly client: AstronUpstreamClient) {}

  /** The exchange result, minting or re-minting it as needed. */
  async catalog(): Promise<AstronModelCatalog | undefined> {
    if (this.cached !== undefined) return this.cached
    // Memoize the in-flight promise so a burst of parallel requests pays one
    // exchange; a failed attempt clears it so the next request retries.
    this.inflight ??= this.exchange()
    const catalog = await this.inflight
    if (catalog === undefined) this.inflight = undefined
    return catalog
  }

  /** Drop the cached exchange so the next request mints a new token. */
  invalidate(): void {
    this.cached = undefined
    this.inflight = undefined
  }

  /**
   * Why the bridge can or cannot serve requests. "unreadable" means the bridge
   * looked in the wrong place (or the session file is corrupt), "unreachable"
   * that a credential existed but the studio API refused it — different fixes.
   */
  async status(): Promise<AstronConfigStatus> {
    const catalog = await this.catalog()
    if (catalog !== undefined && this.session !== undefined) {
      return { state: "ready", catalog, session: this.session, source: this.source ?? "desktop" }
    }
    const desktop = await readDesktopSession()
    if (desktop.state === "unreadable") return { state: "unreadable", detail: desktop.detail }
    if (desktop.state !== "signed-in") return { state: "signed-out" }
    return { state: "unreachable", detail: this.lastError ?? "凭据交换失败" }
  }

  private async exchange(): Promise<AstronModelCatalog | undefined> {
    const desktop = await readDesktopSession()
    if (desktop.state !== "signed-in") {
      this.lastError = desktop.state === "unreadable" ? desktop.detail : "AStudio 桌面端未登录"
      return undefined
    }
    this.session = desktop.session
    this.source = desktop.source
    try {
      const catalog = await this.client.fetchModelCatalog(desktop.session)
      this.cached = catalog
      this.lastError = undefined
      return catalog
    } catch (error: unknown) {
      this.lastError =
        error instanceof AstronSessionExpiredError || error instanceof AstronUpstreamError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error)
      return undefined
    }
  }
}
