/**
 * Credential store for the WingWork (iKooky) shim.
 *
 * The desktop JWT is long-lived (~15 years), so the store's job is not token
 * refresh but *exchange caching*: `/kooky-api/api/client/v3/cli/config` mints
 * the `sk-…` inference key plus the model roster, and the desktop app itself
 * pays that round trip on every launch. The shim keeps the answer for the
 * process and re-exchanges only when it is invalidated (upstream rejected the
 * key, or the model roster is explicitly refreshed by the user).
 *
 * Nothing is persisted: the minted key lives in memory only, matching the
 * desktop app, which never writes it to disk.
 */

import { readDesktopAccessToken, type WingWorkCredential } from "./auth"
import {
  WingWorkAuthError,
  WingWorkUpstreamError,
  type WingWorkUpstreamClient,
  type WingWorkUpstreamConfig,
} from "./upstream"

export type WingWorkConfigStatus =
  | { state: "ready"; config: WingWorkUpstreamConfig; user?: string }
  | { state: "signed-out" }
  | { state: "unreadable"; detail: string }
  | { state: "unreachable"; detail: string }

export class WingWorkCredentialStore {
  private cached: WingWorkUpstreamConfig | undefined
  private inflight: Promise<WingWorkUpstreamConfig | undefined> | undefined
  private credential: WingWorkCredential | undefined

  constructor(private readonly client: WingWorkUpstreamClient) {}

  /** The exchange result, minting or re-minting it as needed. */
  async config(): Promise<WingWorkUpstreamConfig | undefined> {
    if (this.cached !== undefined) return this.cached
    // Memoize the in-flight promise so a burst of parallel requests pays one
    // exchange; a failed attempt clears it so the next request retries.
    this.inflight ??= this.exchange()
    const config = await this.inflight
    if (config === undefined) this.inflight = undefined
    return config
  }

  async status(): Promise<WingWorkConfigStatus> {
    const config = await this.config()
    if (config !== undefined) {
      return {
        state: "ready",
        config,
        ...(this.credential?.user !== undefined ? { user: this.credential.user } : {}),
      }
    }
    const desktop = readDesktopAccessToken()
    if (desktop.state === "signed-in") {
      // A credential existed but the exchange failed; the last error is the diagnosis.
      return { state: "unreachable", detail: this.lastError ?? "凭据交换失败" }
    }
    if (desktop.state === "unreadable") return { state: "unreadable", detail: desktop.detail }
    return { state: "signed-out" }
  }

  private lastError: string | undefined

  /** Drop the cached exchange so the next request mints a new key. */
  invalidate(): void {
    this.cached = undefined
    this.inflight = undefined
  }

  private async exchange(): Promise<WingWorkUpstreamConfig | undefined> {
    const desktop = readDesktopAccessToken()
    if (desktop.state !== "signed-in") {
      this.lastError = desktop.state === "unreadable" ? desktop.detail : "iKooky 桌面端未登录"
      return undefined
    }
    this.credential = desktop.credential
    try {
      const config = await this.client.fetchConfig(desktop.credential)
      this.cached = config
      this.lastError = undefined
      return config
    } catch (error: unknown) {
      this.lastError =
        error instanceof WingWorkAuthError || error instanceof WingWorkUpstreamError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error)
      return undefined
    }
  }
}
