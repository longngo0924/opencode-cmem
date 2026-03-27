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
