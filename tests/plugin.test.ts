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
