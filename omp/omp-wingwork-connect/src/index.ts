/**
 * omp-wingwork-connect — bring iKooky (WingWork) desktop models into omp with
 * zero configuration, reusing the desktop app's own sign-in.
 *
 * The extension starts a loopback Anthropic-wire shim and registers it as the
 * `wingwork` provider with no apiKey/oauth. An extension provider without oauth
 * is selectable without any omp-side login or key — the Kooky credential lives
 * inside the shim. Select models in /model as `wingwork/<id>`
 * (e.g. wingwork/ds-v4.1-flash).
 *
 * Why Anthropic wire and not OpenAI: the gateway's `/api/llm/console/chat`
 * serves `/v1/messages` directly (the desktop app injects exactly that URL into
 * Claude Code), so the shim relays bytes instead of translating protocols, and
 * omp keeps native thinking, tool-use and prompt-cache behavior for free.
 *
 * For personal research/learning only: drives your own iKooky account on this
 * machine. Not affiliated with iFlytek / Kooky / WingWork.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent"
import { WingWorkUpstreamClient, type WingWorkUpstreamModel } from "./upstream"
import { WingWorkCredentialStore } from "./store"
import { WingWorkShim } from "./server"
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, FALLBACK_WINGWORK_MODELS } from "./catalog"

export const WINGWORK_PROVIDER = "wingwork"

type Thinking = NonNullable<ProviderModelConfig["thinking"]>
type Effort = Thinking["efforts"][number]

/**
 * Thinking metadata per model family.
 *
 * `adaptive` is the Anthropic adaptive-thinking wire (`thinking.type:
 * "adaptive"` + `output_config.effort`), `budget` is the classic
 * `thinking.type: "enabled"` + `budget_tokens` pair. Both were probed against
 * the live gateway; the adaptive family rejects `enabled` outright, and every
 * other model accepted both forms.
 *
 * `display` (summarized reasoning deltas) is gated on the same generation as
 * Anthropic's own rule: Opus 4.7+ / Sonnet 5.5. Older Claude rows omit it, and
 * the non-Claude backends ignore it.
 */
/**
 * `Effort` is a string-valued const enum in the catalog package, which this
 * plugin does not depend on directly, so the ladders are written as literals
 * and asserted to the metadata's own array type — the assertion still catches
 * a misspelled level, which plain `string[]` would not.
 */
const ADAPTIVE_FULL = ["low", "medium", "high", "xhigh", "max"] as Thinking["efforts"]
const ADAPTIVE_BASE = ["low", "medium", "high"] as Thinking["efforts"]

interface ModelTraits {
  /** Human name; falls back to the raw model id. */
  name?: string
  /** Adaptive thinking wire, when the backend requires it. */
  adaptive?: readonly Effort[]
  /** Whether adaptive `display: "summarized"` is accepted. */
  display?: boolean
  /** Announced as text-only; the gateway's non-Claude backends reject images. */
  textOnly?: boolean
}

/**
 * Traits of the model ids the account roster uses. `wingwork-` ids are opaque
 * account-facing aliases for the real upstream models (`wingwork-snt-4.6`
 * serves `claude-sonnet-4-6`), so the family has to be spelled out here — the
 * gateway does not report it.
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

/** Input ceiling observed on the shared gateway front, regardless of backend. */
const GATEWAY_CONTEXT_CEILING = 500_000

/**
 * Compatibility for the gateway's Anthropic surface. Only the fields where the
 * proxy demonstrably differs from the canonical API are set: server-side
 * compaction needs a signing endpoint this proxy does not expose, and long
 * (1 h) cache retention is not advertised here.
 */
const WINGWORK_COMPAT = {
  supportsServerCompaction: false,
  supportsLongCacheRetention: false,
} as const

/**
 * Map a raw roster row to the omp provider model config shape.
 *
 * The account roster only carries ids and aliases, so limits and thinking
 * metadata come from the local table; the roster's own window (when present)
 * wins over the conservative default.
 *
 * `contextWindow` never exceeds the front's ceiling: over-reporting makes omp
 * send a prompt the gateway rejects outright, while under-reporting only
 * compacts earlier. Without a roster-provided window the conservative default
 * stands, because a backend with a smaller native window would otherwise fail
 * mid-session.
 */
function toProviderModel(model: WingWorkUpstreamModel): ProviderModelConfig {
  const traits = MODEL_TRAITS[model.id] ?? {}
  const contextWindow =
    model.contextLimit === undefined
      ? DEFAULT_CONTEXT_WINDOW
      : Math.min(model.contextLimit, GATEWAY_CONTEXT_CEILING)
  const thinking =
    traits.adaptive === undefined
      ? undefined
      : {
          mode: "anthropic-adaptive" as const,
          efforts: traits.adaptive,
          ...(traits.display === true ? { supportsDisplay: true } : {}),
        }
  return {
    id: model.id,
    name: traits.name ?? model.name,
    reasoning: true,
    ...(thinking === undefined ? {} : { thinking }),
    input: traits.textOnly === true ? ["text"] : ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: WINGWORK_COMPAT,
  }
}

export default async function wingworkConnect(pi: ExtensionAPI): Promise<void> {
  pi.setLabel("WingWork Connect")

  const client = new WingWorkUpstreamClient()
  const store = new WingWorkCredentialStore(client)
  const shim = new WingWorkShim({ store, fallbackModels: FALLBACK_WINGWORK_MODELS })

  try {
    const port = await shim.listen()
    pi.registerProvider(WINGWORK_PROVIDER, {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      api: "anthropic-messages",
      // The loopback shim owns the Kooky credential (re-exchanged from the
      // desktop app's sign-in) and ignores any inbound credential header, so
      // this literal is never validated — it only satisfies omp's runtime
      // requirement that a provider defining `models` carries apiKey or oauth
      // (extension registration has no `auth: none` escape hatch).
      apiKey: "wingwork-desktop",
      models: FALLBACK_WINGWORK_MODELS.map(toProviderModel),
      // Runtime model discovery; omp bounds this to 15 s.
      fetchDynamicModels: async () => (await shim.dynamicModels()).map(toProviderModel),
    })
    pi.registerCommand("wingwork-refresh", {
      description: "重新交换 iKooky 凭据并强制拉取最新模型列表（绕过 omp 24h 动态发现缓存）",
      handler: async (_args, ctx) => {
        const status = await store.status()
        if (status.state !== "ready") {
          ctx.ui.notify(
            status.state === "signed-out"
              ? "iKooky (WingWork) 未登录，无法刷新（先登录桌面版，或设置 WINGWORK_ACCESS_TOKEN）"
              : status.state === "unreadable"
                ? `无法读取 iKooky 登录态：${status.detail}`
                : `凭据交换失败：${status.detail}`,
            "error",
          )
          return
        }
        const before = new Set(shim.currentModels().map(model => model.id))
        // Re-exchange first: the minted key is shared with the desktop app and
        // may have been rotated, and a fresh roster is the point of the command.
        store.invalidate()
        const fresh = await store.config()
        if (fresh === undefined || fresh.models.length === 0) {
          ctx.ui.notify(
            `iKooky 上游未返回模型列表，已保留现有 ${before.size} 个模型`,
            "warning",
          )
          return
        }
        try {
          // Strategy defaults to "online": unconditionally forces a live fetch.
          await ctx.modelRegistry.refreshProvider(WINGWORK_PROVIDER)
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.ui.notify(`强刷失败：${message}（已保留现有模型）`, "error")
          return
        }
        const after = new Set(shim.currentModels().map(model => model.id))
        const added = [...after].filter(id => !before.has(id)).length
        ctx.ui.notify(
          added > 0
            ? `已刷新：共 ${after.size} 个模型（${fresh.baseUrl}），本次新增 ${added} 个`
            : `已刷新：共 ${after.size} 个模型（${fresh.baseUrl}），无新增`,
          "info",
        )
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    pi.logger.error("wingwork-connect: shim failed to start", { error: message })
  }

  pi.on("session_shutdown", () => {
    shim.close()
  })
}
