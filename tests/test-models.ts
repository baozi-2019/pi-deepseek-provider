/**
 * Unit tests for src/models.ts — hermetic, fetch is injected where possible.
 * All keys and payloads are fabricated.
 */

import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

import {
  buildModelsFromRemote,
  fetchRemoteModels,
  getLastModelsRefresh,
  parseModelsResponse,
  refreshDeepSeekModels,
  STATIC_DEEPSEEK_MODELS,
} from "../src/models.ts"

describe("static catalog", () => {
  it("contains the documented model ids", () => {
    assert.deepEqual(
      STATIC_DEEPSEEK_MODELS.map((model) => model.id),
      ["deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"],
    )
  })

  it("exposes off/low/high/max for deepseek-flash with vision input", () => {
    const model = STATIC_DEEPSEEK_MODELS.find((entry) => entry.id === "deepseek-flash")
    assert.equal(model?.reasoning, true)
    assert.equal(model?.thinkingLevelMap?.off, "disabled")
    assert.equal(model?.thinkingLevelMap?.low, "low")
    assert.equal(model?.thinkingLevelMap?.high, "high")
    assert.equal(model?.thinkingLevelMap?.max, "max")
    assert.equal(model?.thinkingLevelMap?.minimal, null)
    assert.equal(model?.thinkingLevelMap?.medium, null)
    assert.equal(model?.thinkingLevelMap?.xhigh, undefined)
    assert.deepEqual(model?.input, ["text", "image"])
    assert.equal(model?.contextWindow, 1_000_000)
    assert.equal(model?.maxTokens, 384_000)
  })

  it("restricts deepseek-v4-pro to off/high/max without vision", () => {
    const model = STATIC_DEEPSEEK_MODELS.find((entry) => entry.id === "deepseek-v4-pro")
    assert.equal(model?.reasoning, true)
    assert.equal(model?.thinkingLevelMap?.low, null)
    assert.equal(model?.thinkingLevelMap?.high, "high")
    assert.equal(model?.thinkingLevelMap?.max, "max")
    assert.deepEqual(model?.input, ["text"])
    assert.equal(model?.compat?.supportsMidConvoSystemMessages, true)
  })

  it("uses the official peak USD pricing", () => {
    const flash = STATIC_DEEPSEEK_MODELS.find((entry) => entry.id === "deepseek-flash")
    const pro = STATIC_DEEPSEEK_MODELS.find((entry) => entry.id === "deepseek-v4-pro")
    assert.deepEqual(flash?.cost, { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 })
    assert.deepEqual(pro?.cost, { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 })
  })

  it("keeps legacy aliases on the flash definition", () => {
    const alias = STATIC_DEEPSEEK_MODELS.find((entry) => entry.id === "deepseek-v4-flash")
    assert.equal(alias?.cost.input, 0.3)
    assert.deepEqual(alias?.input, ["text"])
    assert.match(alias?.name ?? "", /legacy alias/)
    const visionAlias = STATIC_DEEPSEEK_MODELS.find(
      (entry) => entry.id === "deepseek-v4-flash-vision-exp",
    )
    assert.deepEqual(visionAlias?.input, ["text", "image"])
  })

  it("uses the deepseek thinking format compat on every model", () => {
    for (const model of STATIC_DEEPSEEK_MODELS) {
      assert.equal(model.compat?.thinkingFormat, "deepseek", model.id)
      assert.equal(model.compat?.requiresReasoningContentOnAssistantMessages, true, model.id)
      assert.equal(model.compat?.maxTokensField, "max_tokens", model.id)
    }
  })
})

describe("parseModelsResponse", () => {
  it("extracts documented capability metadata", () => {
    const models = parseModelsResponse({
      object: "list",
      data: [
        {
          id: "deepseek-flash",
          name: "DeepSeek V4.1 Flash",
          context_window: 1000000,
          max_output_tokens: 384000,
          input_modalities: ["text", "image"],
          effort: { supported_levels: ["low", "high", "max"], default_level: "high" },
        },
      ],
    })
    assert.deepEqual(models, [
      {
        id: "deepseek-flash",
        name: "DeepSeek V4.1 Flash",
        context_window: 1000000,
        max_output_tokens: 384000,
        input_modalities: ["text", "image"],
        effort: { supported_levels: ["low", "high", "max"], default_level: "high" },
      },
    ])
  })

  it("accepts bare string entries and dedupes by id", () => {
    const models = parseModelsResponse({
      data: ["deepseek-flash", { id: "deepseek-flash" }, { id: " deepseek-v4-pro " }],
    })
    assert.deepEqual(
      models?.map((model) => model.id),
      ["deepseek-flash", "deepseek-v4-pro"],
    )
  })

  it("returns null for malformed payloads", () => {
    assert.equal(parseModelsResponse(null), null)
    assert.equal(parseModelsResponse({}), null)
    assert.equal(parseModelsResponse({ data: [] }), null)
    assert.equal(parseModelsResponse({ data: [{ name: "no-id" }] }), null)
  })
})

describe("buildModelsFromRemote", () => {
  it("reuses static definitions for known ids", () => {
    const models = buildModelsFromRemote([{ id: "deepseek-flash" }])
    assert.equal(models[0]?.name, "DeepSeek V4.1 Flash")
    assert.equal(models[0]?.contextWindow, 1_000_000)
  })

  it("derives generic definitions from remote capability metadata", () => {
    const models = buildModelsFromRemote([
      {
        id: "future-model",
        name: "Future Model",
        context_window: 128000,
        max_output_tokens: 8192,
        input_modalities: ["text", "image"],
        effort: { supported_levels: ["low", "high"] },
      },
    ])
    assert.deepEqual(models, [
      {
        type: "chat",
        id: "future-model",
        name: "Future Model",
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "low",
          medium: null,
          high: "high",
          max: undefined,
        },
        input: ["text", "image"],
        inputLimits: {
          images: {
            resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 },
          },
        },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
          requiresReasoningContentOnAssistantMessages: true,
          thinkingFormat: "deepseek",
          supportsStrictMode: true,
        },
      },
    ])
  })

  it("treats a model without effort levels as non-reasoning and text-only", () => {
    const models = buildModelsFromRemote([{ id: "plain-model" }])
    assert.equal(models[0]?.reasoning, false)
    assert.equal(models[0]?.thinkingLevelMap, undefined)
    assert.deepEqual(models[0]?.input, ["text"])
    assert.equal(models[0]?.contextWindow, 262_144)
    assert.equal(models[0]?.maxTokens, 32_768)
  })
})

describe("fetchRemoteModels", () => {
  const key = "sk-deepseek-fake-test-key"

  it("GETs {baseUrl}/models with a Bearer header", async () => {
    let seenUrl = ""
    let seenAuth = ""
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      seenUrl = String(input)
      seenAuth = new Headers(init?.headers).get("authorization") ?? ""
      return new Response(JSON.stringify({ data: [{ id: "deepseek-flash" }] }), { status: 200 })
    }
    const result = await fetchRemoteModels({
      apiKey: key,
      baseUrl: "https://api.deepseek.com",
      fetchImpl,
    })
    assert.deepEqual(result, { ok: true, models: [{ id: "deepseek-flash" }] })
    assert.equal(seenUrl, "https://api.deepseek.com/models")
    assert.equal(seenAuth, `Bearer ${key}`)
  })

  it("reports HTTP failures without the key", async () => {
    const fetchImpl = async (): Promise<Response> => new Response("nope", { status: 404 })
    const result = await fetchRemoteModels({
      apiKey: key,
      baseUrl: "https://api.deepseek.com",
      fetchImpl,
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.message, /404/)
    assert.doesNotMatch(result.message, new RegExp(key))
  })

  it("reports unreadable payloads", async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })
    const result = await fetchRemoteModels({
      apiKey: key,
      baseUrl: "https://api.deepseek.com",
      fetchImpl,
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.message, /unreadable/)
  })

  it("redacts the key from network error messages", async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new Error(`connect failed for ${key}`)
    }
    const result = await fetchRemoteModels({
      apiKey: key,
      baseUrl: "https://api.deepseek.com",
      fetchImpl,
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.doesNotMatch(result.message, new RegExp(key))
  })

  it("honors caller cancellation separately from the timeout", async () => {
    const controller = new AbortController()
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })
    const pending = fetchRemoteModels({
      apiKey: key,
      baseUrl: "https://api.deepseek.com",
      fetchImpl,
      signal: controller.signal,
    })
    controller.abort()
    const result = await pending
    assert.deepEqual(result, { ok: false, message: "model refresh aborted" })
  })
})

describe("refreshDeepSeekModels", () => {
  let dir: string
  let savedAgentDir: string | undefined
  let savedApiKey: string | undefined
  let savedApiBase: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-deepseek-provider-models-"))
    savedAgentDir = process.env.PI_CODING_AGENT_DIR
    savedApiKey = process.env.DEEPSEEK_API_KEY
    savedApiBase = process.env.DEEPSEEK_API_BASE
    process.env.PI_CODING_AGENT_DIR = dir
    delete process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_API_BASE
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir
    if (savedApiKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = savedApiKey
    if (savedApiBase === undefined) delete process.env.DEEPSEEK_API_BASE
    else process.env.DEEPSEEK_API_BASE = savedApiBase
  })

  it("returns the static catalog without network access", async () => {
    const models = await refreshDeepSeekModels({
      allowNetwork: false,
      signal: new AbortController().signal,
    })
    assert.deepEqual(
      models.map((model) => model.id),
      STATIC_DEEPSEEK_MODELS.map((model) => model.id),
    )
    assert.equal(getLastModelsRefresh()?.source, "offline")
  })

  it("keeps the static catalog when no credential exists", async () => {
    const models = await refreshDeepSeekModels({
      allowNetwork: true,
      signal: new AbortController().signal,
    })
    assert.deepEqual(
      models.map((model) => model.id),
      STATIC_DEEPSEEK_MODELS.map((model) => model.id),
    )
    const state = getLastModelsRefresh()
    assert.equal(state?.source, "static")
    assert.match(state?.error ?? "", /no credential/)
  })

  it("uses the pi-resolved credential when provided", async () => {
    // No DEEPSEEK_API_KEY, no auth.json for `deepseek`: only context.credential
    // can authenticate. Point DEEPSEEK_API_BASE at a local mock to serve /models.
    const { createServer } = await import("node:http")
    type HttpHandler = (
      req: import("node:http").IncomingMessage,
      res: import("node:http").ServerResponse,
    ) => void
    const handler: HttpHandler = (req, res) => {
      if (req.url === "/models" && req.headers.authorization === "Bearer ctx-token") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ data: [{ id: "deepseek-flash" }, { id: "brand-new-model" }] }))
        return
      }
      res.writeHead(401)
      res.end()
    }
    const server = createServer(handler)
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    process.env.DEEPSEEK_API_BASE = `http://127.0.0.1:${port}`
    try {
      const models = await refreshDeepSeekModels({
        allowNetwork: true,
        credential: { type: "api_key", key: "ctx-token" },
        signal: new AbortController().signal,
      })
      assert.deepEqual(
        models.map((model) => model.id),
        ["deepseek-flash", "brand-new-model"],
      )
      assert.equal(getLastModelsRefresh()?.source, "remote")
    } finally {
      delete process.env.DEEPSEEK_API_BASE
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it("falls back to the static catalog when the endpoint fails", async () => {
    const { createServer } = await import("node:http")
    type HttpHandler = (
      req: import("node:http").IncomingMessage,
      res: import("node:http").ServerResponse,
    ) => void
    const handler: HttpHandler = (_req, res) => {
      res.writeHead(404)
      res.end()
    }
    const server = createServer(handler)
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    process.env.DEEPSEEK_API_BASE = `http://127.0.0.1:${port}`
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-fake-test-key"
    try {
      const models = await refreshDeepSeekModels({
        allowNetwork: true,
        signal: new AbortController().signal,
      })
      assert.deepEqual(
        models.map((model) => model.id),
        STATIC_DEEPSEEK_MODELS.map((model) => model.id),
      )
      const state = getLastModelsRefresh()
      assert.equal(state?.source, "static")
      assert.match(state?.error ?? "", /404/)
    } finally {
      delete process.env.DEEPSEEK_API_BASE
      delete process.env.DEEPSEEK_API_KEY
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it("prefers context.baseUrl over the default root", async () => {
    const { createServer } = await import("node:http")
    type HttpHandler = (
      req: import("node:http").IncomingMessage,
      res: import("node:http").ServerResponse,
    ) => void
    let seenUrl = ""
    const handler: HttpHandler = (req, res) => {
      seenUrl = req.url ?? ""
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ data: [{ id: "deepseek-flash" }] }))
    }
    const server = createServer(handler)
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-fake-test-key"
    try {
      await refreshDeepSeekModels({
        allowNetwork: true,
        baseUrl: `http://127.0.0.1:${port}`,
        signal: new AbortController().signal,
      })
      assert.equal(seenUrl, "/models")
    } finally {
      delete process.env.DEEPSEEK_API_KEY
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it("does not overwrite the last refresh state after caller cancellation", async () => {
    const { createServer } = await import("node:http")
    type HttpHandler = (
      req: import("node:http").IncomingMessage,
      res: import("node:http").ServerResponse,
    ) => void
    let markRequestSeen: (() => void) | undefined
    const requestSeen = new Promise<void>((resolve) => {
      markRequestSeen = resolve
    })
    const handler: HttpHandler = (req, res) => {
      markRequestSeen?.()
      req.on("close", () => res.end())
    }
    const server = createServer(handler)
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    const before = getLastModelsRefresh()
    const controller = new AbortController()
    try {
      const pending = refreshDeepSeekModels({
        allowNetwork: true,
        baseUrl: `http://127.0.0.1:${port}`,
        credential: { type: "api_key", key: "sk-deepseek-fake-test-key" },
        signal: controller.signal,
      })
      await requestSeen
      controller.abort()
      const models = await pending
      assert.deepEqual(
        models.map((model) => model.id),
        STATIC_DEEPSEEK_MODELS.map((model) => model.id),
      )
      assert.equal(getLastModelsRefresh(), before)
    } finally {
      controller.abort()
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
