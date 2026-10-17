/**
 * Static fallback catalog for the WingWork (iKooky) provider.
 *
 * Used only before the first successful credential exchange, and as omp's
 * display fallback when the gateway is unreachable. The live roster always
 * replaces it, so this list only has to cover what the account can plausibly
 * select — stale ids here surface as an upstream `model_not_found`, never as a
 * silently wrong model.
 *
 * `wingwork-` is the account-facing prefix the gateway maps onto the real
 * upstream model (`wingwork-snt-4.6` → `claude-sonnet-4-6`), which is why the
 * ids look nothing like their backends.
 */

import type { WingWorkUpstreamModel } from "./upstream"

/** Conservative input window used until the account's roster advertises a real one. */
export const DEFAULT_CONTEXT_WINDOW = 200_000
/** Output ceiling accepted by every probed model on the gateway. */
export const DEFAULT_MAX_TOKENS = 64_000

function model(id: string, name: string): WingWorkUpstreamModel {
  return { id, name }
}

export const FALLBACK_WINGWORK_MODELS: readonly WingWorkUpstreamModel[] = [
  // Primary day-to-day model: first so it is the provider's default selection.
  model("wingwork-ds-v4.1-flash", "DeepSeek V4.1 Flash"),
  model("wingwork-ds-v4-pro-0813", "DeepSeek V4 Pro"),
  model("wingwork-ds-v4-flash-0731", "DeepSeek V4 Flash"),
  model("wingwork-snt-4.6", "Claude Sonnet 4.6"),
  model("wingwork-snt-5.5", "Claude Sonnet 5.5"),
  model("wingwork-os-5.5", "Claude Opus 5.5"),
  model("wingwork-os-5", "Claude Opus 5"),
  model("wingwork-os-4.8", "Claude Opus 4.8"),
  model("wingwork-gk-4.6", "Grok 4.6"),
  model("wingwork-qw-3.8-flash", "Qwen 3.8 Flash"),
  model("wingwork-km-k3", "Kimi K3"),
]
