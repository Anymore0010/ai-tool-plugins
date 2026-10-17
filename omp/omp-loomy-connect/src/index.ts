/**
 * omp-loomy-connect — bring Loomy desktop models into omp with zero
 * configuration.
 *
 * Loomy signs in to the iFLYTEK account service and keeps the resulting
 * **account session token** in a plain `electron-store` file; that same token
 * is what every model request carries, so there is no exchange to perform and
 * no key to mint. This extension reads the store (never writes it), and hands
 * the account to omp as an ordinary OpenAI-compatible provider:
 *
 *   omp ──▶ loopback shim (127.0.0.1, ephemeral) ──▶ Loomy iModel
 *           injects the session + a fresh traceparent
 *
 * Two Loomy-specific details are handled inside the shim rather than leaked
 * into omp: the session is sent as **both** `token` and `Authorization:
 * Bearer` (its surfaces disagree on which they read), and every request gets a
 * fresh **`traceparent`** — without one the platform hangs a chat call until
 * the client times out.
 */

import type { ExtensionAPI, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent"
import { LoomyShim, describeStatus } from "./server"
import { LoomyCredentialStore } from "./store"
import { LoomyUpstreamClient, type LoomyAccountSnapshot, type LoomyModel } from "./upstream"
import { liveApiBase, livePointsBase } from "./config"
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from "./catalog"

/** Provider id omp shows in `/model` as `loomy/<model>`. */
export const LOOMY_PROVIDER = "loomy"

type Thinking = NonNullable<ProviderModelConfig["thinking"]>

/**
 * Compatibility for the Loomy gateway.
 *
 * It speaks the Qwen dialect for thinking — `enable_thinking` — and also
 * honours `reasoning_effort`; the catalogue advertises the levels it accepts
 * (`none`, `low`, `medium`, `high`, `xhigh`) and a default per model. Sending
 * both is what the desktop app does, and reasoning comes back in
 * `reasoning_content`.
 */
const LOOMY_COMPAT = {
  thinkingFormat: "qwen",
  qwenTemplateReasoningEffort: true,
  supportsReasoningEffort: true,
  reasoningContentField: "reasoning_content",
  supportsDeveloperRole: false,
  maxTokensField: "max_tokens",
} as const

/**
 * The levels the catalogue advertises, in omp's vocabulary. `none` is left out
 * on purpose: omp expresses "thinking off" by disabling reasoning rather than
 * by selecting a level, and the disable path already sends the switch.
 */
const LOOMY_EFFORTS = ["low", "medium", "high", "xhigh"] as Thinking["efforts"]

/** omp's level names that the catalogue may also advertise under its own. */
function effortsOf(model: LoomyModel): Thinking["efforts"] {
  const announced = new Set(model.reasoningEfforts)
  const usable = LOOMY_EFFORTS.filter((effort) => announced.size === 0 || announced.has(effort))
  return usable.length > 0 ? usable : LOOMY_EFFORTS
}

/** The catalogue's default level, when omp's vocabulary has it. */
function defaultLevelOf(model: LoomyModel): Thinking["defaultLevel"] {
  const level = model.defaultReasoningEffort
  if (level === undefined) return "low" as Thinking["defaultLevel"]
  return (LOOMY_EFFORTS.includes(level as Thinking["efforts"][number]) ? level : "low") as Thinking["defaultLevel"]
}

/**
 * Map a catalogue row to omp's provider model config.
 *
 * Limits come from the platform, which publishes both `context_length` and
 * `max_output_tokens`; the conservative defaults only stand in for a row that
 * omits them. Image input is declared from the platform's own
 * `input_modalities`, and the points multiplier is surfaced in the name rather
 * than as a USD cost, because the account is billed in points.
 */
function toProviderModel(model: LoomyModel): ProviderModelConfig {
  const multiplier = model.rate === undefined || model.rate === 0 ? "" : ` · x${model.rate}`
  return {
    id: model.id,
    name: `${model.name}${multiplier}`,
    reasoning: model.reasoning,
    ...(model.reasoning
      ? {
          thinking: {
            mode: "effort" as const,
            efforts: effortsOf(model),
            defaultLevel: defaultLevelOf(model),
          },
        }
      : {}),
    input: model.vision ? ["text", "image"] : ["text"],
    // The account is billed in points against a plan, not per token, so there
    // is no USD price to report; the multiplier is in the name.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextLength ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    compat: LOOMY_COMPAT,
  }
}

export default async function loomyConnect(pi: ExtensionAPI): Promise<void> {
  pi.setLabel("Loomy Connect")

  const client = new LoomyUpstreamClient()
  const store = new LoomyCredentialStore(client)
  const shim = new LoomyShim({ store, client })

  try {
    const port = await shim.listen()
    pi.registerProvider(LOOMY_PROVIDER, {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      api: "openai-completions",
      // The loopback shim owns the account session and ignores any inbound
      // credential header, so this literal is never validated — it only
      // satisfies omp's requirement that a provider defining `models` carries
      // an apiKey. Extension registration has no `auth: none` escape hatch.
      apiKey: "loomy-desktop",
      models: (await shim.models()).map(toProviderModel),
      // Runtime model discovery; omp bounds this to 15 s.
      fetchDynamicModels: async () => (await shim.models()).map(toProviderModel),
    })
    pi.registerCommand("loomy-refresh", {
      description: "重新读取 Loomy 登录态与模型列表，并强制刷新（绕过 omp 24h 动态发现缓存）",
      handler: async (_args, ctx) => {
        store.invalidate()
        const before = new Set((await shim.models()).map(model => model.id))
        const models = await store.catalog()
        if (models === undefined) {
          ctx.ui.notify(`无法刷新：${describeStatus(store.status())}`, "error")
          return
        }
        try {
          // Strategy defaults to "online": unconditionally forces a live fetch.
          await ctx.modelRegistry.refreshProvider(LOOMY_PROVIDER)
        } catch (error: unknown) {
          ctx.ui.notify(
            `强刷失败：${error instanceof Error ? error.message : String(error)}（已保留现有模型）`,
            "error",
          )
          return
        }
        const status = store.status()
        const account: LoomyAccountSnapshot =
          status.state === "ready"
            ? await client.fetchBalance(status.credential, livePointsBase()).catch(() => ({}))
            : {}
        const points = describePoints(account)
        const after = await shim.models()
        const added = after.filter(model => !before.has(model.id)).length
        ctx.ui.notify(
          added > 0
            ? `已刷新：共 ${after.length} 个模型${points}（${liveApiBase()}），本次新增 ${added} 个`
            : `已刷新：共 ${after.length} 个模型${points}（${liveApiBase()}），无新增`,
          "info",
        )
      },
    })

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    pi.logger.error("loomy-connect: shim failed to start", { error: message })
  }

  pi.on("session_shutdown", () => {
    shim.close()
  })
}

/**
 * The points line for the refresh notice.
 *
 * Loomy keeps two pools: a **daily** one (the platform's free allowance,
 * refilled every day) and a **long-term** one (earned from tasks or a reset,
 * with no ceiling). Neither publishes a total, so both ratios are against what
 * the account's own ledger says the pool has held — each shown only when the
 * rows it needs were read.
 */
function describePoints(account: LoomyAccountSnapshot): string {
  if (account.available === undefined) return ""
  const parts = [`剩余 ${account.available} 分`]
  if (account.dailyBalance !== undefined && account.grant !== undefined && account.grant > 0) {
    const used = account.consumed ?? account.grant - account.dailyBalance
    parts.push(`每日 ${account.dailyBalance}/${account.grant}（${Math.round((used / account.grant) * 100)}%）`)
  } else if (account.dailyBalance !== undefined) {
    parts.push(`每日 ${account.dailyBalance}`)
  }
  if (account.balance !== undefined && account.longEarned !== undefined && account.longEarned > 0) {
    const spent = account.longSpent ?? account.longEarned - account.balance
    parts.push(`长期 ${account.balance}/${account.longEarned}（${Math.round((spent / account.longEarned) * 100)}%）`)
  } else if (account.balance !== undefined) {
    parts.push(`长期 ${account.balance}`)
  }
  return `，${parts.join("，")}`
}
