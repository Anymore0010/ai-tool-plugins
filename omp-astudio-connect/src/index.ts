/**
 * omp-astudio-connect — bring AStudio (iFLYTEK "AstronClaw") desktop models
 * into omp with zero configuration.
 *
 * AStudio ships an Electron client, a bundled local server and an `acode`
 * agent kernel, but the model traffic itself goes straight from the account to
 * iFLYTEK's gateways and is signed with a token the client mints from the
 * signed-in account — nothing about that token is on disk. This extension
 * performs the same exchange and hands the result to omp as an ordinary
 * OpenAI-compatible provider:
 *
 *   omp ──▶ loopback shim (127.0.0.1, ephemeral) ──▶ account backend
 *           injects the minted bearer, routes per model
 *
 * Because the credential stays inside the shim, omp never sees the token that
 * bills the account: the provider is registered with a placeholder key and the
 * shim is the only holder of the real one. Nothing is written to disk — the
 * token lives in memory for the lifetime of the omp session and is re-minted
 * on demand.
 */

import type { ExtensionAPI, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent"
import { AstronShim, type ResolvedModel } from "./server"
import { AstronCredentialStore, describeStatus } from "./store"
import { AstronUpstreamClient, type AstronAccountSnapshot } from "./upstream"
import { DEFAULT_CONTEXT_WINDOW } from "./catalog"

/** Provider id omp shows in `/model` as `astudio/<model>`. */
export const ASTRON_PROVIDER = "astudio"

type Thinking = NonNullable<ProviderModelConfig["thinking"]>

/**
 * Compatibility for the account backends. They are OpenAI chat-completions
 * gateways with one quirk that matters: the thinking switch is Qwen-style
 * `enable_thinking`, not `reasoning_effort`. Measured on a live account,
 * `reasoning_effort` alone leaves GLM-5.2 / DeepSeek-V4-Pro / Kimi-K2.6
 * answering with no reasoning at all, while `enable_thinking: true` turns
 * reasoning on for every model on the account — so omp is told to speak that
 * dialect, and to read reasoning back out of `reasoning_content`.
 */
const ASTRON_COMPAT = {
  thinkingFormat: "qwen",
  qwenTemplateReasoningEffort: true,
  supportsReasoningEffort: true,
  reasoningContentField: "reasoning_content",
  supportsDeveloperRole: false,
  maxTokensField: "max_tokens",
} as const

/**
 * Thinking levels omp may offer. The gateways answer 200 for every standard
 * `reasoning_effort` value (`minimal` through `max`, measured), so the list is
 * omp's own vocabulary; only "off" and "high" mean anything different to them.
 * `Effort` is a string-valued const enum, so the cast is type-only.
 */
const ASTRON_THINKING = {
  mode: "effort",
  efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
  defaultLevel: "high",
} as unknown as Thinking

/**
 * Map a routable model to omp's provider model config.
 *
 * Image input is declared only where it was verified: the account's default
 * model accepted an image part (a 1x1 probe was rejected for its *resolution*,
 * not for being an image). The other backends never advertised it, and
 * declaring it would only move the failure from model selection to send time.
 */
function toProviderModel(model: ResolvedModel): ProviderModelConfig {
  return {
    id: model.slug,
    name: model.name,
    reasoning: true,
    thinking: ASTRON_THINKING,
    input: model.images ? ["text", "image"] : ["text"],
    // The account is billed in points against a plan, not per token, so there
    // is no USD price to report; the point balance is shown by the refresh
    // command instead.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.maxTokens,
    compat: ASTRON_COMPAT,
  }
}

export default async function astudioConnect(pi: ExtensionAPI): Promise<void> {
  pi.setLabel("AStudio Connect")

  const client = new AstronUpstreamClient()
  const store = new AstronCredentialStore(client)
  const shim = new AstronShim({ store, client })

  try {
    const port = await shim.listen()
    pi.registerProvider(ASTRON_PROVIDER, {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      api: "openai-completions",
      // The loopback shim owns the account token and ignores any inbound
      // credential header, so this literal is never validated — it only
      // satisfies omp's requirement that a provider defining `models` carries
      // an apiKey. Extension registration has no `auth: none` escape hatch.
      apiKey: "astudio-desktop",
      models: (await shim.models()).map(toProviderModel),
      // Runtime model discovery; omp bounds this to 15 s.
      fetchDynamicModels: async () => (await shim.models()).map(toProviderModel),
    })
    pi.registerCommand("astudio-refresh", {
      description: "重新交换 AStudio 凭据并强制拉取最新模型列表（绕过 omp 24h 动态发现缓存）",
      handler: async (_args, ctx) => {
        // Re-exchange first: the inference token is minted per desktop launch
        // and may have been rotated, and a fresh roster is the point of the
        // command. The provider keeps serving the previous roster meanwhile.
        store.invalidate()
        const before = new Set((await shim.models()).map(model => model.slug))
        const catalog = await store.catalog()
        if (catalog === undefined) {
          ctx.ui.notify(`无法刷新：${describeStatus(await store.status())}`, "error")
          return
        }
        try {
          // Strategy defaults to "online": unconditionally forces a live fetch.
          await ctx.modelRegistry.refreshProvider(ASTRON_PROVIDER)
        } catch (error: unknown) {
          ctx.ui.notify(
            `强刷失败：${error instanceof Error ? error.message : String(error)}（已保留现有模型）`,
            "error",
          )
          return
        }
        const status = await store.status()
        const account: AstronAccountSnapshot =
          status.state === "ready" ? await client.fetchAccount(status.session).catch(() => ({})) : {}
        const plan = account.planName === undefined ? "" : `，套餐 ${account.planName}`
        const points =
          account.balance === undefined
            ? ""
            : `，剩余积分 ${account.balance}${account.total === undefined ? "" : `/${account.total}`}`
        const after = await shim.models()
        const added = after.filter(model => !before.has(model.slug)).length
        ctx.ui.notify(
          added > 0
            ? `已刷新：共 ${after.length} 个模型${plan}${points}，本次新增 ${added} 个`
            : `已刷新：共 ${after.length} 个模型${plan}${points}，无新增`,
          "info",
        )
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    pi.logger.error("astudio-connect: shim failed to start", { error: message })
  }

  pi.on("session_shutdown", () => {
    shim.close()
  })
}
