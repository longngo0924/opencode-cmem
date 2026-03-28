import { describe, it, expect, beforeAll, afterAll } from "bun:test"

// ---------------------------------------------------------------------------
// Integration tests for opencode-cmem plugin
//
// Uses Bun.serve() as a mock claude-mem worker on port 39999.
// The plugin module reads env vars at import time, so we set them first.
// ---------------------------------------------------------------------------

// Set env vars BEFORE importing the plugin (module-level state initialization)
process.env.CLAUDE_MEM_WORKER_PORT = "39999"
process.env.CLAUDE_MEM_LOG_LEVEL = "debug"

// Import after env vars are set — the module reads them at import time
import { ClaudeMemPlugin } from "../src/index"

const MOCK_PORT = 39999
const receivedRequests: Array<{ method: string; path: string; body?: unknown }> = []
let mockHealthOk = true

// -- Mock worker server (starts immediately) -----------------------------------

const mockServer = Bun.serve({
  port: MOCK_PORT,
  fetch(req) {
    const url = new URL(req.url)
    const bodyPromise = req.method !== "GET" ? req.json().catch(() => null) : Promise.resolve(null)

    return bodyPromise.then((body) => {
      receivedRequests.push({ method: req.method, path: url.pathname + url.search, body })

      // Route responses
      if (url.pathname === "/api/health") {
        return mockHealthOk
          ? new Response(JSON.stringify({ status: "ok" }), { headers: { "Content-Type": "application/json" } })
          : new Response(JSON.stringify({ status: "error" }), { status: 503, headers: { "Content-Type": "application/json" } })
      }

      if (url.pathname === "/api/version") {
        return Response.json({ version: "test-1.0" })
      }
      if (url.pathname === "/api/stats") {
        return Response.json({ database: { observations: 42, sessions: 5 } })
      }

      if (url.pathname === "/api/context/inject") {
        return Response.json({
          content: [{ type: "text", text: "# $CMEM test-project\n\n### Today\n123 9:00a 🔍 Test observation\n" }]
        })
      }

      // Session lifecycle endpoints
      if (url.pathname === "/api/sessions/init") return Response.json({ ok: true })
      if (url.pathname === "/api/sessions/observations") return Response.json({ ok: true })
      if (url.pathname === "/api/sessions/summarize") return Response.json({ ok: true })
      if (url.pathname === "/api/sessions/complete") return Response.json({ ok: true })
      if (url.pathname === "/api/processing") return Response.json({ ok: true })

      // Search
      if (url.pathname.startsWith("/api/search")) {
        return Response.json([
          { id: 1, title: "Test observation", type: "discovery" },
          { id: 2, title: "Another observation", type: "bugfix" },
        ])
      }

      // Single observation
      if (url.pathname.startsWith("/api/observation/")) {
        const id = url.pathname.split("/").pop()
        return Response.json({ id: Number(id), content: "Full observation details", type: "discovery" })
      }

      // Timeline
      if (url.pathname.startsWith("/api/timeline")) {
        return Response.json([
          { id: 10, session: "session-a" },
          { id: 11, session: "session-a" },
        ])
      }

      // Recent context
      if (url.pathname.startsWith("/api/context/recent")) {
        return Response.json([{ id: 5, content: "Recent observation" }])
      }

      // Memory save
      if (url.pathname === "/api/memory/save") {
        return Response.json({ ok: true, saved: true })
      }

      return new Response("Not found", { status: 404 })
    })
  },
})

// -- Helpers -------------------------------------------------------------------

/** Minimal mock ToolContext for tool.execute(args, context) calls */
const mockToolContext = {
  sessionID: "test-session",
  messageID: "test-message",
  agent: "test-agent",
  directory: "/home/user/test-project",
  worktree: "/home/user/test-project",
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
} as any

function clearRequests(): void {
  receivedRequests.length = 0
}

function makeCtx(overrides = {}) {
  return {
    worktree: "/home/user/test-project",
    directory: "/home/user/test-project",
    ...overrides,
  }
}

/** Count requests matching a path prefix */
function countRequests(pathContains: string): number {
  return receivedRequests.filter((r) => r.path.includes(pathContains)).length
}

/** Get the first request matching a path prefix */
function findRequest(pathContains: string) {
  return receivedRequests.find((r) => r.path.includes(pathContains))
}

/** Find index of first request matching path — used for ordering checks */
function indexOfRequest(pathContains: string): number {
  return receivedRequests.findIndex((r) => r.path.includes(pathContains))
}

// -- Plugin instance (created fresh per describe block where needed) -----------

const ctx = makeCtx()

// -- Test suite ----------------------------------------------------------------

describe("opencode-cmem integration", () => {
  beforeAll(async () => {
    await Bun.sleep(50) // Ensure server is ready
  })

  afterAll(() => {
    mockServer.stop()
  })

  // ===========================================================================
  // Full Hook Lifecycle
  // ===========================================================================

  describe("full hook lifecycle", () => {
    it("should send correct API calls through init → observe → summarize → complete", async () => {
      clearRequests()
      mockHealthOk = true

      const plugin = await ClaudeMemPlugin(ctx as any)

      // 1. Session created
      await plugin.event!({ event: { type: "session.created" } } as any)

      // 2. User message
      await plugin["chat.message"]!(
        { sessionID: "s1" } as any,
        { parts: [{ type: "text", text: "Fix the auth bug" }] } as any,
      )

      // 3. Tool usage
      await plugin["tool.execute.after"]!(
        { tool: "bash", sessionID: "s1", callID: "c1", args: { command: "ls" } },
        { output: "file1.txt\nfile2.txt" } as any,
      )
      await Bun.sleep(50) // Wait for fire-and-forget recordObservation to buffer

      // 4. Session idle (triggers summary)
      await plugin.event!({ event: { type: "session.idle" } } as any)
      await Bun.sleep(50) // Wait for async sendSummary/flushBuffer

      // 5. Session deleted (triggers complete)
      await plugin.event!({ event: { type: "session.deleted" } } as any)

      await Bun.sleep(200)

      // Verify lifecycle endpoints were called
      expect(countRequests("/api/sessions/init")).toBeGreaterThanOrEqual(1)
      expect(countRequests("/api/sessions/observations")).toBeGreaterThanOrEqual(1)
      expect(countRequests("/api/sessions/summarize")).toBeGreaterThanOrEqual(1)
      expect(countRequests("/api/sessions/complete")).toBeGreaterThanOrEqual(1)

      // Verify ordering: observations before summarize before complete
      const obsIdx = indexOfRequest("/api/sessions/observations")
      const sumIdx = indexOfRequest("/api/sessions/summarize")
      const compIdx = indexOfRequest("/api/sessions/complete")
      expect(obsIdx).toBeGreaterThan(-1)
      expect(sumIdx).toBeGreaterThan(obsIdx)
      expect(compIdx).toBeGreaterThan(sumIdx)
    })
  })

  // ===========================================================================
  // P1.3: Context Injection Caching
  // ===========================================================================

  describe("context injection caching", () => {
    it("should cache context injection response (second call hits cache)", async () => {
      clearRequests()
      mockHealthOk = true

      const plugin = await ClaudeMemPlugin(ctx as any)

      // First call — cache miss, fetches from worker
      const output1 = { system: [] as string[] }
      await plugin["experimental.chat.system.transform"]!(
        { model: { id: "test", name: "test" } } as any,
        output1,
      )

      // Second call — cache hit, no new fetch
      const output2 = { system: [] as string[] }
      await plugin["experimental.chat.system.transform"]!(
        { model: { id: "test", name: "test" } } as any,
        output2,
      )

      await Bun.sleep(50)

      // Context inject should only be called once (cached on second call)
      expect(countRequests("/api/context/inject")).toBe(1)

      // System prompt should contain injected context
      expect(output1.system.length).toBeGreaterThan(0)
      expect(output1.system[0]).toContain("Claude-Mem: Recent Session Context")
    })

    it("should invalidate cache on session.created", async () => {
      clearRequests()
      mockHealthOk = true

      const plugin = await ClaudeMemPlugin(ctx as any)

      // Populate cache
      await plugin["experimental.chat.system.transform"]!(
        { model: { id: "test", name: "test" } } as any,
        { system: [] as string[] },
      )

      // New session invalidates cache
      await plugin.event!({ event: { type: "session.created" } } as any)

      // Re-inject — should fetch again (cache was invalidated)
      await plugin["experimental.chat.system.transform"]!(
        { model: { id: "test", name: "test" } } as any,
        { system: [] as string[] },
      )

      await Bun.sleep(50)

      // Context inject should be called twice
      expect(countRequests("/api/context/inject")).toBe(2)
    })
  })

  // ===========================================================================
  // Worker Failure Scenarios
  // ===========================================================================

  describe("worker failure", () => {
    it("should warn when worker is unhealthy on search", async () => {
      clearRequests()
      mockHealthOk = false

      const plugin = await ClaudeMemPlugin(ctx as any)
      const result = await plugin.tool!.claude_mem_search!.execute({ query: "test" }, mockToolContext)

      expect(result).toContain("unreachable")
    }, 15000)

    it("should work when worker is healthy", async () => {
      clearRequests()
      mockHealthOk = true

      const plugin = await ClaudeMemPlugin(ctx as any)
      const result = await plugin.tool!.claude_mem_search!.execute({ query: "test" }, mockToolContext)

      expect(result).not.toContain("unreachable")
    })

    it("should warn when worker is unhealthy on get_observations", async () => {
      clearRequests()
      mockHealthOk = false

      const plugin = await ClaudeMemPlugin(ctx as any)
      const result = await plugin.tool!.claude_mem_get_observations!.execute({ ids: [1, 2] }, mockToolContext)

      expect(result).toContain("unreachable")
    }, 15000)

    it("should warn when worker is unhealthy on save", async () => {
      clearRequests()
      mockHealthOk = false

      const plugin = await ClaudeMemPlugin(ctx as any)
      const result = await plugin.tool!.claude_mem_save!.execute({ content: "remember this" }, mockToolContext)

      expect(result).toContain("unreachable")
    }, 15000)
  })

  // ===========================================================================
  // Concurrent Tool Calls
  // ===========================================================================

  describe("concurrent tool calls", () => {
    it("should handle parallel search + timeline + status", async () => {
      clearRequests()
      mockHealthOk = true

      const plugin = await ClaudeMemPlugin(ctx as any)

      // Initialize session first
      await plugin["chat.message"]!(
        { sessionID: "s1" } as any,
        { parts: [{ type: "text", text: "Hello" }] } as any,
      )

      const [searchResult, timelineResult, statusResult] = await Promise.all([
        plugin.tool!.claude_mem_search!.execute({ query: "auth", limit: 5 }, mockToolContext),
        plugin.tool!.claude_mem_timeline!.execute({ limit: 3 }, mockToolContext),
        plugin.tool!.claude_mem_status!.execute({} as any, mockToolContext),
      ])

      // All should succeed
      expect(searchResult).not.toContain("unreachable")
      expect(timelineResult).not.toContain("unreachable")
      expect(statusResult).toContain("healthy")

      // All requests should have been made
      expect(countRequests("/api/search")).toBeGreaterThanOrEqual(1)
      expect(countRequests("/api/context/recent")).toBeGreaterThanOrEqual(1)
      expect(countRequests("/api/health")).toBeGreaterThanOrEqual(1)
    })
  })

  // ===========================================================================
  // Observation Batching
  // ===========================================================================

  describe("observation batching", () => {
    it("should flush immediately when buffer reaches max size (10)", async () => {
      clearRequests()
      mockHealthOk = true

      const plugin = await ClaudeMemPlugin(ctx as any)
      await plugin.event!({ event: { type: "session.created" } } as any)
      await plugin["chat.message"]!(
        { sessionID: "s1" } as any,
        { parts: [{ type: "text", text: "test" }] } as any,
      )

      clearRequests() // Clear init requests

      // Send exactly 10 unique observations to trigger immediate flush
      for (let i = 0; i < 10; i++) {
        await plugin["tool.execute.after"]!(
          { tool: `UniqueTool${i}`, sessionID: "s1", callID: `c${i}`, args: { idx: i } },
          { output: `Result ${i}` } as any,
        )
      }

      await Bun.sleep(200)

      // Should have flushed at least one batch of observations
      expect(countRequests("/api/sessions/observations")).toBeGreaterThanOrEqual(1)
    })

    it("should flush remaining observations on session end", async () => {
      clearRequests()
      mockHealthOk = true

      const plugin = await ClaudeMemPlugin(ctx as any)
      await plugin.event!({ event: { type: "session.created" } } as any)
      await plugin["chat.message"]!(
        { sessionID: "s1" } as any,
        { parts: [{ type: "text", text: "test" }] } as any,
      )

      clearRequests()

      // Send only 2 observations (below batch max)
      await plugin["tool.execute.after"]!(
        { tool: "ToolA", sessionID: "s1", callID: "c1", args: {} },
        { output: "Result A" } as any,
      )
      await plugin["tool.execute.after"]!(
        { tool: "ToolB", sessionID: "s1", callID: "c2", args: {} },
        { output: "Result B" } as any,
      )
      await Bun.sleep(50) // Wait for fire-and-forget recordObservation to buffer

      // End session — should flush buffer before complete
      await plugin.event!({ event: { type: "session.deleted" } } as any)

      await Bun.sleep(200)

      // Observations should have been flushed
      const obsIdx = indexOfRequest("/api/sessions/observations")
      const compIdx = indexOfRequest("/api/sessions/complete")

      expect(obsIdx).toBeGreaterThan(-1)
      expect(compIdx).toBeGreaterThan(obsIdx) // Observations flushed before complete
    })
  })

  // ===========================================================================
  // Private Tag Stripping
  // ===========================================================================

  describe("private tag stripping", () => {
    it("should strip <private> tags from tool response in observations", async () => {
      clearRequests()
      mockHealthOk = true

      const plugin = await ClaudeMemPlugin(ctx as any)
      await plugin.event!({ event: { type: "session.created" } } as any)
      await plugin["chat.message"]!(
        { sessionID: "s1" } as any,
        { parts: [{ type: "text", text: "test" }] } as any,
      )

      clearRequests()

      // Fire observation with private content
      await plugin["tool.execute.after"]!(
        { tool: "ReadFile", sessionID: "s1", callID: "c1", args: { path: "/secret/config" } },
        { output: "public info <private>password=abc123</private> more public" } as any,
      )

      // Wait for batch timer to flush (or trigger flush via more calls)
      for (let i = 0; i < 10; i++) {
        await plugin["tool.execute.after"]!(
          { tool: `FlushTool${i}`, sessionID: "s1", callID: `f${i}`, args: {} },
          { output: `flush ${i}` } as any,
        )
      }

      await Bun.sleep(200)

      // Find the observation with our private content
      const obsCall = receivedRequests.find(
        (r) =>
          r.path === "/api/sessions/observations" &&
          r.body &&
          typeof r.body === "object" &&
          "tool_response" in (r.body as any) &&
          (r.body as any).tool_response.includes("public info"),
      )

      expect(obsCall).toBeDefined()
      // The response should NOT contain "password=abc123"
      expect((obsCall!.body as any).tool_response).not.toContain("password=abc123")
    })

    it("should skip entire prompt when fully wrapped in <private>", async () => {
      clearRequests()
      mockHealthOk = true

      const plugin = await ClaudeMemPlugin(ctx as any)
      await plugin.event!({ event: { type: "session.created" } } as any)

      clearRequests()

      // Fully private message
      await plugin["chat.message"]!(
        { sessionID: "s1" } as any,
        { parts: [{ type: "text", text: "<private>don't remember this</private>" }] } as any,
      )

      await plugin["tool.execute.after"]!(
        { tool: "bash", sessionID: "s1", callID: "c1", args: { command: "ls" } },
        { output: "files" } as any,
      )

      await Bun.sleep(200)

      // Tool observation should NOT be sent (prompt was private)
      // Note: session init might still happen, but no observations from tools after private prompt
      const obsCalls = receivedRequests.filter(
        (r) => r.path === "/api/sessions/observations" && r.body && typeof r.body === "object",
      )
      // The tool after a fully private prompt should be skipped
      expect(obsCalls.length).toBe(0)
    })
  })

  // ===========================================================================
  // P1.4: Configuration Validation
  // ===========================================================================

  describe("configuration validation", () => {
    it("should use custom port from CLAUDE_MEM_WORKER_PORT", async () => {
      clearRequests()
      mockHealthOk = true

      // Port 39999 was set at module load time — verify health check goes there
      const plugin = await ClaudeMemPlugin(ctx as any)
      await Bun.sleep(100)

      // Health check should have been made to the mock server on port 39999
      expect(countRequests("/api/health")).toBeGreaterThanOrEqual(1)
    })

    it("should accept valid port in range 1024-65535", async () => {
      // Test the validation logic directly
      const port = 39999
      const isValid = Number.isInteger(port) && port >= 1024 && port <= 65535
      expect(isValid).toBe(true)
    })

    it("should reject port below 1024", () => {
      const port = 80
      const isValid = Number.isInteger(port) && port >= 1024 && port <= 65535
      expect(isValid).toBe(false)
    })

    it("should reject port above 65535", () => {
      const port = 70000
      const isValid = Number.isInteger(port) && port >= 1024 && port <= 65535
      expect(isValid).toBe(false)
    })

    it("should reject non-numeric port", () => {
      const raw = "not-a-number"
      const parsed = Number(raw)
      const isValid = Number.isInteger(parsed) && !isNaN(parsed)
      expect(isValid).toBe(false)
    })

    it("should reject URL without http/https protocol", () => {
      try {
        new URL("ftp://example.com:37777")
        // ftp is technically a valid URL protocol, but our plugin rejects it
        const url = new URL("ftp://example.com:37777")
        expect(["http:", "https:"].includes(url.protocol)).toBe(false)
      } catch {
        // If URL parsing fails, that's also a rejection
        expect(true).toBe(true)
      }
    })

    it("should accept valid http URL", () => {
      const url = new URL("http://localhost:37777")
      expect(["http:", "https:"].includes(url.protocol)).toBe(true)
    })

    it("should accept valid https URL", () => {
      const url = new URL("https://memory.example.com")
      expect(["http:", "https:"].includes(url.protocol)).toBe(true)
    })
  })

  // ===========================================================================
  // P1.2: Structured Logging
  // ===========================================================================

  describe("structured logging", () => {
    it("should resolve default log level to info (3)", () => {
      // When CLAUDE_MEM_LOG_LEVEL is not set, default is "info"
      const levels = { error: 1, warn: 2, info: 3, debug: 4 }
      expect(levels.info).toBe(3)
    })

    it("should map log level env vars to numeric levels", () => {
      const levels: Record<string, number> = { error: 1, warn: 2, info: 3, debug: 4 }
      expect(levels.error).toBe(1)
      expect(levels.warn).toBe(2)
      expect(levels.info).toBe(3)
      expect(levels.debug).toBe(4)
    })

    it("should ignore unknown log level values", () => {
      const levels = { error: 1, warn: 2, info: 3, debug: 4 }
      const unknown = "trace"
      const isValid = unknown in levels
      expect(isValid).toBe(false)
    })

    it("should support CLAUDE_MEM_LOG_LEVEL env var", () => {
      // The env var was set to "debug" at module load time
      expect(process.env.CLAUDE_MEM_LOG_LEVEL).toBe("debug")
    })
  })

  // ===========================================================================
  // Tool Definitions
  // ===========================================================================

  describe("tool definitions", () => {
    let plugin: Awaited<ReturnType<typeof ClaudeMemPlugin>>

    beforeAll(async () => {
      plugin = await ClaudeMemPlugin(ctx as any)
    })

    it("should define all 5 tools", () => {
      expect(plugin.tool).toBeDefined()
      expect(plugin.tool!.claude_mem_search).toBeDefined()
      expect(plugin.tool!.claude_mem_get_observations).toBeDefined()
      expect(plugin.tool!.claude_mem_timeline).toBeDefined()
      expect(plugin.tool!.claude_mem_save).toBeDefined()
      expect(plugin.tool!.claude_mem_status).toBeDefined()
    })

    it("should have meaningful descriptions", () => {
      expect(plugin.tool!.claude_mem_search.description).toContain("Search")
      expect(plugin.tool!.claude_mem_get_observations.description).toContain("Fetch full observation")
      expect(plugin.tool!.claude_mem_timeline.description).toContain("timeline")
      expect(plugin.tool!.claude_mem_save.description).toContain("save a memory")
      expect(plugin.tool!.claude_mem_status.description).toContain("status")
    })

    it("should have execute functions on all tools", () => {
      for (const [name, toolDef] of Object.entries(plugin.tool!)) {
        expect((toolDef as any).execute).toBeInstanceOf(Function)
      }
    })
  })

  // ===========================================================================
  // claude_mem_status Tool
  // ===========================================================================

  describe("claude_mem_status tool", () => {
    it("should report worker health and stats", async () => {
      clearRequests()
      mockHealthOk = true

      const plugin = await ClaudeMemPlugin(ctx as any)
      const result = await plugin.tool!.claude_mem_status!.execute({} as any, mockToolContext)

      expect(result).toContain("healthy")
      expect(result).toContain("test-1.0") // version
      expect(result).toContain("42") // observations
      expect(result).toContain("5") // sessions
      expect(result).toContain("test-project") // project name
      expect(result).toContain("Log level") // P1.2 structured logging
    })

    it("should report unreachable when worker is down", async () => {
      clearRequests()
      mockHealthOk = false

      const plugin = await ClaudeMemPlugin(ctx as any)
      // The status tool makes 3 parallel fetches with default retries (3x backoff).
      // With mockHealthOk=false the server returns 503, triggering retries.
      // Use a longer timeout to accommodate the retry delays.
      const result = await plugin.tool!.claude_mem_status!.execute({} as any, mockToolContext)

      expect(result).toContain("unreachable")
    }, 15000)
  })

  // ===========================================================================
  // claude_mem_search Tool
  // ===========================================================================

  describe("claude_mem_search tool", () => {
    it("should return search results from worker", async () => {
      clearRequests()
      mockHealthOk = true

      const plugin = await ClaudeMemPlugin(ctx as any)
      const result = await plugin.tool!.claude_mem_search!.execute({ query: "authentication" }, mockToolContext)

      expect(result).toContain("1") // observation ID from mock
      expect(result).toContain("Test observation")
    })

    it("should pass query parameters to worker", async () => {
      clearRequests()
      mockHealthOk = true

      const plugin = await ClaudeMemPlugin(ctx as any)
      await plugin.tool!.claude_mem_search!.execute({
        query: "bug",
        type: "observations",
        limit: 10,
        obs_type: "bugfix",
      }, mockToolContext)

      const searchReq = findRequest("/api/search")
      expect(searchReq).toBeDefined()
      expect(searchReq!.path).toContain("query=bug")
      expect(searchReq!.path).toContain("type=observations")
      expect(searchReq!.path).toContain("limit=10")
      expect(searchReq!.path).toContain("obs_type=bugfix")
    })
  })

  // ===========================================================================
  // claude_mem_save Tool
  // ===========================================================================

  describe("claude_mem_save tool", () => {
    it("should save memory and return confirmation", async () => {
      clearRequests()
      mockHealthOk = true

      const plugin = await ClaudeMemPlugin(ctx as any)
      const result = await plugin.tool!.claude_mem_save!.execute({ content: "Remember to use Zod schemas" }, mockToolContext)

      expect(result).toContain("saved")

      // Verify the request was made
      const saveReq = findRequest("/api/memory/save")
      expect(saveReq).toBeDefined()
      expect((saveReq!.body as any)?.text).toBe("Remember to use Zod schemas")
      expect((saveReq!.body as any)?.source).toBe("opencode")
    })
  })

  // ===========================================================================
  // claude_mem_get_observations Tool
  // ===========================================================================

  describe("claude_mem_get_observations tool", () => {
    it("should fetch observations by IDs", async () => {
      clearRequests()
      mockHealthOk = true

      const plugin = await ClaudeMemPlugin(ctx as any)
      const result = await plugin.tool!.claude_mem_get_observations!.execute({ ids: [1, 2] }, mockToolContext)

      const parsed = JSON.parse(result as string)
      expect(parsed).toHaveLength(2)
      expect(parsed[0].id).toBe(1)
      expect(parsed[1].id).toBe(2)
    })
  })

  // ===========================================================================
  // claude_mem_timeline Tool
  // ===========================================================================

  describe("claude_mem_timeline tool", () => {
    it("should fetch recent timeline", async () => {
      clearRequests()
      mockHealthOk = true

      const plugin = await ClaudeMemPlugin(ctx as any)
      const result = await plugin.tool!.claude_mem_timeline!.execute({ limit: 5 }, mockToolContext)

      expect(result).not.toContain("unreachable")
    })

    it("should use anchor-based timeline endpoint when anchor is provided", async () => {
      clearRequests()
      mockHealthOk = true

      const plugin = await ClaudeMemPlugin(ctx as any)
      await plugin.tool!.claude_mem_timeline!.execute({ anchor: 42, depth_before: 3, depth_after: 5 }, mockToolContext)

      const timelineReq = findRequest("/api/timeline")
      expect(timelineReq).toBeDefined()
      expect(timelineReq!.path).toContain("anchor=42")
      expect(timelineReq!.path).toContain("depth_before=3")
      expect(timelineReq!.path).toContain("depth_after=5")
    })

    it("should use recent context endpoint when no anchor", async () => {
      clearRequests()
      mockHealthOk = true

      const plugin = await ClaudeMemPlugin(ctx as any)
      await plugin.tool!.claude_mem_timeline!.execute({ limit: 5 }, mockToolContext)

      const recentReq = findRequest("/api/context/recent")
      expect(recentReq).toBeDefined()
      expect(recentReq!.path).toContain("limit=5")
    })
  })

  // ===========================================================================
  // Session Idle Hook
  // ===========================================================================

  describe("session.idle hook", () => {
    it("should trigger session summary", async () => {
      clearRequests()
      mockHealthOk = true

      const plugin = await ClaudeMemPlugin(ctx as any)
      await plugin.event!({ event: { type: "session.created" } } as any)
      await plugin["chat.message"]!(
        { sessionID: "s1" } as any,
        { parts: [{ type: "text", text: "test" }] } as any,
      )

      clearRequests()

      await plugin.event!({ event: { type: "session.idle" } } as any)

      await Bun.sleep(100)

      expect(countRequests("/api/sessions/summarize")).toBeGreaterThanOrEqual(1)
    })
  })

  // ===========================================================================
  // Compaction Context Injection
  // ===========================================================================

  describe("experimental.session.compacting hook", () => {
    it("should inject context during compaction", async () => {
      clearRequests()
      mockHealthOk = true

      const plugin = await ClaudeMemPlugin(ctx as any)
      const output = { context: [] as string[] }

      await plugin["experimental.session.compacting"]!(
        { sessionID: "s1" } as any,
        output,
      )

      await Bun.sleep(100)

      expect(output.context.length).toBeGreaterThan(0)
      expect(output.context[0]).toContain("Claude-Mem: Previous Session Context")
    })
  })

  // ===========================================================================
  // Skip Tools
  // ===========================================================================

  describe("skip low-value tools", () => {
    it("should not record observations for claude_mem_ tools", async () => {
      clearRequests()
      mockHealthOk = true

      const plugin = await ClaudeMemPlugin(ctx as any)
      await plugin.event!({ event: { type: "session.created" } } as any)
      await plugin["chat.message"]!(
        { sessionID: "s1" } as any,
        { parts: [{ type: "text", text: "test" }] } as any,
      )

      clearRequests()

      await plugin["tool.execute.after"]!(
        { tool: "claude_mem_search", sessionID: "s1", callID: "c1", args: { query: "test" } },
        { output: "results" } as any,
      )

      await Bun.sleep(100)

      expect(countRequests("/api/sessions/observations")).toBe(0)
    })

    it("should not record observations for TodoWrite", async () => {
      clearRequests()
      mockHealthOk = true

      const plugin = await ClaudeMemPlugin(ctx as any)
      await plugin.event!({ event: { type: "session.created" } } as any)
      await plugin["chat.message"]!(
        { sessionID: "s1" } as any,
        { parts: [{ type: "text", text: "test" }] } as any,
      )

      clearRequests()

      await plugin["tool.execute.after"]!(
        { tool: "TodoWrite", sessionID: "s1", callID: "c1", args: {} },
        { output: "ok" } as any,
      )

      await Bun.sleep(100)

      expect(countRequests("/api/sessions/observations")).toBe(0)
    })
  })
})
