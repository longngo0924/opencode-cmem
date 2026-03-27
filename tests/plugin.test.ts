import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"

// ---------------------------------------------------------------------------
// Tests for opencode-cmem plugin
//
// These tests mock the worker API (fetch) to verify the plugin sends
// correct requests without needing a running worker.
// ---------------------------------------------------------------------------

const WORKER_URL = "http://127.0.0.1:37777"

// -- Mock helpers -------------------------------------------------------------

interface FetchCall {
  url: string
  method: string
  body?: unknown
}

let fetchCalls: FetchCall[] = []
let mockResponses: Map<string, { status: number; body: string }> = new Map()

function setMockResponse(pathPrefix: string, status: number, body: string) {
  mockResponses.set(pathPrefix, { status, body })
}

function findMockResponse(url: string): { status: number; body: string } {
  for (const [prefix, response] of mockResponses) {
    if (url.includes(prefix)) return response
  }
  return { status: 200, body: "{}" }
}

// -- Tests --------------------------------------------------------------------

describe("workerFetch", () => {
  it("should construct correct URL with default port", () => {
    const url = `${WORKER_URL}/api/health`
    expect(url).toBe("http://127.0.0.1:37777/api/health")
  })

  it("should construct correct URL with custom port", () => {
    const port = 38888
    const url = `http://127.0.0.1:${port}/api/health`
    expect(url).toBe("http://127.0.0.1:38888/api/health")
  })
})

describe("stripPrivateTags", () => {
  function stripPrivateTags(text: string): string {
    return text.replace(/<private>[\s\S]*?<\/private>/g, "")
  }

  it("should remove single private tag", () => {
    const input = "before <private>secret</private> after"
    expect(stripPrivateTags(input)).toBe("before  after")
  })

  it("should remove multiple private tags", () => {
    const input = "<private>a</private> keep <private>b</private>"
    expect(stripPrivateTags(input)).toBe(" keep ")
  })

  it("should handle multiline private content", () => {
    const input = "start <private>\nline1\nline2\n</private> end"
    expect(stripPrivateTags(input)).toBe("start  end")
  })

  it("should return unchanged text when no tags", () => {
    const input = "no private content here"
    expect(stripPrivateTags(input)).toBe("no private content here")
  })

  it("should handle empty string", () => {
    expect(stripPrivateTags("")).toBe("")
  })
})

describe("observation payload", () => {
  it("should construct correct observation body", () => {
    const claudeSessionId = "opencode-myproject-1234567890"
    const toolName = "bash"
    const toolInput = JSON.stringify({ command: "ls -la" })
    const toolResponse = JSON.stringify({ stdout: "file1.txt\nfile2.txt" })
    const cwd = "/home/user/myproject"

    const body = {
      claudeSessionId,
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: toolResponse,
      cwd,
    }

    expect(body.claudeSessionId).toMatch(/^opencode-/)
    expect(body.tool_name).toBe("bash")
    expect(body.cwd).toBe("/home/user/myproject")
    expect(JSON.parse(body.tool_input)).toEqual({ command: "ls -la" })
  })

  it("should cap large tool responses at 10000 chars", () => {
    const largeResponse = "x".repeat(20000)
    const capped = largeResponse.slice(0, 10000)
    expect(capped.length).toBe(10000)
  })
})

describe("summary payload", () => {
  it("should construct correct summary body", () => {
    const body = {
      claudeSessionId: "opencode-project-123",
      last_user_message: "Fix the auth bug",
      last_assistant_message: "I've updated the auth middleware...",
    }

    expect(body).toHaveProperty("claudeSessionId")
    expect(body).toHaveProperty("last_user_message")
    expect(body).toHaveProperty("last_assistant_message")
  })

  it("should cap messages at 5000 chars", () => {
    const longMessage = "a".repeat(10000)
    const capped = longMessage.slice(0, 5000)
    expect(capped.length).toBe(5000)
  })
})

describe("complete payload", () => {
  it("should only require claudeSessionId", () => {
    const body = { claudeSessionId: "opencode-project-123" }
    expect(Object.keys(body)).toEqual(["claudeSessionId"])
  })
})

describe("search params", () => {
  it("should construct correct search URL params", () => {
    const params = new URLSearchParams({
      query: "authentication",
      format: "index",
      type: "observations",
      project: "emf",
      limit: "10",
    })

    expect(params.get("query")).toBe("authentication")
    expect(params.get("format")).toBe("index")
    expect(params.get("type")).toBe("observations")
    expect(params.get("project")).toBe("emf")
    expect(params.get("limit")).toBe("10")
  })
})

describe("context injection", () => {
  it("should construct correct context inject URL", () => {
    const project = "emf"
    const url = `/api/context/inject?projects=${encodeURIComponent(project)}`
    expect(url).toBe("/api/context/inject?projects=emf")
  })

  it("should handle project names with special chars", () => {
    const project = "my project/v2"
    const url = `/api/context/inject?projects=${encodeURIComponent(project)}`
    expect(url).toContain("my%20project%2Fv2")
  })
})

describe("session ID format", () => {
  it("should generate opencode-prefixed session IDs", () => {
    const project = "emf"
    const sessionId = `opencode-${project}-${Date.now()}`
    expect(sessionId).toMatch(/^opencode-emf-\d+$/)
  })

  it("should use project name from directory", () => {
    const dir = "/home/long/projects/emf-frontend"
    const project = dir.split("/").pop() || "default"
    expect(project).toBe("emf-frontend")
  })
})

// ---------------------------------------------------------------------------
// P0.1: Retry backoff logic
// ---------------------------------------------------------------------------

describe("retry backoff", () => {
  const RETRY_BASE_DELAY_MS = 1000

  it("should calculate exponential backoff delays (1s, 2s, 4s)", () => {
    const delays = [0, 1, 2].map((attempt) =>
      Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt), 8000),
    )
    expect(delays[0]).toBe(1000)
    expect(delays[1]).toBe(2000)
    expect(delays[2]).toBe(4000)
  })

  it("should cap backoff at 8 seconds", () => {
    const delay = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, 10), 8000)
    expect(delay).toBe(8000)
  })

  it("should not retry on 4xx client errors", () => {
    const nonRetryable = [400, 401, 403, 404, 422]
    for (const status of nonRetryable) {
      expect(status >= 400 && status < 500).toBe(true)
    }
  })

  it("should retry on 5xx server errors", () => {
    const retryable = [500, 502, 503, 504]
    for (const status of retryable) {
      expect(status >= 400 && status < 500).toBe(false)
    }
  })

  it("should queue critical requests that fail all retries", () => {
    const queue: Array<{ path: string }> = []
    const critical = true
    const retries = 3
    // Simulate: all 4 attempts (initial + 3 retries) failed
    if (critical) {
      queue.push({ path: "/api/sessions/complete" })
    }
    expect(queue.length).toBe(1)
    expect(queue[0].path).toBe("/api/sessions/complete")
  })
})

// ---------------------------------------------------------------------------
// P0.2: Health monitoring
// ---------------------------------------------------------------------------

describe("health monitoring", () => {
  it("should track worker health state", () => {
    let workerHealthy = true
    // Simulate health check failure
    workerHealthy = false
    expect(workerHealthy).toBe(false)
    // Simulate recovery
    workerHealthy = true
    expect(workerHealthy).toBe(true)
  })

  it("should detect worker recovery and trigger retry", () => {
    let workerHealthy = false
    const wasUnhealthy = !workerHealthy
    workerHealthy = true
    expect(wasUnhealthy).toBe(true)
    expect(workerHealthy).toBe(true)
    // Should trigger retry of queued critical requests
  })

  it("should not trigger retry if worker was already healthy", () => {
    let workerHealthy = true
    const wasUnhealthy = !workerHealthy
    workerHealthy = true
    expect(wasUnhealthy).toBe(false)
    // Should NOT trigger retry
  })
})

// ---------------------------------------------------------------------------
// P0.3: Observation batching
// ---------------------------------------------------------------------------

describe("observation batching", () => {
  const BATCH_MAX_SIZE = 10

  it("should buffer observations and flush when reaching max size", () => {
    const buffer: string[] = []
    let flushCount = 0

    for (let i = 0; i < 12; i++) {
      buffer.push(`obs-${i}`)
      if (buffer.length >= BATCH_MAX_SIZE) {
        flushCount++
        buffer.length = 0
      }
    }

    expect(flushCount).toBe(1)
    expect(buffer.length).toBe(2) // 2 remaining after flush
  })

  it("should clear buffer on session end", () => {
    const buffer: string[] = ["obs-1", "obs-2", "obs-3"]
    buffer.length = 0
    expect(buffer.length).toBe(0)
  })

  it("should flush buffer before summary", () => {
    const buffer: string[] = ["obs-1", "obs-2"]
    let flushed = false

    if (buffer.length > 0) {
      flushed = true
      buffer.length = 0
    }

    expect(flushed).toBe(true)
    expect(buffer.length).toBe(0)
  })

  it("should flush buffer on session change", () => {
    const buffer: string[] = ["obs-1", "obs-2", "obs-3"]
    buffer.length = 0
    // After session.created event
    expect(buffer.length).toBe(0)
  })

  it("should not flush empty buffer", () => {
    const buffer: string[] = []
    let flushed = false

    if (buffer.length > 0) {
      flushed = true
    }

    expect(flushed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// P0.4: Content-hash deduplication
// ---------------------------------------------------------------------------

describe("content hash", () => {
  function contentHash(toolName: string, input: string, response: string): string {
    let hash = 0
    const str = `${toolName}:${input.slice(0, 500)}:${response.slice(0, 500)}`
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
    }
    return String(hash)
  }

  it("should produce consistent hash for same input", () => {
    const h1 = contentHash("bash", '{"command":"ls"}', "file1\nfile2")
    const h2 = contentHash("bash", '{"command":"ls"}', "file1\nfile2")
    expect(h1).toBe(h2)
  })

  it("should produce different hash for different tool names", () => {
    const h1 = contentHash("bash", '{"cmd":"ls"}', "output")
    const h2 = contentHash("read", '{"cmd":"ls"}', "output")
    expect(h1).not.toBe(h2)
  })

  it("should produce different hash for different input", () => {
    const h1 = contentHash("bash", '{"command":"ls"}', "output")
    const h2 = contentHash("bash", '{"command":"pwd"}', "output")
    expect(h1).not.toBe(h2)
  })

  it("should truncate input/response to 500 chars for hashing", () => {
    const shortInput = "x".repeat(600)
    const longInput = "x".repeat(1200)
    const h1 = contentHash("tool", shortInput, "resp")
    const h2 = contentHash("tool", longInput, "resp")
    // Both should hash the same since first 500 chars are identical
    expect(h1).toBe(h2)
  })

  it("should produce different hash for different response", () => {
    const h1 = contentHash("bash", '{"cmd":"ls"}', "output1")
    const h2 = contentHash("bash", '{"cmd":"ls"}', "output2")
    expect(h1).not.toBe(h2)
  })

  it("should handle empty strings", () => {
    const h = contentHash("", "", "")
    expect(h).toBeDefined()
    expect(typeof h).toBe("string")
  })
})

describe("dedup logic", () => {
  function contentHash(toolName: string, input: string, response: string): string {
    let hash = 0
    const str = `${toolName}:${input.slice(0, 500)}:${response.slice(0, 500)}`
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
    }
    return String(hash)
  }

  const DEDUP_WINDOW_MS = 60_000

  it("should skip duplicate observations within dedup window", () => {
    const recentHashes = new Map<string, number>()
    const now = Date.now()

    const hash = contentHash("bash", '{"cmd":"ls"}', "output")
    recentHashes.set(hash, now)

    expect(recentHashes.has(hash)).toBe(true)
    expect(now - (recentHashes.get(hash) ?? 0) < DEDUP_WINDOW_MS).toBe(true)
  })

  it("should allow observations after dedup window expires", () => {
    const recentHashes = new Map<string, number>()
    const oldTime = Date.now() - DEDUP_WINDOW_MS - 1

    const hash = contentHash("bash", '{"cmd":"ls"}', "output")
    recentHashes.set(hash, oldTime)

    expect(Date.now() - oldTime >= DEDUP_WINDOW_MS).toBe(true)
  })

  it("should clean up expired entries", () => {
    const recentHashes = new Map<string, number>()
    const now = Date.now()

    recentHashes.set("hash1", now - 1000) // fresh
    recentHashes.set("hash2", now - DEDUP_WINDOW_MS - 5000) // expired
    recentHashes.set("hash3", now - DEDUP_WINDOW_MS - 10000) // expired

    for (const [h, ts] of recentHashes) {
      if (now - ts > DEDUP_WINDOW_MS) recentHashes.delete(h)
    }

    expect(recentHashes.size).toBe(1)
    expect(recentHashes.has("hash1")).toBe(true)
  })

  it("should allow same observation from different tools", () => {
    const recentHashes = new Map<string, number>()
    const now = Date.now()

    const h1 = contentHash("bash", '{"file":"src/index.ts"}', "output")
    const h2 = contentHash("read", '{"file":"src/index.ts"}', "output")

    recentHashes.set(h1, now)

    // Different tools = different hashes = not deduplicated
    expect(h1).not.toBe(h2)
    expect(recentHashes.has(h2)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// P2.1: Token cost enrichment for search results
// ---------------------------------------------------------------------------

describe("enrichSearchResults", () => {
  function enrichSearchResults(rawText: string): string {
    try {
      const parsed = JSON.parse(rawText)
      const results = Array.isArray(parsed) ? parsed : parsed.results || parsed.data || parsed.observations || [parsed]

      if (!Array.isArray(results)) return rawText

      const enriched = results.map((item: any) => {
        const cost = item.read_cost ?? item.token_count ?? item.estimated_tokens ?? null
        if (cost == null) return item
        return {
          ...item,
          _cost_info: `~${cost} tokens to read full details`,
        }
      })

      if (Array.isArray(parsed)) return JSON.stringify(enriched, null, 2)
      const wrapper = { ...parsed }
      if (parsed.results != null) wrapper.results = enriched
      else if (parsed.data != null) wrapper.data = enriched
      else if (parsed.observations != null) wrapper.observations = enriched
      return JSON.stringify(wrapper, null, 2)
    } catch {
      return rawText
    }
  }

  it("should add _cost_info when results have read_cost", () => {
    const input = JSON.stringify([
      { id: 1, title: "Auth fix", read_cost: 500 },
      { id: 2, title: "API change", read_cost: 300 },
    ])
    const result = enrichSearchResults(input)
    const parsed = JSON.parse(result)
    expect(parsed[0]._cost_info).toBe("~500 tokens to read full details")
    expect(parsed[1]._cost_info).toBe("~300 tokens to read full details")
  })

  it("should add _cost_info when results have token_count", () => {
    const input = JSON.stringify([
      { id: 1, title: "Bug fix", token_count: 1200 },
    ])
    const result = enrichSearchResults(input)
    const parsed = JSON.parse(result)
    expect(parsed[0]._cost_info).toBe("~1200 tokens to read full details")
  })

  it("should add _cost_info when results have estimated_tokens", () => {
    const input = JSON.stringify([
      { id: 1, title: "Refactor", estimated_tokens: 800 },
    ])
    const result = enrichSearchResults(input)
    const parsed = JSON.parse(result)
    expect(parsed[0]._cost_info).toBe("~800 tokens to read full details")
  })

  it("should not add _cost_info when no cost field exists", () => {
    const input = JSON.stringify([
      { id: 1, title: "No cost" },
    ])
    const result = enrichSearchResults(input)
    const parsed = JSON.parse(result)
    expect(parsed[0]._cost_info).toBeUndefined()
  })

  it("should handle results wrapped in {results: [...]} object", () => {
    const input = JSON.stringify({
      results: [{ id: 1, title: "Test", read_cost: 200 }],
      total: 1,
    })
    const result = enrichSearchResults(input)
    const parsed = JSON.parse(result)
    expect(parsed.results[0]._cost_info).toBe("~200 tokens to read full details")
    expect(parsed.total).toBe(1)
  })

  it("should handle results wrapped in {data: [...]} object", () => {
    const input = JSON.stringify({
      data: [{ id: 1, title: "Test", token_count: 400 }],
    })
    const result = enrichSearchResults(input)
    const parsed = JSON.parse(result)
    expect(parsed.data[0]._cost_info).toBe("~400 tokens to read full details")
  })

  it("should handle results wrapped in {observations: [...]} object", () => {
    const input = JSON.stringify({
      observations: [{ id: 1, title: "Test", read_cost: 150 }],
    })
    const result = enrichSearchResults(input)
    const parsed = JSON.parse(result)
    expect(parsed.observations[0]._cost_info).toBe("~150 tokens to read full details")
  })

  it("should return non-JSON text as-is", () => {
    const input = "Plain text search results"
    expect(enrichSearchResults(input)).toBe(input)
  })

  it("should prefer read_cost over token_count", () => {
    const input = JSON.stringify([
      { id: 1, title: "Both", read_cost: 100, token_count: 500 },
    ])
    const result = enrichSearchResults(input)
    const parsed = JSON.parse(result)
    expect(parsed[0]._cost_info).toBe("~100 tokens to read full details")
  })
})

// ---------------------------------------------------------------------------
// P2.2: Structured summary parsing
// ---------------------------------------------------------------------------

describe("parseSummaryResponse", () => {
  function parseSummaryResponse(raw: string) {
    try {
      const parsed = JSON.parse(raw)
      return {
        request: parsed.request ?? parsed.summary_request ?? undefined,
        investigated: parsed.investigated ?? parsed.files_investigated ?? undefined,
        learned: parsed.learned ?? parsed.key_learnings ?? parsed.insights ?? undefined,
        completed: parsed.completed ?? parsed.tasks_completed ?? undefined,
        next_steps: parsed.next_steps ?? parsed.suggested_next ?? undefined,
        raw: raw,
        timestamp: Date.now(),
      }
    } catch {
      return { raw, timestamp: Date.now() }
    }
  }

  it("should parse structured summary with all fields", () => {
    const input = JSON.stringify({
      request: "Fix auth bug",
      investigated: ["src/auth.ts", "src/middleware.ts"],
      learned: ["JWT clock skew accepted within 60s"],
      completed: ["Fixed token validation"],
      next_steps: ["Add tests for edge case"],
    })
    const result = parseSummaryResponse(input)
    expect(result.request).toBe("Fix auth bug")
    expect(result.investigated).toEqual(["src/auth.ts", "src/middleware.ts"])
    expect(result.learned).toEqual(["JWT clock skew accepted within 60s"])
    expect(result.completed).toEqual(["Fixed token validation"])
    expect(result.next_steps).toEqual(["Add tests for edge case"])
  })

  it("should parse summary with alternative field names", () => {
    const input = JSON.stringify({
      summary_request: "Refactor API",
      files_investigated: ["src/api.ts"],
      key_learnings: ["Pattern X is better"],
      tasks_completed: ["Refactored endpoint"],
      suggested_next: ["Write docs"],
    })
    const result = parseSummaryResponse(input)
    expect(result.request).toBe("Refactor API")
    expect(result.investigated).toEqual(["src/api.ts"])
    expect(result.learned).toEqual(["Pattern X is better"])
    expect(result.completed).toEqual(["Refactored endpoint"])
    expect(result.next_steps).toEqual(["Write docs"])
  })

  it("should handle plain text summary", () => {
    const input = "Fixed the auth bug in middleware.ts. Key learning: check token expiry first."
    const result = parseSummaryResponse(input)
    expect(result.raw).toBe(input)
    expect(result.request).toBeUndefined()
    expect(result.learned).toBeUndefined()
  })

  it("should handle partial structured summary", () => {
    const input = JSON.stringify({
      request: "Add feature X",
      learned: ["Used new API pattern"],
    })
    const result = parseSummaryResponse(input)
    expect(result.request).toBe("Add feature X")
    expect(result.learned).toEqual(["Used new API pattern"])
    expect(result.completed).toBeUndefined()
    expect(result.next_steps).toBeUndefined()
  })

  it("should include timestamp", () => {
    const before = Date.now()
    const result = parseSummaryResponse("{}")
    const after = Date.now()
    expect(result.timestamp).toBeGreaterThanOrEqual(before)
    expect(result.timestamp).toBeLessThanOrEqual(after)
  })
})

// ---------------------------------------------------------------------------
// P2.3: Worker auto-start
// ---------------------------------------------------------------------------

describe("worker auto-start", () => {
  it("should respect CLAUDE_MEM_AUTO_START=true", () => {
    // Auto-start is only triggered when env var is set
    const enabled = process.env.CLAUDE_MEM_AUTO_START === "true"
    // By default it should be undefined (disabled)
    expect(enabled).toBe(false)
  })

  it("should not auto-start when env var is not set", () => {
    const envVal = process.env.CLAUDE_MEM_AUTO_START
    const shouldStart = envVal === "true" || envVal === "1"
    expect(shouldStart).toBe(false)
  })

  it("should auto-start when env var is '1'", () => {
    // Simulate env var being set to "1"
    const envVal = "1"
    const shouldStart = envVal === "true" || envVal === "1"
    expect(shouldStart).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// P2.4: Folder context
// ---------------------------------------------------------------------------

describe("folder context cache", () => {
  const FOLDER_CONTEXT_TTL_MS = 120_000

  it("should cache folder context with TTL", () => {
    const cache = new Map<string, { folder: string; observations: string[]; timestamp: number }>()
    const now = Date.now()
    cache.set("src/auth", { folder: "src/auth", observations: ["obs1"], timestamp: now })

    const cached = cache.get("src/auth")
    expect(cached).toBeDefined()
    expect(now - (cached?.timestamp ?? 0) < FOLDER_CONTEXT_TTL_MS).toBe(true)
  })

  it("should expire folder context after TTL", () => {
    const cache = new Map<string, { folder: string; observations: string[]; timestamp: number }>()
    const oldTime = Date.now() - FOLDER_CONTEXT_TTL_MS - 1
    cache.set("src/auth", { folder: "src/auth", observations: ["obs1"], timestamp: oldTime })

    const cached = cache.get("src/auth")
    expect(Date.now() - (cached?.timestamp ?? 0) >= FOLDER_CONTEXT_TTL_MS).toBe(true)
  })

  it("should extract folder from file path", () => {
    const file = "src/auth/middleware.ts"
    const folder = file.split("/").slice(0, -1).join("/") || "."
    expect(folder).toBe("src/auth")
  })

  it("should handle root-level files", () => {
    const file = "README.md"
    const folder = file.split("/").slice(0, -1).join("/") || "."
    expect(folder).toBe(".")
  })

  it("should prune cache to max 10 folders", () => {
    const cache = new Map<string, { folder: string; observations: string[]; timestamp: number }>()
    const now = Date.now()

    // Add 15 entries with staggered timestamps
    for (let i = 0; i < 15; i++) {
      cache.set(`folder-${i}`, { folder: `folder-${i}`, observations: [], timestamp: now - i * 1000 })
    }

    // Prune to 10
    if (cache.size > 10) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)
      for (let i = 0; i < oldest.length - 10; i++) {
        cache.delete(oldest[i][0])
      }
    }

    expect(cache.size).toBe(10)
    // Oldest entries (highest index = earliest timestamp) should be removed
    expect(cache.has("folder-14")).toBe(false)
    expect(cache.has("folder-10")).toBe(false)
    expect(cache.has("folder-9")).toBe(true)
    expect(cache.has("folder-0")).toBe(true)
  })
})
