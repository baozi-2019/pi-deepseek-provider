/**
 * DeepSeek credential resolution for the `deepseek` provider.
 *
 * The API key is read from (in priority order):
 * 1. the `DEEPSEEK_API_KEY` environment variable,
 * 2. pi's credential store (`auth.json` in the agent directory —
 *    `$PI_CODING_AGENT_DIR` or `~/.pi/agent`), entry `deepseek`, written by
 *    `/login` (pi's built-in API-key login flow) as `{ type: "api_key", key }`.
 *
 * The provider id is `deepseek`: the extension composes over pi's built-in
 * provider, so the auth entry and the env var stay the same as the built-in
 * integration. No other entry is consulted.
 *
 * The key must never be written to logs, messages, fixtures, or any other
 * output.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const DEEPSEEK_PROVIDER = "deepseek"
export const DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY"

type EnvLike = Record<string, string | undefined>

export interface DeepSeekCredentialsOptions {
  env?: EnvLike
  /** pi agent directory that contains auth.json (defaults from env/home). */
  agentDir?: string
}

export function defaultAgentDir(env: EnvLike): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim()
  return configured ? configured : join(homedir(), ".pi", "agent")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Resolve the DeepSeek API key. Returns `undefined` when no credential is
 * configured; never throws on a missing or corrupt auth.json.
 */
export function getDeepSeekApiKey(options: DeepSeekCredentialsOptions = {}): string | undefined {
  const env = options.env ?? process.env
  const envKey = nonEmptyString(env[DEEPSEEK_API_KEY_ENV])
  if (envKey) return envKey

  const authPath = join(options.agentDir ?? defaultAgentDir(env), "auth.json")
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(authPath, "utf-8"))
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const entry = parsed[DEEPSEEK_PROVIDER]
  if (!isRecord(entry)) return undefined
  // pi's /login stores { type: "api_key", key } for this provider.
  return nonEmptyString(entry.key)
}

export const DEFAULT_DEEPSEEK_API_BASE = "https://api.deepseek.com"
export const DEEPSEEK_API_BASE_ENV = "DEEPSEEK_API_BASE"

/**
 * Resolve the API root (no trailing slash, no path). Chat completions, the
 * model list, and the balance endpoint all hang directly below this root.
 */
export function apiRoot(env: EnvLike = process.env): string {
  const override = nonEmptyString(env[DEEPSEEK_API_BASE_ENV])
  return (override ?? DEFAULT_DEEPSEEK_API_BASE).replace(/\/+$/, "")
}
