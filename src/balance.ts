/**
 * HTTP client for the DeepSeek balance endpoint.
 *
 * `GET {apiRoot}/user/balance` with `Authorization: Bearer <key>`.
 * Documented at https://api-docs.deepseek.com/api/get-user-balance:
 *
 *   { is_available: boolean, balance_infos: [{ currency, total_balance,
 *     granted_balance, topped_up_balance }] }
 *
 * Every caller-visible failure is normalized into a typed error with a
 * sanitized message that never contains the key.
 */

import { apiRoot } from "./credentials.ts"

export const DEEPSEEK_BALANCE_PATH = "/user/balance"
export const DEEPSEEK_BALANCE_TIMEOUT_MS = 10_000
export const DEEPSEEK_BALANCE_THROTTLE_MS = 5_000

export type DeepSeekBalanceErrorKind = "config" | "http" | "timeout" | "network"

export type DeepSeekBalanceResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { kind: DeepSeekBalanceErrorKind; message: string } }

export interface FetchDeepSeekBalanceOptions {
  apiKey: string
  apiBase?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/** Strip credential-shaped values from text surfaced to the user. */
export function redactSensitiveText(text: string, apiKey?: string): string {
  let out = text
  if (apiKey) out = out.split(apiKey).join("[redacted]")
  return out
    .replace(/Bearer\s+\S{8,}/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function httpErrorMessage(status: number, statusText: string): string {
  if (status === 401 || status === 403) {
    return `DeepSeek rejected the API key (HTTP ${status}). Run /login to refresh the deepseek credential, or check DEEPSEEK_API_KEY.`
  }
  if (status === 429) {
    return "DeepSeek rate limited the balance request (HTTP 429). Try again in a moment."
  }
  return `DeepSeek balance request failed (HTTP ${status}${statusText ? ` ${statusText}` : ""}).`
}

export async function fetchDeepSeekBalance(
  options: FetchDeepSeekBalanceOptions,
): Promise<DeepSeekBalanceResult> {
  if (!options.apiKey) {
    return { ok: false, error: { kind: "config", message: "No DeepSeek API key configured" } }
  }

  const base = (options.apiBase ?? apiRoot()).replace(/\/+$/, "")
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEEPSEEK_BALANCE_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(`${base}${DEEPSEEK_BALANCE_PATH}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.apiKey}`,
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      return {
        ok: false,
        error: { kind: "http", message: httpErrorMessage(response.status, response.statusText) },
      }
    }
    try {
      return { ok: true, data: (await response.json()) as unknown }
    } catch {
      return {
        ok: false,
        error: { kind: "http", message: "DeepSeek returned an unreadable balance response" },
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        ok: false,
        error: {
          kind: "timeout",
          message: `DeepSeek balance request timed out after ${timeoutMs}ms. Check your network and try again.`,
        },
      }
    }
    return {
      ok: false,
      error: {
        kind: "network",
        message: redactSensitiveText(
          `Failed to reach the DeepSeek balance endpoint: ${errorMessage(error)}`,
          options.apiKey,
        ),
      },
    }
  } finally {
    clearTimeout(timer)
  }
}

export type BalanceThrottleSlot = { allowed: true } | { allowed: false; retryAfterMs: number }

/**
 * Manual-refresh throttle: at most one fetch per `intervalMs`. There is no
 * result caching — a throttled call is refused, not served stale data.
 */
export function createBalanceThrottle(
  intervalMs: number = DEEPSEEK_BALANCE_THROTTLE_MS,
  now: () => number = Date.now,
): { tryAcquire: () => BalanceThrottleSlot } {
  let lastAt = Number.NEGATIVE_INFINITY
  return {
    tryAcquire() {
      const current = now()
      const elapsed = current - lastAt
      if (elapsed < intervalMs) {
        return { allowed: false, retryAfterMs: intervalMs - elapsed }
      }
      lastAt = current
      return { allowed: true }
    },
  }
}
