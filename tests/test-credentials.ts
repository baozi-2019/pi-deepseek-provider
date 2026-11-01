/**
 * Unit tests for src/credentials.ts — hermetic, uses temp directories.
 * All keys are fabricated placeholders.
 */

import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

import { apiRoot, defaultAgentDir, getDeepSeekApiKey } from "../src/credentials.ts"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-deepseek-provider-creds-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeAuth(contents: unknown): void {
  writeFileSync(join(dir, "auth.json"), JSON.stringify(contents))
}

describe("getDeepSeekApiKey", () => {
  it("prefers the DEEPSEEK_API_KEY environment override", () => {
    writeAuth({ deepseek: { type: "api_key", key: "sk-deepseek-stored-fake" } })
    const key = getDeepSeekApiKey({
      env: { DEEPSEEK_API_KEY: "sk-deepseek-env-fake" },
      agentDir: dir,
    })
    assert.equal(key, "sk-deepseek-env-fake")
  })

  it("reads the deepseek api_key entry from auth.json", () => {
    writeAuth({ deepseek: { type: "api_key", key: "sk-deepseek-stored-fake" } })
    assert.equal(getDeepSeekApiKey({ env: {}, agentDir: dir }), "sk-deepseek-stored-fake")
  })

  it("never falls back to another provider's entry", () => {
    writeAuth({ other: { type: "api_key", key: "sk-other-fake" } })
    assert.equal(getDeepSeekApiKey({ env: {}, agentDir: dir }), undefined)
  })

  it("returns undefined when auth.json is missing", () => {
    assert.equal(getDeepSeekApiKey({ env: {}, agentDir: dir }), undefined)
  })

  it("returns undefined when auth.json is corrupt", () => {
    writeFileSync(join(dir, "auth.json"), "{not json")
    assert.equal(getDeepSeekApiKey({ env: {}, agentDir: dir }), undefined)
  })

  it("returns undefined when the deepseek entry is absent or empty", () => {
    writeAuth({ other: { type: "api_key", key: "sk-other-fake" } })
    assert.equal(getDeepSeekApiKey({ env: {}, agentDir: dir }), undefined)
    writeAuth({ deepseek: { type: "api_key" } })
    assert.equal(getDeepSeekApiKey({ env: {}, agentDir: dir }), undefined)
  })

  it("ignores a blank DEEPSEEK_API_KEY and falls back to auth.json", () => {
    writeAuth({ deepseek: { type: "api_key", key: "sk-deepseek-stored-fake" } })
    const key = getDeepSeekApiKey({ env: { DEEPSEEK_API_KEY: "   " }, agentDir: dir })
    assert.equal(key, "sk-deepseek-stored-fake")
  })
})

describe("defaultAgentDir", () => {
  it("honors PI_CODING_AGENT_DIR and falls back to ~/.pi/agent", () => {
    assert.equal(defaultAgentDir({ PI_CODING_AGENT_DIR: "/tmp/custom-agent" }), "/tmp/custom-agent")
    const fallback = defaultAgentDir({})
    assert.match(fallback, /\.pi[/\\]agent$/)
  })
})

describe("apiRoot", () => {
  it("defaults to the official endpoint", () => {
    assert.equal(apiRoot({}), "https://api.deepseek.com")
  })

  it("honors DEEPSEEK_API_BASE and strips trailing slashes", () => {
    assert.equal(
      apiRoot({ DEEPSEEK_API_BASE: "https://gateway.example.com/" }),
      "https://gateway.example.com",
    )
    assert.equal(apiRoot({ DEEPSEEK_API_BASE: "http://127.0.0.1:8080//" }), "http://127.0.0.1:8080")
  })

  it("ignores a blank override", () => {
    assert.equal(apiRoot({ DEEPSEEK_API_BASE: "  " }), "https://api.deepseek.com")
  })
})
