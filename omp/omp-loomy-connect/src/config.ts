/**
 * Where Loomy's live install says its services are.
 *
 * Both are readable from the app's own state, which beats hard-coding: the
 * desktop writes the inference base it actually uses into the OpenCode config
 * it deploys (so a test-channel build points somewhere else), and the points
 * base into its own points store. The compiled defaults are only the fallback
 * for a machine that has never run the app.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { configRoots } from "./auth"
import { DEFAULT_API_BASE, DEFAULT_POINTS_BASE, resolveApiBase } from "./upstream"

/** Overrides the points service base. */
const POINTS_BASE_ENV = "LOOMY_POINTS_BASE"

function readJson(path: string): unknown {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

/**
 * The inference base the desktop app is using: the environment override first,
 * then the provider entry in the deployed OpenCode config, then production.
 */
export function liveApiBase(): string {
  const override = resolveApiBase()
  if (override !== DEFAULT_API_BASE) return override
  for (const root of configRoots()) {
    const config = asRecord(readJson(join(root, "opencode", "opencode.json")))
    const providers = asRecord(config?.provider)
    for (const provider of Object.values(providers ?? {})) {
      const options = asRecord(asRecord(provider)?.options)
      const baseUrl = asText(options?.baseURL)
      if (baseUrl !== undefined) return baseUrl.replace(/\/+$/u, "")
    }
  }
  return DEFAULT_API_BASE
}

/**
 * The points service.
 *
 * The inference origin wins over the stored `points-config.json`: those are two
 * independent settings, and a machine can hold a points base for a *different*
 * environment than the session it is signed in with (the stored one here points
 * at the integration environment, whose service rejects the production
 * session). Points live on the same host as inference in practice, so that is
 * the trustworthy default.
 */
export function livePointsBase(): string {
  const override = process.env[POINTS_BASE_ENV]?.trim()
  if (override !== undefined && override !== "") return override.replace(/\/+$/u, "")
  try {
    return new URL(liveApiBase()).origin
  } catch {
    // A malformed base falls through to the stored setting.
  }
  for (const root of configRoots()) {
    const config = asRecord(readJson(join(root, "userData", "points-config.json")))
    const baseUrl = asText(config?.baseUrl)
    if (baseUrl !== undefined) return baseUrl.replace(/\/+$/u, "")
  }
  return DEFAULT_POINTS_BASE
}
