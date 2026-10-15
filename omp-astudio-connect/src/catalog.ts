/**
 * Static AStudio model metadata.
 *
 * The account roster (`bot/models/configs`) carries ids, names and base URLs
 * but no limits, so the limits live here. Two rules keep this table honest:
 *
 * - **Output caps are measured, not guessed.** Every MaaS backend rejects an
 *   over-sized `max_tokens` with `'max_tokens' value must be less or equal
 *   than N`, which is how the numbers below were obtained. Reporting the true
 *   bound matters because omp sends the value verbatim: over-reporting fails
 *   the request outright, while under-reporting only compacts earlier.
 * - **Context windows are deliberately conservative.** No endpoint publishes
 *   them, so 200 k stands in for every model. Under-reporting costs an earlier
 *   compaction; over-reporting would make omp build a prompt the gateway
 *   rejects.
 *
 * This table is only a fallback: the live roster replaces it as soon as the
 * studio API answers, and the fallback names/limits are re-applied on top.
 */

/** Fallback output-token budget for models whose bound could not be measured. */
export const DEFAULT_MAX_TOKENS = 32_768
/** Conservative input ceiling for every model (see the note above). */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/**
 * OpenAI-compatible base URL per backend family, used only until the live
 * roster supplies the per-model URL. `maas` is the iFLYTEK MaaS gateway, which
 * serves GLM / DeepSeek / Kimi / Qwen / MiniMax / Spark-Agent; `iflytek` is the
 * open Spark gateway, which serves the older `spark-x` endpoint.
 */
export const FALLBACK_BASE_URLS: Record<string, string> = {
  maas: "https://maas-api.cn-huabei-1.xf-yun.com/v2",
  iflytek: "https://spark-api-open.xf-yun.com/agent/v1",
}

/** Per-model metadata the roster does not carry. */
export interface AstronModelSpec {
  /** Id inference expects in the request body. */
  slug: string
  /** Name the desktop app shows. */
  name: string
  /** Backend family, used to pick a fallback base URL. */
  provider: string
  /** Measured `max_tokens` bound, or `DEFAULT_MAX_TOKENS` when unmetered. */
  maxTokens: number
  /** The model accepts image parts (verified for the account's default model only). */
  images?: boolean
}

/**
 * The roster a fresh install sees, captured from a live production account.
 * A signed-in account's own list always wins over this.
 */
export const FALLBACK_ASTRON_MODELS: readonly AstronModelSpec[] = [
  { slug: "astronclaw-auto", name: "Auto", provider: "maas", maxTokens: 393_216, images: true },
  { slug: "xsparkx2agent", name: "Spark-X2-Agent", provider: "maas", maxTokens: DEFAULT_MAX_TOKENS },
  { slug: "spark-x", name: "Spark-X2-Flash", provider: "iflytek", maxTokens: DEFAULT_MAX_TOKENS },
  { slug: "spark-x2.5", name: "Spark-X2.5", provider: "maas", maxTokens: DEFAULT_MAX_TOKENS },
  { slug: "spark-x2.6-preview", name: "Spark-X2.6-Preview", provider: "maas", maxTokens: DEFAULT_MAX_TOKENS },
  { slug: "xopglm52", name: "GLM-5.2", provider: "maas", maxTokens: 131_072 },
  { slug: "xopglm51", name: "GLM-5.1", provider: "maas", maxTokens: 131_072 },
  { slug: "xminimaxm25", name: "MiniMax-M2.5", provider: "maas", maxTokens: 131_072 },
  { slug: "xopkimik26", name: "Kimi-K2.6", provider: "maas", maxTokens: 131_072 },
  { slug: "xopqwen36v35b", name: "Qwen3.6-35B-A3B", provider: "maas", maxTokens: 131_072 },
  { slug: "xopdeepseekv4pro", name: "DeepSeek-V4-Pro", provider: "maas", maxTokens: 393_216 },
  { slug: "xopdeepseekv4pro0813", name: "DeepSeek-V4-Pro", provider: "maas", maxTokens: 393_216 },
  { slug: "xopdsv4flash0731in", name: "DeepSeek-V4-Flash", provider: "maas", maxTokens: DEFAULT_MAX_TOKENS },
]

/**
 * Look up fallback metadata by wire id.
 *
 * The live roster is authoritative for *which* models exist; this only fills in
 * limits. An id the account has that this table has never seen keeps the
 * conservative defaults and the name the roster supplied.
 */
export function findModelSpec(slug: string): AstronModelSpec | undefined {
  const exact = FALLBACK_ASTRON_MODELS.find((spec) => spec.slug === slug)
  if (exact !== undefined) return exact
  const lower = slug.toLowerCase()
  return FALLBACK_ASTRON_MODELS.find((spec) => spec.slug.toLowerCase() === lower)
}
