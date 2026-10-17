/**
 * Loopback Anthropic-wire shim for the WingWork (iKooky) provider.
 *
 * omp's `anthropic-messages` transport speaks the Anthropic Messages protocol,
 * which is exactly what the gateway serves, so this shim is a credential
 * injector plus a transparent byte relay — not a protocol translator. Request
 * bodies pass through unchanged (verified upstream: thinking tags, `strict`
 * tools, `output_config.effort`, prompt-cache breakpoints and `?beta=true` are
 * all accepted), and SSE frames are forwarded without reframing.
 *
 * The desktop credential lives inside the shim, so the provider registers
 * keyless: omp never sees the `sk-…` key that bills inference.
 *
 * The server binds only to 127.0.0.1 on an ephemeral port.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { WingWorkCredentialStore } from "./store"
import type { WingWorkUpstreamModel } from "./upstream"

export interface WingWorkShimOptions {
  store: WingWorkCredentialStore
  fallbackModels: readonly WingWorkUpstreamModel[]
}

const LOOPBACK_HOSTS: Record<string, true> = {
  "127.0.0.1": true,
  localhost: true,
  "[::1]": true,
  "::1": true,
}
const MAX_BODY = 64 * 1024 * 1024

/** Hop-by-hop and connection-scoped headers that must not be relayed verbatim. */
const DROPPED_REQUEST_HEADERS: Record<string, true> = {
  host: true,
  connection: true,
  "content-length": true,
  "transfer-encoding": true,
  "keep-alive": true,
  upgrade: true,
  "proxy-authorization": true,
  "proxy-connection": true,
  te: true,
  trailer: true,
  "accept-encoding": true,
  // The shim owns the credential: never let a caller-supplied one through.
  authorization: true,
  "x-api-key": true,
}

export class WingWorkShim {
  private server: Server | undefined
  private port = 0
  private catalog: readonly WingWorkUpstreamModel[]

  constructor(private readonly options: WingWorkShimOptions) {
    this.catalog = options.fallbackModels
  }

  listen(): Promise<number> {
    if (this.server !== undefined) return Promise.resolve(this.port)
    const { promise, resolve } = Promise.withResolvers<number>()
    this.server = createServer((req, res) => {
      // An escaping rejection is an unhandled rejection, which omp's postmortem
      // handler treats as fatal and tears down the whole session. `res` itself
      // can emit 'error' (EPIPE / ERR_STREAM_DESTROYED) when the client aborts
      // mid-stream — an event, not a rejection, so it needs its own guard.
      res.on("error", () => {})
      this.handle(req, res).catch((error: unknown) => {
        this.failRequest(res, error)
      })
    })
    this.server.on("clientError", (_error: Error, socket) => {
      socket.destroy()
    })
    this.server.listen(0, "127.0.0.1", () => {
      const address = this.server?.address()
      this.port = typeof address === "object" && address !== null ? address.port : 0
      resolve(this.port)
      // Warm the exchange so the first chat request does not pay the round trip
      // inside omp's provider timeout.
      void this.options.store.config().then((config) => {
        if (config !== undefined && config.models.length > 0) this.catalog = config.models
      })
    })
    return promise
  }

  /** Called by the provider's `fetchDynamicModels` hook. */
  async dynamicModels(): Promise<readonly WingWorkUpstreamModel[]> {
    const config = await this.options.store.config()
    if (config !== undefined && config.models.length > 0) {
      this.catalog = config.models
    }
    return this.catalog
  }

  currentModels(): readonly WingWorkUpstreamModel[] {
    return this.catalog
  }

  close(): void {
    this.server?.close()
  }

  // -- request handling -------------------------------------------------

  private isLoopback(host: string | undefined): boolean {
    if (host === undefined || host === "") return false
    return LOOPBACK_HOSTS[this.hostnameOf(host)] === true
  }

  private hostnameOf(host: string): string {
    const trimmed = host.trim().toLowerCase()
    if (trimmed.startsWith("[")) {
      const end = trimmed.indexOf("]")
      return end === -1 ? trimmed : trimmed.slice(0, end + 1)
    }
    const colon = trimmed.lastIndexOf(":")
    if (colon !== -1 && !trimmed.slice(0, colon).includes(":") && /^\d+$/.test(trimmed.slice(colon + 1))) {
      return trimmed.slice(0, colon)
    }
    return trimmed
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Reject non-loopback Host headers: without this a DNS-rebinding page could
    // drive the shim and spend the desktop account's quota.
    if (!this.isLoopback(req.headers.host)) {
      this.sendJson(res, 403, { error: { type: "forbidden", message: "loopback only" } })
      return
    }
    const raw = req.url ?? "/"
    const queryStart = raw.indexOf("?")
    const path = queryStart === -1 ? raw : raw.slice(0, queryStart)
    const query = queryStart === -1 ? "" : raw.slice(queryStart)

    if (req.method === "GET" && path === "/v1/models") {
      this.sendJson(res, 200, {
        object: "list",
        data: this.catalog.map((model) => ({
          id: model.id,
          object: "model",
          created: 0,
          owned_by: "wingwork",
          ...(model.name !== model.id ? { name: model.name } : {}),
        })),
      })
      return
    }
    if (req.method === "GET" && path === "/v1/status") {
      const status = await this.options.store.status()
      this.sendJson(res, 200, {
        provider: "wingwork",
        state: status.state,
        ...(status.state === "ready"
          ? {
              user: status.user ?? null,
              baseUrl: status.config.baseUrl,
              models: status.config.models.length,
            }
          : {}),
        ...(status.state === "unreadable" || status.state === "unreachable" ? { detail: status.detail } : {}),
      })
      return
    }
    if (req.method === "POST" && path === "/v1/messages") {
      await this.handleMessages(req, res, query)
      return
    }
    this.sendJson(res, 404, { error: { type: "not_found", message: `no route for ${path}` } })
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) return
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      "Cache-Control": "no-store",
    })
    res.end(payload)
  }

  /**
   * Turn a thrown error into an Anthropic-shaped error response. A failure
   * before the upstream reply must surface as an HTTP error to omp, not as a
   * rejected promise, or the session sees a transport fault instead of a
   * retryable provider error.
   */
  private failRequest(res: ServerResponse, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.sendJson(res, 502, { type: "error", error: { type: "api_error", message } })
  }

  private async readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buffer = chunk as Buffer
      size += buffer.length
      if (size > MAX_BODY) throw new Error(`request body exceeds ${MAX_BODY} bytes`)
      chunks.push(buffer)
    }
    return Buffer.concat(chunks)
  }

  private async handleMessages(req: IncomingMessage, res: ServerResponse, query: string): Promise<void> {
    const body = await this.readBody(req)
    const status = await this.options.store.status()
    if (status.state !== "ready") {
      const detail =
        status.state === "signed-out"
          ? "iKooky (WingWork) 桌面端未登录：先登录桌面版，或设置 WINGWORK_ACCESS_TOKEN"
          : status.state === "unreadable"
            ? `无法读取 iKooky 桌面端登录态：${status.detail}`
            : `凭据交换失败：${status.detail}`
      this.sendJson(res, 401, { type: "error", error: { type: "authentication_error", message: detail } })
      return
    }
    // First attempt, then one re-exchange: the minted `sk-…` key is invalidated
    // server-side on logout or rotation, and re-minting costs one small GET.
    let response = await this.forward(body, req, res, query, status.config.apiKey, status.config.baseUrl)
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {})
      this.options.store.invalidate()
      const refreshed = await this.options.store.config()
      if (refreshed === undefined) {
        this.sendJson(res, 401, {
          type: "error",
          error: { type: "authentication_error", message: "凭据失效且重新交换失败，请在 iKooky 桌面端重新登录" },
        })
        return
      }
      response = await this.forward(body, req, res, query, refreshed.apiKey, refreshed.baseUrl)
    }
    await this.relay(response, res)
  }

  private async forward(
    body: Buffer,
    req: IncomingMessage,
    res: ServerResponse,
    query: string,
    apiKey: string,
    baseUrl: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      const lower = name.toLowerCase()
      if (DROPPED_REQUEST_HEADERS[lower] === true) continue
      headers[lower] = Array.isArray(value) ? value.join(", ") : value
    }
    headers["x-api-key"] = apiKey
    headers["anthropic-version"] ??= "2023-06-01"
    // Abort the upstream call only when the *client* goes away mid-response;
    // `req.destroyed` is already true once the body has been consumed, so it
    // cannot be used as the liveness check.
    const controller = new AbortController()
    const onClose = () => {
      if (!res.writableFinished) controller.abort()
    }
    res.on("close", onClose)
    try {
      return await fetch(`${baseUrl}/v1/messages${query}`, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      })
    } finally {
      res.off("close", onClose)
    }
  }

  /**
   * Relay the upstream reply. Streaming responses are piped chunk by chunk so
   * time-to-first-token is preserved; `content-type`, `request-id` and other
   * end-to-end headers are copied so the session keeps upstream diagnostics.
   */
  private async relay(response: Response, res: ServerResponse): Promise<void> {
    if (res.headersSent) return
    const headers: Record<string, string> = {}
    for (const [name, value] of response.headers) {
      if (name === "content-length" || name === "content-encoding" || name === "transfer-encoding") continue
      headers[name] = value
    }
    headers["cache-control"] = "no-store"
    res.writeHead(response.status, headers)
    if (response.body === null) {
      res.end()
      return
    }
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value === undefined) continue
        // Honour backpressure so a slow client cannot balloon the heap.
        if (!res.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => res.once("drain", resolve))
        }
      }
    } finally {
      reader.releaseLock()
    }
    res.end()
  }
}
