/**
 * Loopback OpenAI-compatible shim for the AStudio provider.
 *
 * The account's inference API is already OpenAI chat-completions shaped, so the
 * shim is a credential injector and model router, not a protocol translator:
 * the request body passes through untouched (only `model` is rewritten to the
 * wire id) and SSE frames are forwarded without reframing. What it adds is the
 * routing the provider config cannot express — every model on the account has
 * its **own** base URL (the MaaS gateway for GLM / DeepSeek / Kimi / Qwen /
 * MiniMax / Spark-Agent, the open Spark gateway for the legacy `spark-x` id) —
 * plus the per-account bearer token, which the shim keeps out of omp entirely.
 *
 * The server binds only to 127.0.0.1 on an ephemeral port.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { describeStatus, type AstronCredentialStore } from "./store"
import type { AstronModelCatalog, AstronModelConfig, AstronUpstreamClient } from "./upstream"
import { DEFAULT_MAX_TOKENS, FALLBACK_ASTRON_MODELS, FALLBACK_BASE_URLS, findModelSpec } from "./catalog"

export interface AstronShimOptions {
  store: AstronCredentialStore
  client: AstronUpstreamClient
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
  // The shim owns the account token: never let a caller-supplied one through.
  authorization: true,
  "x-api-key": true,
}

/** A roster entry plus the metadata the studio API does not publish. */
export interface ResolvedModel {
  /** Wire id: what the request body must carry. */
  slug: string
  /** Name the desktop app shows. */
  name: string
  baseUrl: string
  apiKey: string
  maxTokens: number
  images: boolean
}

/**
 * Turn one roster row into a routable model. Limits come from the static
 * catalog: the roster is authoritative for which models exist and where they
 * live, but it carries no token bounds.
 */
export function resolveModel(model: AstronModelConfig): ResolvedModel {
  const spec = findModelSpec(model.slug)
  return {
    slug: model.slug,
    name: model.name,
    baseUrl: model.baseUrl,
    apiKey: model.apiKey,
    maxTokens: spec?.maxTokens ?? DEFAULT_MAX_TOKENS,
    images: spec?.images === true,
  }
}

/** The static roster, shaped like a resolved one, for the un-signed-in case. */
function fallbackModels(): ResolvedModel[] {
  return FALLBACK_ASTRON_MODELS.map((spec) => ({
    slug: spec.slug,
    name: spec.name,
    baseUrl: FALLBACK_BASE_URLS[spec.provider] ?? "",
    apiKey: "",
    maxTokens: spec.maxTokens,
    images: spec.images === true,
  }))
}

export class AstronShim {
  private server: Server | undefined
  private port = 0

  constructor(private readonly options: AstronShimOptions) {}

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
      void this.options.store.catalog()
    })
    return promise
  }

  close(): void {
    this.server?.close()
  }

  /**
   * The roster omp should show. Falls back to the static catalog so the model
   * picker is populated before the account is reachable — an empty list would
   * look like "this account has no models".
   */
  async models(): Promise<readonly ResolvedModel[]> {
    const catalog = await this.options.store.catalog()
    return catalog === undefined ? fallbackModels() : catalog.models.map(resolveModel)
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
      id: model.slug,
      object: "model",
      created: 0,
      owned_by: "astudio",
      ...(model.name === model.slug ? {} : { name: model.name }),
    }))
    this.sendJson(res, 200, { object: "list", data })
  }

  private async handleStatus(res: ServerResponse): Promise<void> {
    const status = await this.options.store.status()
    if (status.state !== "ready") {
      this.sendJson(res, 200, {
        provider: "astudio",
        state: status.state,
        ...(status.state === "signed-out" ? {} : { detail: status.detail }),
      })
      return
    }
    const account = await this.options.client.fetchAccount(status.session).catch(() => ({}))
    this.sendJson(res, 200, {
      provider: "astudio",
      state: "ready",
      source: status.source,
      account: status.session.nickname ?? status.session.accountId ?? null,
      models: status.catalog.models.length,
      ...account,
    })
  }


  /**
   * Match a requested model id against the account roster. omp sends the ids
   * this extension registered (the wire slugs), but a client configured with
   * the desktop app's display name or studio id is accepted too: the backend
   * rejects anything that is not the exact wire id with an opaque 10404, so
   * resolving the common aliases here turns a dead end into a working request.
   */
  private routeFor(catalog: AstronModelCatalog, requested: string): ResolvedModel | undefined {
    const wanted = requested.trim().toLowerCase()
    const entry = catalog.models.find(
      (model) =>
        model.slug.toLowerCase() === wanted ||
        model.name.toLowerCase() === wanted ||
        model.id.toLowerCase() === wanted,
    )
    if (entry !== undefined) return resolveModel(entry)
    // The account roster is the authoritative list, but it is narrower than
    // what the gateways actually serve: the bund(led kernel's own model list
    // offers ids the roster omits (e.g. `spark-x2.5`, verified answering on
    // MaaS with this account's key). Routing those to their family gateway is
    // better than refusing them — an id the backend cannot serve gets the
    // gateway's own explanation instead of this shim's 404.
    const spec = findModelSpec(requested)
    if (spec === undefined) return undefined
    return {
      slug: spec.slug,
      name: spec.name,
      baseUrl: FALLBACK_BASE_URLS[spec.provider] ?? "",
      apiKey: catalog.apiKey,
      maxTokens: spec.maxTokens,
      images: spec.images === true,
    }
  }

  private async handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await this.readBody(req)
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.toString("utf8"))
    } catch {
      this.sendJson(res, 400, {
        error: { type: "invalid_request_error", message: "request body is not JSON" },
      })
      return
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.sendJson(res, 400, {
        error: { type: "invalid_request_error", message: "request body must be a JSON object" },
      })
      return
    }
    const body = parsed as Record<string, unknown>
    const requested = typeof body.model === "string" ? body.model.trim() : ""
    if (requested === "") {
      this.sendJson(res, 400, {
        error: { type: "invalid_request_error", message: "request body has no model" },
      })
      return
    }

    let catalog = await this.options.store.catalog()
    let route = catalog === undefined ? undefined : this.routeFor(catalog, requested)
    if (route === undefined) {
      // The roster is account-specific and may have gained the model since it
      // was cached, so re-mint once before rejecting.
      this.options.store.invalidate()
      catalog = await this.options.store.catalog()
      route = catalog === undefined ? undefined : this.routeFor(catalog, requested)
    }
    if (catalog === undefined) {
      this.sendJson(res, 401, {
        error: { type: "authentication_error", message: describeStatus(await this.options.store.status()) },
      })
      return
    }
    if (route === undefined) {
      this.sendJson(res, 404, {
        error: {
          type: "invalid_request_error",
          message: `账号里没有模型 ${requested}；可用：${catalog.models.map((entry) => entry.slug).join(", ")}`,
        },
      })
      return
    }

    // First attempt, then one re-mint: the inference token is minted per
    // desktop launch, so signing out or a rotation invalidates it, and
    // re-minting costs one small GET.
    const payload = JSON.stringify({ ...body, model: route.slug })
    let response = await this.forward(payload, req, res, route)
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {})
      this.options.store.invalidate()
      const refreshed = await this.options.store.catalog()
      const retry = refreshed === undefined ? undefined : this.routeFor(refreshed, requested)
      if (retry === undefined) {
        this.sendJson(res, 401, {
          error: {
            type: "authentication_error",
            message: "AStudio 凭据失效且重新交换失败，请在 AStudio 桌面端重新登录",
          },
        })
        return
      }
      response = await this.forward(payload, req, res, retry)
    }
    await this.relay(response, res)
  }

  private async forward(
    body: string,
    req: IncomingMessage,
    res: ServerResponse,
    model: ResolvedModel,
  ): Promise<Response> {
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      const lower = name.toLowerCase()
      if (DROPPED_REQUEST_HEADERS[lower] === true) continue
      headers[lower] = Array.isArray(value) ? value.join(", ") : value
    }
    headers["content-type"] = "application/json"
    headers.authorization = `Bearer ${model.apiKey}`
    // Abort the upstream call only when the *client* goes away mid-response;
    // `req.destroyed` is already true once the body has been consumed, so it
    // cannot be used as the liveness check.
    const controller = new AbortController()
    const onClose = () => {
      if (!res.writableFinished) controller.abort()
    }
    res.on("close", onClose)
    try {
      return await fetch(`${model.baseUrl}/chat/completions`, {
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
