/**
 * pi-deepseek-provider — self-contained `deepseek` provider for the DeepSeek
 * API, plus balance and model-refresh commands.
 *
 * - Registers provider `deepseek` (OpenAI Chat Completions API against
 *   {DEEPSEEK_API_BASE|https://api.deepseek.com}) with API-key auth. The id
 *   composes over pi's built-in provider: the same `DEEPSEEK_API_KEY` env
 *   var and `/login` flow keep working, while the model catalog is replaced
 *   by the extension's static list (with remote refresh).
 * - `/deepseek-balance` renders the account balance (documented
 *   GET /user/balance), CNY/USD per-currency lines.
 * - `/deepseek-refresh` re-fetches the model list (documented GET /models,
 *   which returns capability metadata), falling back to the built-in static
 *   catalog.
 *
 * Rendering: TUI balance results use immediately rendered custom entries with
 * a themed background; RPC uses notifications and print/json use stdout/stderr.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Box, Text } from "@earendil-works/pi-tui"

import { createBalanceThrottle, fetchDeepSeekBalance } from "./src/balance.ts"
import {
  apiRoot,
  DEEPSEEK_API_KEY_ENV,
  DEEPSEEK_PROVIDER,
  getDeepSeekApiKey,
} from "./src/credentials.ts"
import { DEEPSEEK_BALANCE_ENTRY, type EmitKind, makeEmit } from "./src/emit.ts"
import {
  getLastModelsRefresh,
  refreshDeepSeekModels,
  STATIC_DEEPSEEK_MODELS,
} from "./src/models.ts"
import { parseDeepSeekBalanceResponse, renderBalanceText } from "./src/render.ts"

function requireApiKey(emit: (text: string, kind: EmitKind) => void): string | undefined {
  const apiKey = getDeepSeekApiKey()
  if (!apiKey) {
    emit(
      `DeepSeek API key not found. Run /login and select DeepSeek, or set ${DEEPSEEK_API_KEY_ENV}.`,
      "warning",
    )
  }
  return apiKey
}

export default function (pi: ExtensionAPI) {
  const balanceThrottle = createBalanceThrottle()
  const refreshThrottle = createBalanceThrottle()

  pi.registerEntryRenderer<{ text: string }>(DEEPSEEK_BALANCE_ENTRY, (entry, _options, theme) => {
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text))
    box.addChild(new Text(entry.data?.text ?? "DeepSeek balance unavailable", 0, 0))
    return box
  })

  // -------------------------------------------------------------------------
  // Provider `deepseek`: OpenAI Chat Completions API + API-key auth.
  // Composes over pi's built-in deepseek provider: /login and
  // DEEPSEEK_API_KEY keep working; this extension owns the model catalog.
  // -------------------------------------------------------------------------

  pi.registerProvider(DEEPSEEK_PROVIDER, {
    name: "DeepSeek",
    baseUrl: apiRoot(),
    apiKey: `$${DEEPSEEK_API_KEY_ENV}`,
    api: "openai-completions",
    models: STATIC_DEEPSEEK_MODELS,
    refreshModels: refreshDeepSeekModels,
  })

  // -------------------------------------------------------------------------
  // /deepseek-balance
  // -------------------------------------------------------------------------

  pi.registerCommand("deepseek-balance", {
    description: "Show the DeepSeek account balance (CNY/USD, granted vs topped-up)",
    handler: async (_args, ctx) => {
      // Balance is independent of the active agent run. Do not wait for idle:
      // pi executes extension commands immediately even while streaming.
      const emit = makeEmit(pi, ctx, DEEPSEEK_BALANCE_ENTRY)

      const apiKey = requireApiKey(emit)
      if (!apiKey) return

      const slot = balanceThrottle.tryAcquire()
      if (!slot.allowed) {
        emit(
          `DeepSeek balance was just fetched. Please wait ${Math.ceil(slot.retryAfterMs / 1000)}s before checking again.`,
          "warning",
        )
        return
      }

      const result = await fetchDeepSeekBalance({ apiKey })
      if (!result.ok) {
        emit(result.error.message, "error")
        return
      }
      emit(renderBalanceText(parseDeepSeekBalanceResponse(result.data)), "info")
    },
  })

  // -------------------------------------------------------------------------
  // /deepseek-refresh
  // -------------------------------------------------------------------------

  pi.registerCommand("deepseek-refresh", {
    description: "Refresh the deepseek provider model list (online, static catalog fallback)",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle?.()
      const emit = makeEmit(pi, ctx)

      const apiKey = requireApiKey(emit)
      if (!apiKey) return

      const slot = refreshThrottle.tryAcquire()
      if (!slot.allowed) {
        emit(
          `DeepSeek models were just refreshed. Please wait ${Math.ceil(slot.retryAfterMs / 1000)}s before refreshing again.`,
          "warning",
        )
        return
      }

      const before = STATIC_DEEPSEEK_MODELS.map((model) => model.id)
      const result = await ctx.modelRegistry.refresh({
        providers: [DEEPSEEK_PROVIDER],
        allowNetwork: true,
        force: true,
      })

      const failure = result.errors.get(DEEPSEEK_PROVIDER)
      if (result.aborted) {
        emit("DeepSeek model refresh was aborted.", "warning")
        return
      }
      if (failure) {
        emit(`DeepSeek model refresh failed: ${failure.message}`, "error")
        return
      }

      const state = getLastModelsRefresh()
      if (!state || state.source === "offline") {
        emit("DeepSeek model refresh ran offline; static catalog kept.", "warning")
        return
      }
      if (state.source === "static") {
        emit(
          `DeepSeek model list endpoint unavailable (${state.error ?? "unknown error"}); static catalog kept: ${state.modelIds.join(", ")}`,
          "warning",
        )
        return
      }

      const added = state.modelIds.filter((id) => !before.includes(id))
      const removed = before.filter((id) => !state.modelIds.includes(id))
      const parts = [`DeepSeek models refreshed from server: ${state.modelIds.join(", ")}`]
      if (added.length > 0) parts.push(`added: ${added.join(", ")}`)
      if (removed.length > 0) parts.push(`removed: ${removed.join(", ")}`)
      emit(parts.join("\n"), "info")
    },
  })
}
