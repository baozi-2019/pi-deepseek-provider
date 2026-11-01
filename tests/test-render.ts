/**
 * Unit tests for src/render.ts — parsing and rendering the balance response.
 * All payloads are fabricated.
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  parseDeepSeekBalanceResponse,
  renderBalanceText,
  type DeepSeekBalanceSnapshot,
} from "../src/render.ts"

const FULL_RESPONSE = {
  is_available: true,
  balance_infos: [
    {
      currency: "CNY",
      total_balance: "110.00",
      granted_balance: "10.00",
      topped_up_balance: "100.00",
    },
    {
      currency: "USD",
      total_balance: "5.00",
      granted_balance: "0.00",
      topped_up_balance: "5.00",
    },
  ],
}

describe("parseDeepSeekBalanceResponse", () => {
  it("parses the documented full response", () => {
    assert.deepEqual(parseDeepSeekBalanceResponse(FULL_RESPONSE), {
      available: true,
      entries: [
        { currency: "CNY", total: "110.00", granted: "10.00", toppedUp: "100.00" },
        { currency: "USD", total: "5.00", granted: "0.00", toppedUp: "5.00" },
      ],
    })
  })

  it("marks is_available=false as insufficient, not zero balance", () => {
    const snapshot = parseDeepSeekBalanceResponse({
      is_available: false,
      balance_infos: FULL_RESPONSE.balance_infos,
    })
    assert.equal(snapshot.available, false)
  })

  it("treats missing or malformed fields as absent", () => {
    const snapshot = parseDeepSeekBalanceResponse({
      is_available: "yes",
      balance_infos: [
        { currency: "CNY", total_balance: "110.00" },
        { currency: "USD", total_balance: "-1.00" },
        { currency: "", total_balance: "1.00" },
        "not-an-entry",
      ],
    })
    assert.deepEqual(snapshot, {
      available: null,
      entries: [
        { currency: "CNY", total: "110.00", granted: null, toppedUp: null },
        { currency: "USD", total: null, granted: null, toppedUp: null },
      ],
    })
  })

  it("returns an empty snapshot for malformed payloads", () => {
    assert.deepEqual(parseDeepSeekBalanceResponse(null), { available: null, entries: [] })
    assert.deepEqual(parseDeepSeekBalanceResponse({}), { available: null, entries: [] })
    assert.deepEqual(parseDeepSeekBalanceResponse("nope"), { available: null, entries: [] })
  })

  it("keeps amount strings verbatim instead of rounding", () => {
    const snapshot = parseDeepSeekBalanceResponse({
      balance_infos: [{ currency: "CNY", total_balance: "0.05" }],
    })
    assert.equal(snapshot.entries[0]?.total, "0.05")
  })
})

describe("renderBalanceText", () => {
  it("renders each currency on its own line with all three amounts", () => {
    const text = renderBalanceText(parseDeepSeekBalanceResponse(FULL_RESPONSE))
    assert.match(text, /^DeepSeek balance: available$/m)
    assert.match(text, /CNY\s+total 110\.00 · granted 10\.00 · topped-up 100\.00/)
    assert.match(text, /USD\s+total 5\.00 · granted 0\.00 · topped-up 5\.00/)
  })

  it("renders insufficient balance prominently", () => {
    const text = renderBalanceText(
      parseDeepSeekBalanceResponse({
        is_available: false,
        balance_infos: FULL_RESPONSE.balance_infos,
      }),
    )
    assert.match(text, /^DeepSeek balance: insufficient balance for API calls$/m)
    assert.match(text, /CNY\s+total 110\.00/)
  })

  it("renders unavailable placeholders instead of fabricating zeros", () => {
    const text = renderBalanceText(parseDeepSeekBalanceResponse({ is_available: true }))
    assert.match(text, /^DeepSeek balance: available$/m)
    assert.match(text, /balance_infos unavailable/)
    assert.doesNotMatch(text, /0\.00/)
  })

  it("renders missing per-field values as unavailable", () => {
    const snapshot: DeepSeekBalanceSnapshot = {
      available: true,
      entries: [{ currency: "CNY", total: "1.00", granted: null, toppedUp: null }],
    }
    assert.match(renderBalanceText(snapshot), /granted unavailable · topped-up unavailable/)
  })

  it("sorts nothing and pads short currency codes for alignment", () => {
    const text = renderBalanceText(parseDeepSeekBalanceResponse(FULL_RESPONSE))
    const lines = text.split("\n")
    assert.equal(lines.length, 3)
    assert.ok(lines[1]?.startsWith("  CNY "), lines[1] ?? "")
  })
})
