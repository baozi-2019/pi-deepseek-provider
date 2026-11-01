/**
 * Model catalog for the `deepseek` provider.
 *
 * The static catalog mirrors the official DeepSeek documentation
 * (https://api-docs.deepseek.com/):
 * - `deepseek-flash`  → DeepSeek-V4.1-Flash-1017 (text + image, off/low/high/max)
 * - `deepseek-v4-pro` → DeepSeek-V4-Pro-0813 (text, off/high/max)
 * - `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` — retired legacy
 *   names still accepted upstream, served by DeepSeek-V4.1-Flash at Flash
 *   pricing.
 *
 * `/deepseek-refresh` (and pi's own model refresh) tries the documented
 * OpenAI-style `GET {base}/models` endpoint, which returns capability
 * metadata (context window, max output tokens, input modalities, effort
 * levels). Remote ids unknown to the static catalog get a conservative
 * generic definition derived from that metadata.
 *
 * All models use the OpenAI Chat Completions protocol at
 * https://api.deepseek.com. Thinking is controlled the DeepSeek way:
 * `thinking: {type: enabled|disabled}` plus `reasoning_effort` (see
 * https://api-docs.deepseek.com/guides/thinking_mode); pi's `deepseek`
 * thinkingFormat implements exactly this.
 */

import { apiRoot, getDeepSeekApiKey, DEEPSEEK_API_KEY_ENV } from "./credentials.ts"

export const DEEPSEEK_PROVIDER = "deepseek"
export const DEEPSEEK_MODELS_TIMEOUT_MS = 10_000

/** Structural shape of a chat model config accepted by pi.registerProvider. */
export interface DeepSeekModelConfig {
  type: "chat"
  id: string
  name: string
  reasoning: boolean
  thinkingLevelMap?: Partial<
    Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>
  >
  input: ("text" | "image")[]
  inputLimits?: unknown
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextWindow: number
  maxTokens: number
  compat?: Record<string, unknown>
}

/**
 * Per-token costs in USD per million tokens at peak rates, from the official
 * pricing page (https://api-docs.deepseek.com/quick_start/pricing).
 * Off-peak is half. cacheWrite stays 0: DeepSeek prices cached reads.
 */
export const FLASH_COST = { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 } as const
export const V4_PRO_COST = { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 } as const

/** openai-completions compatibility flags, matching pi's built-in deepseek catalog. */
const COMPLETIONS_COMPAT: Record<string, unknown> = {
  supportsStore: false,
  supportsDeveloperRole: false,
  maxTokensField: "max_tokens",
  requiresReasoningContentOnAssistantMessages: true,
  thinkingFormat: "deepseek",
  supportsStrictMode: true,
}

/** Image preprocessing limits, matching pi's built-in deepseek-flash entry. */
const IMAGE_INPUT_LIMITS = {
  images: {
    resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 },
  },
} as const

/**
 * Thinking levels per the official mapping table. Only 1:1 levels are
 * exposed: low→low, high→high, max→max. minimal/medium/xhigh exist upstream
 * but remap to other effort tiers, so they stay hidden to avoid misleading
 * billing. `off: "disabled"` enables the `thinking: {type: "disabled"}`
 * switch (the map value itself is unused by pi's deepseek format; null
 * hides the level).
 */
const FLASH_THINKING = {
  off: "disabled",
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  max: "max",
} as const

/** V4 Pro accepts only the high/max effort tiers (pi's built-in behavior). */
const V4_PRO_THINKING = {
  off: "disabled",
  minimal: null,
  low: null,
  medium: null,
  high: "high",
  max: "max",
} as const

function chatModel(
  id: string,
  name: string,
  cost: DeepSeekModelConfig["cost"],
  thinkingLevelMap: DeepSeekModelConfig["thinkingLevelMap"],
  input: ("text" | "image")[],
  contextWindow = 1_000_000,
  maxTokens = 384_000,
  compat: Record<string, unknown> = COMPLETIONS_COMPAT,
): DeepSeekModelConfig {
  return {
    type: "chat",
    id,
    name,
    reasoning: true,
    thinkingLevelMap,
    input,
    inputLimits: input.includes("image") ? IMAGE_INPUT_LIMITS : undefined,
    cost: { ...cost },
    contextWindow,
    maxTokens,
    compat: { ...compat },
  }
}

export const STATIC_DEEPSEEK_MODELS: DeepSeekModelConfig[] = [
  chatModel("deepseek-flash", "DeepSeek V4.1 Flash", FLASH_COST, { ...FLASH_THINKING }, [
    "text",
    "image",
  ]),
  chatModel(
    "deepseek-v4-pro",
    "DeepSeek V4 Pro",
    V4_PRO_COST,
    { ...V4_PRO_THINKING },
    ["text"],
    1_000_000,
    384_000,
    { ...COMPLETIONS_COMPAT, supportsMidConvoSystemMessages: true },
  ),
  // Retired names, still accepted and served by V4.1 Flash at Flash pricing.
  chatModel(
    "deepseek-v4-flash",
    "DeepSeek V4 Flash (legacy alias)",
    FLASH_COST,
    {
      ...FLASH_THINKING,
    },
    ["text"],
  ),
  chatModel(
    "deepseek-v4-flash-vision-exp",
    "DeepSeek V4 Flash Vision (legacy alias)",
    FLASH_COST,
    { ...FLASH_THINKING },
    ["text", "image"],
  ),
]

const STATIC_BY_ID = new Map(STATIC_DEEPSEEK_MODELS.map((model) => [model.id, model]))

// ---------------------------------------------------------------------------
// Remote model list (documented OpenAI-style GET {base}/models endpoint)
// ---------------------------------------------------------------------------

/** Capability metadata DeepSeek returns per model; every field is optional. */
export interface DeepSeekRemoteModel {
  id: string
  name?: string
  context_window?: number
  max_output_tokens?: number
  input_modalities?: string[]
  effort?: {
    supported_levels?: string[]
    default_level?: string
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  )
  return entries.length > 0 ? entries : undefined
}

function toPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

function parseRemoteEntry(value: unknown): DeepSeekRemoteModel | null {
  if (!isRecord(value)) return null
  const id = typeof value.id === "string" ? value.id.trim() : ""
  if (!id) return null
  const entry: DeepSeekRemoteModel = { id }

  const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : undefined
  if (name !== undefined) entry.name = name

  const contextWindow = toPositiveInteger(value.context_window)
  if (contextWindow !== undefined) entry.context_window = contextWindow

  const maxOutputTokens = toPositiveInteger(value.max_output_tokens)
  if (maxOutputTokens !== undefined) entry.max_output_tokens = maxOutputTokens

  const inputModalities = toStringArray(value.input_modalities)
  if (inputModalities !== undefined) entry.input_modalities = inputModalities

  const effort = isRecord(value.effort) ? value.effort : null
  if (effort) {
    const supportedLevels = toStringArray(effort.supported_levels)
    const defaultLevel =
      typeof effort.default_level === "string" && effort.default_level.trim()
        ? effort.default_level.trim()
        : undefined
    if (supportedLevels !== undefined || defaultLevel !== undefined) {
      entry.effort = {}
      if (supportedLevels !== undefined) entry.effort.supported_levels = supportedLevels
      if (defaultLevel !== undefined) entry.effort.default_level = defaultLevel
    }
  }
  return entry
}

/**
 * Extract model entries from an OpenAI-style /models response.
 * Null = unusable payload.
 */
export function parseModelsResponse(raw: unknown): DeepSeekRemoteModel[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.data)) return null
  const models: DeepSeekRemoteModel[] = []
  const seen = new Set<string>()
  for (const entry of raw.data) {
    if (typeof entry === "string" && entry.trim()) {
      const id = entry.trim()
      if (!seen.has(id)) {
        seen.add(id)
        models.push({ id })
      }
      continue
    }
    const parsed = parseRemoteEntry(entry)
    if (parsed && !seen.has(parsed.id)) {
      seen.add(parsed.id)
      models.push(parsed)
    }
  }
  return models.length > 0 ? models : null
}

/** Unknown-remote-model thinking map: only 1:1 levels are exposed, off hidden. */
function thinkingMapFromLevels(levels?: string[]): DeepSeekModelConfig["thinkingLevelMap"] {
  const supported = new Set(levels ?? [])
  return {
    off: null,
    minimal: null,
    low: supported.has("low") ? "low" : null,
    medium: null,
    high: supported.has("high") ? "high" : null,
    max: supported.has("max") ? "max" : undefined,
  }
}

/** Conservative fallback for remote ids the static catalog does not know. */
function genericModel(remote: DeepSeekRemoteModel): DeepSeekModelConfig {
  const supportedLevels = remote.effort?.supported_levels
  const reasoning = (supportedLevels?.length ?? 0) > 0
  const wantsImage = remote.input_modalities?.includes("image") === true
  const input: ("text" | "image")[] = wantsImage ? ["text", "image"] : ["text"]
  return {
    type: "chat",
    id: remote.id,
    name: remote.name ?? remote.id,
    reasoning,
    thinkingLevelMap: reasoning ? thinkingMapFromLevels(supportedLevels) : undefined,
    input,
    inputLimits: wantsImage ? IMAGE_INPUT_LIMITS : undefined,
    // Cost is unknown for models not in the static catalog; 0 avoids
    // fabricating numbers in pi's cost display.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: remote.context_window ?? 262_144,
    maxTokens: remote.max_output_tokens ?? 32_768,
    compat: { ...COMPLETIONS_COMPAT },
  }
}

/** Map remote entries onto the static catalog; unknown ids get generic defs. */
export function buildModelsFromRemote(remote: DeepSeekRemoteModel[]): DeepSeekModelConfig[] {
  return remote.map((entry) => STATIC_BY_ID.get(entry.id) ?? genericModel(entry))
}

export type FetchModelsResult =
  { ok: true; models: DeepSeekRemoteModel[] } | { ok: false; message: string }

export async function fetchRemoteModels(options: {
  apiKey: string
  baseUrl: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<FetchModelsResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEEPSEEK_MODELS_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const requestSignal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal
  const url = `${options.baseUrl.replace(/\/+$/, "")}/models`
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${options.apiKey}` },
      signal: requestSignal,
    })
    if (!response.ok) {
      return { ok: false, message: `HTTP ${response.status}` }
    }
    const models = parseModelsResponse(await response.json())
    if (!models) return { ok: false, message: "unreadable model list" }
    return { ok: true, models }
  } catch (error) {
    const reason = options.signal?.aborted
      ? "model refresh aborted"
      : controller.signal.aborted
        ? `timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error)
    // Never leak the key through error text.
    return { ok: false, message: reason.split(options.apiKey).join("[redacted]") }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Provider refresh hook + last-refresh state for /deepseek-refresh reporting
// ---------------------------------------------------------------------------

export interface DeepSeekModelsRefreshState {
  at: number
  source: "remote" | "static" | "offline"
  modelIds: string[]
  /** Sanitized failure reason when source is "static" after a failed fetch. */
  error?: string
}

let lastRefresh: DeepSeekModelsRefreshState | undefined

/** Last refresh outcome, for the /deepseek-refresh command to report. */
export function getLastModelsRefresh(): DeepSeekModelsRefreshState | undefined {
  return lastRefresh
}

export interface RefreshModelsContextLike {
  credential?: { type: string; key?: string; access?: string }
  allowNetwork: boolean
  baseUrl?: string
  signal: AbortSignal
}

function credentialKey(credential: RefreshModelsContextLike["credential"]): string | undefined {
  if (!credential) return undefined
  const value = credential.key ?? credential.access
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/**
 * ProviderConfig.refreshModels implementation. The returned list replaces the
 * extension-provided models; the static catalog is both the offline answer
 * and the failure fallback, so this never throws.
 */
export async function refreshDeepSeekModels(
  context: RefreshModelsContextLike,
): Promise<DeepSeekModelConfig[]> {
  const staticIds = STATIC_DEEPSEEK_MODELS.map((model) => model.id)
  if (!context.allowNetwork) {
    lastRefresh = { at: Date.now(), source: "offline", modelIds: staticIds }
    return STATIC_DEEPSEEK_MODELS
  }
  if (context.signal.aborted) return STATIC_DEEPSEEK_MODELS

  const apiKey = credentialKey(context.credential) ?? getDeepSeekApiKey()
  if (!apiKey) {
    lastRefresh = {
      at: Date.now(),
      source: "static",
      modelIds: staticIds,
      error: `no credential (set ${DEEPSEEK_API_KEY_ENV} or run /login)`,
    }
    return STATIC_DEEPSEEK_MODELS
  }

  const baseUrl = context.baseUrl ?? apiRoot()
  const result = await fetchRemoteModels({ apiKey, baseUrl, signal: context.signal })
  // pi may abort a stale/background refresh. Its result must not overwrite
  // the report from a newer or explicitly requested refresh.
  if (context.signal.aborted) return STATIC_DEEPSEEK_MODELS
  if (!result.ok) {
    lastRefresh = {
      at: Date.now(),
      source: "static",
      modelIds: staticIds,
      error: result.message,
    }
    return STATIC_DEEPSEEK_MODELS
  }

  const models = buildModelsFromRemote(result.models)
  lastRefresh = { at: Date.now(), source: "remote", modelIds: result.models.map((m) => m.id) }
  return models
}
