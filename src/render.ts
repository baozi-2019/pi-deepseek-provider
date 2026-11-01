/**
 * Parsing and rendering for the DeepSeek balance response.
 *
 * Documented shape (https://api-docs.deepseek.com/api/get-user-balance):
 * - `is_available` (boolean) — whether the account has balance for API calls
 * - `balance_infos[]` — per-currency entries with `currency` ("CNY"|"USD")
 *   and decimal strings `total_balance`, `granted_balance`,
 *   `topped_up_balance`.
 *
 * Every field is treated as defensively optional: missing or malformed
 * fields render as `unavailable`; no zeros are ever fabricated.
 */

export interface DeepSeekBalanceEntry {
  currency: string
  total: string | null
  granted: string | null
  toppedUp: string | null
}

export interface DeepSeekBalanceSnapshot {
  /** null when `is_available` is absent or not a boolean. */
  available: boolean | null
  entries: DeepSeekBalanceEntry[]
}

const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

/** Balance amounts are decimal strings; anything else is treated as absent. */
function parseAmount(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return DECIMAL_PATTERN.test(trimmed) ? trimmed : null
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return String(value)
  }
  return null
}

function parseEntry(value: unknown): DeepSeekBalanceEntry | null {
  if (!isRecord(value)) return null
  const currency = typeof value.currency === "string" ? value.currency.trim() : ""
  if (!currency) return null
  return {
    currency,
    total: parseAmount(value.total_balance),
    granted: parseAmount(value.granted_balance),
    toppedUp: parseAmount(value.topped_up_balance),
  }
}

export function parseDeepSeekBalanceResponse(raw: unknown): DeepSeekBalanceSnapshot {
  const root = isRecord(raw) ? raw : null
  const entries: DeepSeekBalanceEntry[] = []
  if (Array.isArray(root?.balance_infos)) {
    for (const entry of root.balance_infos) {
      const parsed = parseEntry(entry)
      if (parsed) entries.push(parsed)
    }
  }
  return { available: parseBoolean(root?.is_available), entries }
}

function amountLabel(label: string, value: string | null): string {
  return `${label} ${value ?? "unavailable"}`
}

function entryLine(entry: DeepSeekBalanceEntry): string {
  const fields = [
    amountLabel("total", entry.total),
    amountLabel("granted", entry.granted),
    amountLabel("topped-up", entry.toppedUp),
  ]
  return `${entry.currency.padEnd(4)}${fields.join(" · ")}`
}

export function renderBalanceLines(snapshot: DeepSeekBalanceSnapshot): string[] {
  const status =
    snapshot.available === null
      ? "status unavailable"
      : snapshot.available
        ? "available"
        : "insufficient balance for API calls"
  const lines = [`DeepSeek balance: ${status}`]
  if (snapshot.entries.length === 0) {
    lines.push("  balance_infos unavailable")
  }
  for (const entry of snapshot.entries) {
    lines.push(`  ${entryLine(entry)}`)
  }
  return lines
}

export function renderBalanceText(snapshot: DeepSeekBalanceSnapshot): string {
  return renderBalanceLines(snapshot).join("\n")
}
