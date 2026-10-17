/**
 * Loopback OpenAI-compatible shim for the Loomy provider.
 *
 * Loomy's model surface is already OpenAI chat completions, so this is a
 * credential and header injector, not a translator: the body passes through
 * untouched and SSE frames are relayed without reframing. What it adds is
 *
 * - the account session, sent as both `token` and `Authorization: Bearer`,
 *   which omp must not have to know about, and
 * - a fresh **`traceparent`** per request. Without one `chat/completions`
 *   hangs until the client gives up — the desktop app's own source records
 *   exactly that — so the shim mints one rather than forwarding whatever the
 *   caller sent.
 *
 * The server binds only to 127.0.0.1 on an ephemeral port.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { LoomyCredentialStore, LoomyStatus } from "./store"
import type { LoomyModel, LoomyUpstreamClient } from "./upstream"
import { authHeaders } from "./upstream"
import { liveApiBase, livePointsBase } from "./config"

export interface LoomyShimOptions {
  store: LoomyCredentialStore
  client: LoomyUpstreamClient
}

const LOOPBACK_HOSTS: Record<string, true> = {
  "127.0.0.1": true,
  localhost: true,
  "[::1]": true,
  "::1": true,
}
const MAX_BODY = 64 * 1024 * 1024

/** Hop-by-hop, connection-scoped and credential headers that must not be relayed. */
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
  // The shim owns the account session and mints its own trace context.
  authorization: true,
  token: true,
  traceparent: true,
}

export class LoomyShim {
  private server: Server | undefined
  private port = 0

  constructor(private readonly options: LoomyShimOptions) {}

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
      // Warm the catalogue so the first chat request does not pay the round
      // trip inside omp's provider timeout.
      void this.options.store.catalog()
    })
    return promise
  }

  close(): void {
    this.server?.close()
  }

  /** The catalogue omp should show; the static fallback until the account reads. */
  async models(): Promise<readonly LoomyModel[]> {
    return (await this.options.store.catalog()) ?? this.options.store.fallback()
  }

  // -- request handling -------------------------------------------------

  private isLoopback(host: string | undefined): boolean {
    if (host === undefined || host === "") return false
    const trimmed = host.trim().toLowerCase()
    if (trimmed.startsWith("[")) {
      const end = trimmed.indexOf("]")
      return LOOPBACK_HOSTS[end === -1 ? trimmed : trimmed.slice(0, end + 1)] === true
    }
    const colon = trimmed.lastIndexOf(":")
    if (colon !== -1 && !trimmed.slice(0, colon).includes(":") && /^\d+$/u.test(trimmed.slice(colon + 1))) {
      return LOOPBACK_HOSTS[trimmed.slice(0, colon)] === true
    }
    return LOOPBACK_HOSTS[trimmed] === true
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Reject non-loopback Host headers: without this a DNS-rebinding page could
    // drive the shim and spend the desktop account's points.
    if (!this.isLoopback(req.headers.host)) {
      this.sendJson(res, 403, { error: { type: "forbidden", message: "loopback only" } })
      return
    }
    const raw = req.url ?? "/"
    const queryStart = raw.indexOf("?")
    const path = queryStart === -1 ? raw : raw.slice(0, queryStart)

    if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
      await this.handleModels(res)
      return
    }
    if (req.method === "GET" && path === "/v1/status") {
      await this.handleStatus(res)
      return
    }
    if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
      await this.handleChat(req, res)
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
   * Turn a thrown error into an OpenAI-shaped error response. A failure before
   * the upstream reply must surface as an HTTP error to omp, not as a rejected
   * promise, or the session sees a transport fault instead of a provider error.
   */
  private failRequest(res: ServerResponse, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.sendJson(res, 502, { error: { type: "api_error", message } })
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

  private async handleModels(res: ServerResponse): Promise<void> {
    const data = (await this.models()).map((model) => ({
      id: model.id,
      object: "model",
      created: 0,
      owned_by: "loomy",
      ...(model.name === model.id ? {} : { name: model.name }),
    }))
    this.sendJson(res, 200, { object: "list", data })
  }

  private async handleStatus(res: ServerResponse): Promise<void> {
    const status = this.options.store.status()
    if (status.state !== "ready") {
      this.sendJson(res, 200, {
        provider: "loomy",
        state: status.state,
        ...(status.state === "signed-out" ? {} : { detail: status.detail }),
      })
      return
    }
    const account = await this.options.client
      .fetchBalance(status.credential, livePointsBase())
      .catch(() => ({}))
    this.sendJson(res, 200, {
      provider: "loomy",
      state: "ready",
      source: status.source,
      account: status.credential.phone ?? status.credential.userid ?? null,
      base: liveApiBase(),
      models: (await this.models()).length,
      ...account,
    })
  }

  private async handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req)
    const status = this.options.store.status()
    if (status.state !== "ready") {
      this.sendJson(res, 401, {
        error: { type: "authentication_error", message: describeStatus(status) },
      })
      return
    }
    // A fresh span per request, as the desktop app does: the platform hangs a
    // chat call that arrives without a trace context.
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      const lower = name.toLowerCase()
      if (DROPPED_REQUEST_HEADERS[lower] === true) continue
      headers[lower] = Array.isArray(value) ? value.join(", ") : value
    }
    Object.assign(headers, authHeaders(status.credential))
    headers["content-type"] = "application/json"

    const upstream = `${liveApiBase()}/chat/completions`
    // Abort the upstream call only when the *client* goes away mid-response;
    // `req.destroyed` is already true once the body has been consumed, so it
    // cannot be used as the liveness check.
    const controller = new AbortController()
    const onClose = () => {
      if (!res.writableFinished) controller.abort()
    }
    res.on("close", onClose)
    try {
      const response = await fetch(upstream, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      })
      await this.relay(response, res)
    } finally {
      res.off("close", onClose)
    }
  }

  /**
   * Relay the backend reply. Streaming responses are piped chunk by chunk so
   * time-to-first-token is preserved; `content-type` and the vendor request id
   * are copied so the session keeps upstream diagnostics.
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

/** Why the shim cannot serve a request, phrased as the fix the operator needs. */
export function describeStatus(status: LoomyStatus): string {
  if (status.state === "ready") {
    return `已登录：${status.credential.phone ?? status.credential.userid ?? status.source}`
  }
  return status.state === "signed-out"
    ? "Loomy 桌面端未登录：先在桌面端登录，或设置 LOOMY_SESSION"
    : `无法读取 Loomy 登录态：${status.detail}`
}
