/** Regression tests for UI output paths not exercised by RPC mode. */

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"

import { DEEPSEEK_BALANCE_ENTRY, makeEmit } from "../src/emit.ts"

function uiContext(mode: "tui" | "rpc", notifications: { text: string; kind: string }[]) {
  return {
    mode,
    hasUI: true,
    ui: {
      notify(text: string, kind: string) {
        notifications.push({ text, kind })
      },
    },
  } as unknown as ExtensionCommandContext
}

describe("command output", () => {
  it("appends TUI balance entries immediately without sendMessage or notify", () => {
    const appended: { type: string; data: unknown }[] = []
    const notifications: { text: string; kind: string }[] = []
    const pi = {
      appendEntry(type: string, data: unknown) {
        appended.push({ type, data })
      },
      sendMessage() {
        throw new Error("sendMessage would queue the result behind the active agent turn")
      },
    } as unknown as ExtensionAPI

    makeEmit(
      pi,
      uiContext("tui", notifications),
      DEEPSEEK_BALANCE_ENTRY,
    )("DeepSeek balance: available", "info")

    assert.deepEqual(appended, [
      { type: DEEPSEEK_BALANCE_ENTRY, data: { text: "DeepSeek balance: available" } },
    ])
    assert.deepEqual(notifications, [])
  })

  it("keeps RPC output on notify and TUI warnings out of the entry stream", () => {
    const appended: unknown[] = []
    const rpcNotifications: { text: string; kind: string }[] = []
    const tuiNotifications: { text: string; kind: string }[] = []
    const pi = {
      appendEntry(...args: unknown[]) {
        appended.push(args)
      },
    } as unknown as ExtensionAPI

    makeEmit(pi, uiContext("rpc", rpcNotifications), DEEPSEEK_BALANCE_ENTRY)("balance", "info")
    makeEmit(pi, uiContext("tui", tuiNotifications), DEEPSEEK_BALANCE_ENTRY)("wait", "warning")

    assert.deepEqual(appended, [])
    assert.deepEqual(rpcNotifications, [{ text: "balance", kind: "info" }])
    assert.deepEqual(tuiNotifications, [{ text: "wait", kind: "warning" }])
  })
})
