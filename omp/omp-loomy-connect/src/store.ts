/**
 * Credential store for the Loomy shim.
 *
 * Loomy's session token is long-lived and used directly — there is no exchange
 * to cache — so the store's job is the **catalogue**: `GET {base}/models` is a
 * live, server-controlled list, and the shim keeps the answer for the process
 * so model discovery does not pay a round trip per request.
 *
 * Nothing is persisted: the token is read from the desktop app's store on each
 * use, so signing out there is picked up here without a restart.
 */

import { readDesktopCredential, type DesktopCredentialRead, type LoomyCredential } from "./auth"
import { LoomyUpstreamClient, LoomyUpstreamError, LoomySessionExpiredError, type LoomyModel } from "./upstream"
import { liveApiBase } from "./config"
import { FALLBACK_LOOMY_MODELS } from "./catalog"

/** The credential read, under the name the shim uses. */
export type LoomyCredentialRead = DesktopCredentialRead

export type LoomyStatus =
  | { state: "ready"; credential: LoomyCredential; source: string }
  | { state: "signed-out" }
  | { state: "unreadable"; detail: string }

export class LoomyCredentialStore {
  private cache: LoomyModel[] | undefined
  private inflight: Promise<LoomyModel[] | undefined> | undefined
  private lastError: string | undefined

  constructor(private readonly client: LoomyUpstreamClient) {}

  /** The account's catalogue, fetched once per process (or after a failure). */
  async catalog(): Promise<LoomyModel[] | undefined> {
    if (this.cache !== undefined) return this.cache
    // Memoize the in-flight promise so a burst of parallel requests pays one
    // fetch; a failed attempt clears it so the next request retries.
    this.inflight ??= this.fetch()
    const models = await this.inflight
    if (models === undefined) this.inflight = undefined
    return models
  }

  /** Drop the cached catalogue so the next call re-reads it. */
  invalidate(): void {
    this.cache = undefined
    this.inflight = undefined
  }

  /** The static list, for the picker when the account cannot be read. */
  fallback(): readonly LoomyModel[] {
    return FALLBACK_LOOMY_MODELS
  }

  /**
   * Why the bridge can or cannot serve requests. "unreadable" means the bridge
   * looked in the wrong place (or the store is corrupt) while "signed-out"
   * means the desktop app has no session — different fixes.
   */
  status(): LoomyStatus {
    const read = readDesktopCredential()
    if (read.state === "signed-in") {
      return { state: "ready", credential: read.credential, source: read.source }
    }
    if (read.state === "unreadable") return { state: "unreadable", detail: read.detail }
    return { state: "signed-out" }
  }

  private async fetch(): Promise<LoomyModel[] | undefined> {
    const read = readDesktopCredential()
    if (read.state !== "signed-in") {
      this.lastError = read.state === "unreadable" ? read.detail : "Loomy 桌面端未登录"
      return undefined
    }
    try {
      const models = await this.client.fetchModels(read.credential, liveApiBase())
      this.cache = models
      this.lastError = undefined
      return models
    } catch (error: unknown) {
      this.lastError =
        error instanceof LoomySessionExpiredError || error instanceof LoomyUpstreamError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error)
      return undefined
    }
  }
}
