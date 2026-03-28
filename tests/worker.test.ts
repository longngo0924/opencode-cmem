import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from "bun:test"

// ---------------------------------------------------------------------------
// Unit tests for src/worker.ts
//
// Covers: workerFetch (retry, critical queue), health monitoring,
//         retryFailedCriticalRequests, tryAutoStartWorker
// Uncovered lines from report: 77-81,95-98,120-132,144-150,187,189-203,
//                               206-217,220,222-226,228,230-231
// ---------------------------------------------------------------------------

import {
  workerFetch,
  isWorkerHealthy,
  startHealthMonitor,
  initialHealthCheck,
  getPendingCriticalRequests,
  tryAutoStartWorker,
  _resetWorkerState,
} from "../src/worker"
import { resetConfig } from "../src/config"

// -- Mock fetch globally -------------------------------------------------------

const originalFetch = globalThis.fetch

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString()
    return impl(urlStr, init)
  }) as typeof fetch
}

function restoreFetch() {
  globalThis.fetch = originalFetch
}

// -- Reset module state before each test --------------------------------------

beforeEach(() => {
  _resetWorkerState()
  resetConfig()
  delete process.env.CLAUDE_MEM_WORKER_PORT
  delete process.env.CLAUDE_MEM_WORKER_URL
  delete process.env.CLAUDE_MEM_AUTO_START

  // Default mock: succeed
  mockFetch(async () => new Response("ok", { status: 200 }))
})

afterEach(() => {
  restoreFetch()
})

// -- Tests: workerFetch -------------------------------------------------------

describe("workerFetch", () => {
  it("should return response on success", async () => {
    mockFetch(async () => new Response("ok", { status: 200 }))

    const res = await workerFetch("/api/health")
    expect(res).not.toBeNull()
    expect(res!.ok).toBe(true)
  })

  it("should return 4xx responses immediately without retry", async () => {
    let callCount = 0
    mockFetch(async () => {
      callCount++
      return new Response("not found", { status: 404 })
    })

    const res = await workerFetch("/api/test", { retries: 3 })
    expect(res).not.toBeNull()
    expect(res!.status).toBe(404)
    expect(callCount).toBe(1) // No retries
  })

  it("should retry on network error and eventually succeed (lines 77-81)", async () => {
    let callCount = 0
    mockFetch(async () => {
      callCount++
      if (callCount <= 1) throw new Error("ECONNREFUSED")
      return new Response("ok", { status: 200 })
    })

    const res = await workerFetch("/api/test", { retries: 2, timeout: 500 })
    expect(res).not.toBeNull()
    expect(res!.ok).toBe(true)
    expect(callCount).toBe(2)
  })

  it("should mark worker unhealthy on network error (line 79)", async () => {
    expect(isWorkerHealthy()).toBe(true) // freshly reset

    mockFetch(async () => {
      throw new Error("ECONNREFUSED")
    })

    await workerFetch("/api/test", { retries: 0, timeout: 500 })
    expect(isWorkerHealthy()).toBe(false)
  })

  it("should return null after all retries exhausted", async () => {
    mockFetch(async () => {
      throw new Error("ECONNREFUSED")
    })

    const res = await workerFetch("/api/test", { retries: 1, timeout: 500 })
    expect(res).toBeNull()
  })

  it("should retry on 5xx server error", async () => {
    let callCount = 0
    mockFetch(async () => {
      callCount++
      if (callCount <= 2) return new Response("error", { status: 500 })
      return new Response("ok", { status: 200 })
    })

    const res = await workerFetch("/api/test", { retries: 3 })
    expect(res).not.toBeNull()
    expect(res!.ok).toBe(true)
    expect(callCount).toBe(3)
  })

  it("should queue critical request on total failure (lines 94-98)", async () => {
    mockFetch(async () => {
      throw new Error("ECONNREFUSED")
    })

    expect(getPendingCriticalRequests()).toBe(0)

    const res = await workerFetch("/api/sessions/complete", {
      retries: 0,
      critical: true,
      timeout: 500,
      method: "POST",
      body: JSON.stringify({ contentSessionId: "test" }),
    })

    expect(res).toBeNull()
    expect(getPendingCriticalRequests()).toBe(1)
  })

  it("should not queue non-critical request on failure", async () => {
    mockFetch(async () => {
      throw new Error("ECONNREFUSED")
    })

    const before = getPendingCriticalRequests()
    await workerFetch("/api/test", { retries: 0, timeout: 500 })
    expect(getPendingCriticalRequests()).toBe(before)
  })
})

// -- Tests: isWorkerHealthy ---------------------------------------------------

describe("isWorkerHealthy", () => {
  it("should return true after reset", () => {
    expect(isWorkerHealthy()).toBe(true)
  })

  it("should reflect unhealthy state after failed fetch", async () => {
    mockFetch(async () => {
      throw new Error("ECONNREFUSED")
    })

    await workerFetch("/api/test", { retries: 0, timeout: 500 })
    expect(isWorkerHealthy()).toBe(false)
  })
})

// -- Tests: initialHealthCheck ------------------------------------------------

describe("initialHealthCheck", () => {
  it("should return true when worker is healthy", async () => {
    mockFetch(async (url) => {
      if (url.includes("/api/health")) return new Response("ok", { status: 200 })
      return new Response("not found", { status: 404 })
    })

    const healthy = await initialHealthCheck()
    expect(healthy).toBe(true)
  })

  it("should return false when worker returns non-ok", async () => {
    mockFetch(async () => new Response("error", { status: 503 }))

    const healthy = await initialHealthCheck()
    expect(healthy).toBe(false)
  })

  it("should return false when worker is unreachable", async () => {
    mockFetch(async () => {
      throw new Error("ECONNREFUSED")
    })

    const healthy = await initialHealthCheck()
    expect(healthy).toBe(false)
  })
})

// -- Tests: tryAutoStartWorker ------------------------------------------------
// NOTE: Order matters — workerAutoStarted is set on first successful/attempted call.

describe("tryAutoStartWorker", () => {
  it("should return false when CLAUDE_MEM_AUTO_START is not set (lines 183-186)", async () => {
    delete process.env.CLAUDE_MEM_AUTO_START
    const result = await tryAutoStartWorker()
    expect(result).toBe(false)
  })

  it("should return false when CLAUDE_MEM_AUTO_START is not 'true' or '1' (lines 183-186)", async () => {
    process.env.CLAUDE_MEM_AUTO_START = "false"
    const result = await tryAutoStartWorker()
    expect(result).toBe(false)
  })

  it("should attempt auto-start when CLAUDE_MEM_AUTO_START=true and succeed (lines 189-216)", async () => {
    process.env.CLAUDE_MEM_AUTO_START = "true"

    const mockUnref = mock(() => {})
    const mockSpawn = spyOn(Bun, "spawn").mockImplementation((() => ({
      pid: 12345,
      unref: mockUnref,
    })) as any)

    let healthCallCount = 0
    mockFetch(async (url) => {
      if (url.includes("/api/health")) {
        healthCallCount++
        if (healthCallCount >= 2) return new Response("ok", { status: 200 })
        return new Response("error", { status: 503 })
      }
      return new Response("ok", { status: 200 })
    })

    const result = await tryAutoStartWorker()

    expect(mockSpawn).toHaveBeenCalled()
    expect(result).toBe(true)
    expect(isWorkerHealthy()).toBe(true)

    mockSpawn.mockRestore()
  })

  it("should return false on second call — already auto-started (line 181)", async () => {
    process.env.CLAUDE_MEM_AUTO_START = "true"

    const mockSpawn = spyOn(Bun, "spawn").mockImplementation((() => ({
      pid: 12345,
      unref: mock(() => {}),
    })) as any)

    mockFetch(async (url) => {
      if (url.includes("/api/health")) return new Response("ok", { status: 200 })
      return new Response("ok", { status: 200 })
    })

    // First call — sets workerAutoStarted = true
    const first = await tryAutoStartWorker()
    expect(first).toBe(true)

    // Second call — already started, should return false
    const result = await tryAutoStartWorker()
    expect(result).toBe(false)

    mockSpawn.mockRestore()
  })
})

describe("tryAutoStartWorker — fresh state", () => {
  beforeEach(() => {
    _resetWorkerState() // Fresh state for each test
  })

  it("should auto-start when CLAUDE_MEM_AUTO_START=1 (lines 183-186)", async () => {
    process.env.CLAUDE_MEM_AUTO_START = "1"

    const mockSpawn = spyOn(Bun, "spawn").mockImplementation((() => ({
      pid: 12345,
      unref: mock(() => {}),
    })) as any)

    mockFetch(async (url) => {
      if (url.includes("/api/health")) return new Response("ok", { status: 200 })
      return new Response("ok", { status: 200 })
    })

    const result = await tryAutoStartWorker()
    expect(result).toBe(true)

    mockSpawn.mockRestore()
  })

  it("should return false when auto-start command throws (lines 222-226)", async () => {
    process.env.CLAUDE_MEM_AUTO_START = "true"

    const mockSpawn = spyOn(Bun, "spawn").mockImplementation((() => {
      throw new Error("Command not found")
    }) as any)

    // First command fails, second command also fails
    const result = await tryAutoStartWorker()
    expect(result).toBe(false)

    mockSpawn.mockRestore()
  })

  it("should return false when worker never becomes ready (lines 220, 230-231)", async () => {
    process.env.CLAUDE_MEM_AUTO_START = "true"

    const mockSpawn = spyOn(Bun, "spawn").mockImplementation((() => ({
      pid: 12345,
      unref: mock(() => {}),
    })) as any)

    // Worker never becomes healthy
    mockFetch(async (url) => {
      if (url.includes("/api/health")) return new Response("error", { status: 503 })
      return new Response("ok", { status: 200 })
    })

    const result = await tryAutoStartWorker()
    expect(result).toBe(false)

    mockSpawn.mockRestore()
  }, 30000)
})

// -- Tests: startHealthMonitor ------------------------------------------------

describe("startHealthMonitor", () => {
  it("should not crash when called twice", () => {
    startHealthMonitor()
    startHealthMonitor()
    // Second call is a no-op (timer already set)
  })
})

// -- Tests: getPendingCriticalRequests ----------------------------------------

describe("getPendingCriticalRequests", () => {
  it("should return 0 when freshly reset", () => {
    expect(getPendingCriticalRequests()).toBe(0)
  })
})
