#!/usr/bin/env node
/**
 * Local end-to-end test: loads the real extension through the pi CLI in an
 * isolated HOME while the DeepSeek balance, models, and chat endpoints are
 * replaced by a deterministic local mock server. All keys and payloads are
 * fabricated.
 *
 * Skips automatically when pi is not on PATH; set PI_LOCAL_REQUIRED=1 to turn
 * the skip into a failure (CI).
 */

import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { accessSync, constants, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_DIR = resolve(__dirname, "..")
const EXT_PATH = resolve(PROJECT_DIR, "index.ts")
const FAKE_KEY = "sk-deepseek-e2e-fake-key"

function findPiBinary() {
  if (process.env.PI_BIN) return process.env.PI_BIN
  const localBin = resolve(PROJECT_DIR, "node_modules", ".bin")
  const candidates = (process.env.PATH ?? "")
    .split(delimiter)
    .map((entry) => resolve(entry, "pi"))
    .filter((candidate) => !candidate.startsWith(localBin))
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Try next PATH entry.
    }
  }
  return undefined
}

const PI_BIN = findPiBinary()
if (!PI_BIN) {
  if (process.env.PI_LOCAL_REQUIRED === "1") {
    console.error("[pi-local] FAIL - pi is required but not on PATH and PI_BIN is unset")
    process.exit(1)
  }
  console.log("[pi-local] SKIP — pi is not on PATH")
  process.exit(0)
}

const piCheck = spawnSync(PI_BIN, ["--help"], { stdio: "ignore" })
if (piCheck.error) {
  if (process.env.PI_LOCAL_REQUIRED === "1") {
    console.error(`[pi-local] FAIL - pi failed to start: ${piCheck.error.message}`)
    process.exit(1)
  }
  console.log(`[pi-local] SKIP — pi failed to start: ${piCheck.error.message}`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Mock DeepSeek endpoints. `scenario` switches the fabricated balance
// response; /models always returns the same small remote catalog.
// ---------------------------------------------------------------------------

let scenario = "full"
let balanceRequestCount = 0
let modelsRequestCount = 0
let chatRequestCount = 0
let holdChatOpen = false
let lastAuthorization = ""
let lastChatPayload

const FULL_BALANCE = {
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

const INSUFFICIENT_BALANCE = {
  is_available: false,
  balance_infos: [
    { currency: "CNY", total_balance: "0.00", granted_balance: "0.00", topped_up_balance: "0.00" },
  ],
}

const REMOTE_MODELS = {
  object: "list",
  data: [
    { id: "deepseek-flash", name: "DeepSeek V4.1 Flash" },
    { id: "brand-new-model", name: "Brand New Model" },
  ],
}

const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname
  if (req.method === "GET" && pathname === "/user/balance") {
    balanceRequestCount += 1
    lastAuthorization = req.headers.authorization ?? ""
    if (scenario === "unauthorized") {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" })
      res.end(JSON.stringify({ error: "unauthorized" }))
      return
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
    res.end(JSON.stringify(scenario === "insufficient" ? INSUFFICIENT_BALANCE : FULL_BALANCE))
    return
  }
  if (req.method === "GET" && pathname === "/models") {
    modelsRequestCount += 1
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
    res.end(JSON.stringify(REMOTE_MODELS))
    return
  }
  if (req.method === "POST" && pathname === "/chat/completions") {
    chatRequestCount += 1
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      lastChatPayload = JSON.parse(body)
      if (holdChatOpen) {
        // Keep the response pending until the test aborts the agent run.
        return
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
      res.end(
        JSON.stringify({
          id: "chatcmpl-fake",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: lastChatPayload.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      )
    })
    return
  }
  res.writeHead(404)
  res.end("Not found")
})

await new Promise((resolve) => server.listen(0, resolve))
const address = server.address()
const port = typeof address === "object" && address ? address.port : 0
const apiBase = `http://127.0.0.1:${port}`

const tempHome = mkdtempSync(join(tmpdir(), "pi-deepseek-provider-home-"))
const agentDir = join(tempHome, "custom-pi-agent")
mkdirSync(agentDir, { recursive: true })
writeFileSync(
  join(agentDir, "auth.json"),
  JSON.stringify({ deepseek: { type: "api_key", key: FAKE_KEY } }),
)

const env = {
  ...process.env,
  HOME: tempHome,
  USERPROFILE: tempHome,
  PI_CODING_AGENT_DIR: agentDir,
  PI_CODING_AGENT_SESSION_DIR: join(tempHome, "sessions"),
  DEEPSEEK_API_BASE: apiBase,
}
delete env.DEEPSEEK_API_KEY

// ---------------------------------------------------------------------------
// RPC session helper: drives an isolated pi instance over the JSON protocol.
// ---------------------------------------------------------------------------

function startRpcSession(timeoutMs = 30_000) {
  const child = spawn(PI_BIN, ["--no-extensions", "--mode", "rpc", "-e", EXT_PATH], {
    cwd: PROJECT_DIR,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  })

  let buffer = ""
  let stderr = ""
  const events = []
  const waiters = []

  const publish = (event) => {
    events.push(event)
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]
      if (!waiter.predicate(event)) continue
      waiters.splice(index, 1)
      clearTimeout(waiter.timer)
      waiter.resolve(event)
    }
  }

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf-8")
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        publish(JSON.parse(line))
      } catch {
        // Ignore non-JSON output.
      }
    }
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf-8")
  })

  const waitFor = (predicate, fromIndex = 0) =>
    new Promise((resolve, reject) => {
      const existing = events.slice(fromIndex).find(predicate)
      if (existing) {
        resolve(existing)
        return
      }
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.timer === timer)
        if (index >= 0) waiters.splice(index, 1)
        reject(new Error(`RPC event timeout. stderr: ${stderr.slice(-500)}`))
      }, timeoutMs)
      waiters.push({ predicate, resolve, timer })
    })

  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`)

  const runCommand = async (id, command) => {
    const fromIndex = events.length
    send({ id, type: "prompt", message: command })
    await waitFor((event) => event.type === "response" && event.id === id && event.success)
    return waitFor(
      (event) => event.type === "extension_ui_request" && event.method === "notify",
      fromIndex,
    )
  }

  return {
    send,
    waitFor,
    runCommand,
    stderr: () => stderr,
    eventCount: () => events.length,
    close: () => child.kill(),
  }
}

async function waitForCondition(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the mock server state")
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

try {
  // -- Session 1: full fixture, command registration, throttle -------------
  console.log("[pi-local] /deepseek-balance renders both currencies through the real extension")
  scenario = "full"
  const first = startRpcSession()

  first.send({ id: "commands", type: "get_commands" })
  const commandsResponse = await first.waitFor(
    (event) => event.type === "response" && event.id === "commands",
  )
  const commandNames = commandsResponse.data?.commands?.map((command) => command.name) ?? []
  assert.ok(commandNames.includes("deepseek-balance"), JSON.stringify(commandNames))
  assert.ok(commandNames.includes("deepseek-refresh"), JSON.stringify(commandNames))

  console.log("[pi-local] the deepseek provider exposes its four static models")
  first.send({ id: "models", type: "get_available_models" })
  const modelsResponse = await first.waitFor(
    (event) => event.type === "response" && event.id === "models",
  )
  const deepseekModels = (modelsResponse.data?.models ?? []).filter(
    (m) => m.provider === "deepseek",
  )
  assert.deepEqual(
    deepseekModels.map((m) => m.id),
    ["deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"],
  )
  assert.ok(deepseekModels.every((m) => m.api === "openai-completions"))

  balanceRequestCount = 0
  const full = await first.runCommand("balance-1", "/deepseek-balance")
  assert.match(full.message, /^DeepSeek balance: available$/m)
  assert.match(full.message, /CNY\s+total 110\.00 · granted 10\.00 · topped-up 100\.00/)
  assert.match(full.message, /USD\s+total 5\.00 · granted 0\.00 · topped-up 5\.00/)
  assert.equal(lastAuthorization, `Bearer ${FAKE_KEY}`)
  assert.equal(balanceRequestCount, 1)

  console.log("[pi-local] a repeat within 5s is throttled without a new request")
  const throttled = await first.runCommand("balance-2", "/deepseek-balance")
  assert.match(throttled.message, /wait \ds before checking again/i)
  assert.equal(balanceRequestCount, 1)

  console.log("[pi-local] /deepseek-refresh applies the remote model list")
  modelsRequestCount = 0
  const refreshed = await first.runCommand("refresh-1", "/deepseek-refresh")
  assert.match(refreshed.message, /refreshed from server/)
  assert.match(refreshed.message, /brand-new-model/)
  assert.match(refreshed.message, /added: brand-new-model/)
  assert.match(refreshed.message, /removed: .*deepseek/)
  assert.ok(modelsRequestCount >= 1)
  first.send({ id: "models-after-refresh", type: "get_available_models" })
  const refreshedModelsResponse = await first.waitFor(
    (event) => event.type === "response" && event.id === "models-after-refresh",
  )
  const refreshedDeepSeekModels = (refreshedModelsResponse.data?.models ?? []).filter(
    (m) => m.provider === "deepseek",
  )
  assert.deepEqual(
    refreshedDeepSeekModels.map((m) => m.id),
    ["deepseek-flash", "brand-new-model"],
  )
  first.close()

  // -- Session 2: insufficient-balance fixture ------------------------------
  console.log("[pi-local] is_available=false renders an insufficient warning")
  scenario = "insufficient"
  const second = startRpcSession()
  const insufficient = await second.runCommand("balance-insufficient", "/deepseek-balance")
  assert.match(insufficient.message, /^DeepSeek balance: insufficient balance for API calls$/m)
  assert.match(insufficient.message, /CNY\s+total 0\.00/)
  second.close()

  // -- Session 3: 401 from the endpoint --------------------------------------
  console.log("[pi-local] a 401 surfaces a clear error notification")
  scenario = "unauthorized"
  const third = startRpcSession()
  const unauthorized = await third.runCommand("balance-401", "/deepseek-balance")
  assert.equal(
    unauthorized.notifyType,
    "error",
    `expected an error-level notification, got fields: ${Object.keys(unauthorized).join(",")}`,
  )
  assert.match(unauthorized.message, /401/)
  assert.match(unauthorized.message, /rejected the API key/i)
  third.close()

  // -- Session 4: query while the main agent request is still pending --------
  console.log("[pi-local] /deepseek-balance runs while the main agent is busy")
  scenario = "full"
  const fourth = startRpcSession()
  fourth.send({
    id: "set-flash-model",
    type: "set_model",
    provider: "deepseek",
    modelId: "deepseek-flash",
  })
  const modelSet = await fourth.waitFor(
    (event) => event.type === "response" && event.id === "set-flash-model",
  )
  assert.equal(modelSet.success, true)

  console.log("[pi-local] deepseek-flash exposes off/low/high/max thinking levels")
  fourth.send({ id: "flash-thinking-levels", type: "get_available_thinking_levels" })
  const thinkingLevels = await fourth.waitFor(
    (event) => event.type === "response" && event.id === "flash-thinking-levels",
  )
  assert.deepEqual(thinkingLevels.data?.levels, ["off", "low", "high", "max"])

  holdChatOpen = true
  const previousChatRequestCount = chatRequestCount
  lastChatPayload = undefined
  fourth.send({ id: "busy-prompt", type: "prompt", message: "hold the response open" })
  const busyPrompt = await fourth.waitFor(
    (event) => event.type === "response" && event.id === "busy-prompt",
  )
  assert.equal(busyPrompt.success, true)
  await waitForCondition(
    () => chatRequestCount === previousChatRequestCount + 1 && lastChatPayload !== undefined,
  )
  // No thinking level selected: pi sends the DeepSeek thinking toggle only
  // when reasoning_effort is set; the default high effort comes from pi.
  assert.ok(["low", "high", "max"].includes(lastChatPayload.reasoning_effort))
  assert.deepEqual(lastChatPayload.thinking, { type: "enabled" })

  balanceRequestCount = 0
  const duringBusyRun = await fourth.runCommand("balance-busy", "/deepseek-balance")
  assert.match(duringBusyRun.message, /^DeepSeek balance: available$/m)
  assert.equal(balanceRequestCount, 1)
  assert.equal(chatRequestCount, previousChatRequestCount + 1)

  const abortEventIndex = fourth.eventCount()
  fourth.send({ id: "abort-busy", type: "abort" })
  await fourth.waitFor(
    (event) => event.type === "response" && event.id === "abort-busy" && event.success,
  )
  await fourth.waitFor((event) => event.type === "agent_settled", abortEventIndex)
  holdChatOpen = false

  console.log("[pi-local] selecting off sends thinking disabled without an effort")
  const offEventIndex = fourth.eventCount()
  fourth.send({ id: "set-thinking-off", type: "set_thinking_level", level: "off" })
  const thinkingOffSet = await fourth.waitFor(
    (event) => event.type === "response" && event.id === "set-thinking-off",
  )
  assert.equal(thinkingOffSet.success, true)

  lastChatPayload = undefined
  const previousOffRequestCount = chatRequestCount
  fourth.send({ id: "off-prompt", type: "prompt", message: "inspect the off toggle" })
  const offPrompt = await fourth.waitFor(
    (event) => event.type === "response" && event.id === "off-prompt",
  )
  assert.equal(offPrompt.success, true)
  await waitForCondition(
    () => chatRequestCount === previousOffRequestCount + 1 && lastChatPayload !== undefined,
  )
  assert.deepEqual(lastChatPayload.thinking, { type: "disabled" })
  assert.equal(lastChatPayload.reasoning_effort, undefined)
  // Let the off turn finish before the next prompt; a running agent rejects
  // new prompt commands.
  await fourth.waitFor((event) => event.type === "agent_settled", offEventIndex)

  console.log("[pi-local] selecting high sends enabled thinking with the high effort")
  fourth.send({ id: "set-thinking-high", type: "set_thinking_level", level: "high" })
  const thinkingHighSet = await fourth.waitFor(
    (event) => event.type === "response" && event.id === "set-thinking-high",
  )
  assert.equal(thinkingHighSet.success, true)

  lastChatPayload = undefined
  const previousHighRequestCount = chatRequestCount
  fourth.send({ id: "high-prompt", type: "prompt", message: "inspect the high effort" })
  const highPrompt = await fourth.waitFor(
    (event) => event.type === "response" && event.id === "high-prompt",
  )
  assert.equal(highPrompt.success, true, JSON.stringify(highPrompt).slice(0, 800))
  await waitForCondition(
    () => chatRequestCount === previousHighRequestCount + 1 && lastChatPayload !== undefined,
  )
  assert.deepEqual(lastChatPayload.thinking, { type: "enabled" })
  assert.equal(lastChatPayload.reasoning_effort, "high")
  fourth.close()

  // -- No credential leaks anywhere ------------------------------------------
  const combined = [first, second, third, fourth].map((session) => session.stderr()).join("\n")
  assert.doesNotMatch(combined, new RegExp(FAKE_KEY))

  console.log("[pi-local] PASS")
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  rmSync(tempHome, { recursive: true, force: true })
}
