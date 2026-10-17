/**
 * Static fallback catalogue for the Loomy provider.
 *
 * Used only until `GET {base}/models` answers, and as omp's display fallback
 * when the account cannot be read. The live catalogue is server-controlled and
 * always replaces this, so this list only has to make the picker usable — a
 * stale id surfaces as an upstream error, never as a silently wrong model.
 *
 * The entries are the account's chat models as the platform reports them,
 * including the points multiplier the platform prints inside the display name.
 */

import type { LoomyModel } from "./upstream"

/** Input ceiling used when the catalogue does not size a model. */
export const DEFAULT_CONTEXT_WINDOW = 128_000
/** Output ceiling used when the catalogue does not size a model. */
export const DEFAULT_MAX_TOKENS = 32_768

/** Levels the platform advertises for every chat model it serves today. */
const EFFORTS = ["none", "low", "medium", "high", "xhigh"]

function model(
  id: string,
  name: string,
  contextLength: number,
  maxOutputTokens: number,
  rate: number,
  vision: boolean,
): LoomyModel {
  return {
    id,
    name,
    object: "model",
    type: "chat",
    protocol: "openai_chat",
    contextLength,
    maxOutputTokens,
    reasoningEfforts: EFFORTS,
    defaultReasoningEffort: "low",
    reasoning: true,
    vision,
    functionCalling: true,
    streaming: true,
    inputModalities: vision ? ["text", "image"] : ["text"],
    rate,
    isDefault: id === "DeepSeek-V4.1-Flash",
    isDefaultSmall: id === "qwen3.8-flash",
  }
}

export const FALLBACK_LOOMY_MODELS: readonly LoomyModel[] = [
  model("DeepSeek-V4.1-Flash", "DeepSeek V4.1 Flash", 1_048_576, 384_000, 2.0, true),
  model("deepseek-v4-flash-0731", "DeepSeek V4 Flash 0731", 1_048_576, 384_000, 3.0, false),
  model("MiniMax-M3", "MiniMax M3", 1_048_576, 512_000, 4.0, true),
  model("Kimi-k2.6", "Kimi k2.6", 262_144, 65_536, 6.5, true),
  model("qwen-3.8-max", "Qwen 3.8 Max", 1_000_000, 65_536, 12.0, false),
  model("GLM-5.3-Flash", "GLM 5.3 Flash", 1_048_576, 131_072, 0.8, true),
  model("qwen3.8-flash", "qwen 3.8 flash", 1_000_000, 131_072, 0.8, true),
  model("spark-x", "Spark-X2.5", 1_048_576, 65_536, 0, false),
  model("mimo-v2.5", "MiMo V2.5", 1_048_576, 131_072, 3.3, true),
  model("auto", "自动 · 均衡", DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, 0, false),
]
