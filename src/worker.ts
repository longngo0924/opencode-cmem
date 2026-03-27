// ---------------------------------------------------------------------------
// opencode-cmem — Worker HTTP client
//
// Handles all communication with the claude-mem worker, including:
// - Fetch with exponential backoff retry
// - Periodic health monitoring
// - Failed critical request queuing
// - Worker auto-start
// ---------------------------------------------------------------------------

import {
  RETRY_MAX,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  HEALTH_CHECK_INTERVAL_MS,
} from "./constants"
import { log } from "./logger"
import { getWorkerUrl } from "./config"

// -- Health state (module-level, shared across plugin instances) -------------

let workerHealthy = true
let healthCheckTimer: ReturnType<typeof setInterval> | null = null

// Queue of critical requests that failed and should be retried on recovery
const failedCriticalRequests: Array<{
  path: string
  init: RequestInit
}> = []

// -- Fetch with retry -------------------------------------------------------

interface FetchOptions extends RequestInit {
  /** Request timeout in ms (default: 5000). */
  timeout?: number
  /** Number of retries (default: RETRY_MAX). */
  retries?: number
  /** If true, queue request for later retry on total failure. */
  critical?: boolean
}

/**
 * Fetch with exponential backoff retry.
 *
 * - Retries up to `retries` times with 1s × 2^attempt backoff (capped at 8s).
 * - Non-retryable HTTP status codes (4xx) return immediately.
 * - Critical requests are queued for later retry if all attempts fail.
 */
export async function workerFetch(
  path: string,
  init?: FetchOptions,
): Promise<Response | null> {
  const {
    timeout = 5000,
    retries = RETRY_MAX,
    critical = false,
    ...fetchInit
  } = init ?? {}

  let lastError: Error | unknown = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const url = `${getWorkerUrl()}${path}`
      const startTime = Date.now()
      const res = await fetch(url, {
        ...fetchInit,
        signal: AbortSignal.timeout(timeout),
      })
      const elapsed = Date.now() - startTime
      log.debug(`${fetchInit.method || "GET"} ${path} → ${res.status} (${elapsed}ms)`)

      if (res.ok) return res
      // 4xx errors are client-side and not retryable
      if (res.status >= 400 && res.status < 500) return res
      lastError = new Error(`HTTP ${res.status}`)
    } catch (err) {
      lastError = err
      workerHealthy = false
      log.debug(
        `Request to ${path} failed (attempt ${attempt + 1}/${retries + 1}): ${err instanceof Error ? err.message : err}`,
      )
    }

    if (attempt < retries) {
      const delay = Math.min(
        RETRY_BASE_DELAY_MS * Math.pow(2, attempt),
        RETRY_MAX_DELAY_MS,
      )
      await new Promise((r) => setTimeout(r, delay))
    }
  }

  if (critical) {
    failedCriticalRequests.push({ path, init: fetchInit })
    log.warn(
      `Critical request to ${path} failed after ${retries + 1} attempts, queued for retry`,
    )
  }

  return null
}

// -- Health monitoring ------------------------------------------------------

/**
 * Check if the worker is currently considered healthy.
 */
export function isWorkerHealthy(): boolean {
  return workerHealthy
}

/**
 * Start periodic health monitoring. Checks worker health every 30s.
 * When worker recovers, retries any queued critical requests.
 */
export function startHealthMonitor(): void {
  if (healthCheckTimer) return

  healthCheckTimer = setInterval(async () => {
    try {
      const res = await fetch(`${getWorkerUrl()}/api/health`, {
        signal: AbortSignal.timeout(2000),
      })
      const wasUnhealthy = !workerHealthy
      workerHealthy = res.ok

      if (wasUnhealthy && workerHealthy) {
        log.info("Worker recovered, retrying queued critical requests")
        await retryFailedCriticalRequests()
      }
    } catch {
      workerHealthy = false
    }
  }, HEALTH_CHECK_INTERVAL_MS)

  // Don't prevent process exit
  if (healthCheckTimer.unref) healthCheckTimer.unref()
}

/**
 * Retry all queued critical requests. Called when worker recovers.
 */
async function retryFailedCriticalRequests(): Promise<void> {
  const requests = failedCriticalRequests.splice(0)
  for (const { path, init } of requests) {
    const res = await workerFetch(path, { ...init, retries: 1, critical: true })
    if (res?.ok) {
      log.info(`Successfully retried critical request to ${path}`)
    }
  }
}

/**
 * Run an initial health check (non-blocking).
 * Returns whether the worker is healthy.
 */
export async function initialHealthCheck(): Promise<boolean> {
  const res = await workerFetch("/api/health", { timeout: 2000, retries: 0 })
  workerHealthy = !!(res && res.ok)
  return workerHealthy
}

/**
 * Get the number of queued critical requests (for status reporting).
 */
export function getPendingCriticalRequests(): number {
  return failedCriticalRequests.length
}

// -- Worker auto-start ------------------------------------------------------

let workerAutoStarted = false

/**
 * Attempt to auto-start the claude-mem worker if health check fails.
 * Controlled by `CLAUDE_MEM_AUTO_START` env var (default: disabled).
 * Tries common binary paths and `npx` fallback.
 */
export async function tryAutoStartWorker(): Promise<boolean> {
  if (workerAutoStarted) return false
  if (
    process.env.CLAUDE_MEM_AUTO_START !== "true" &&
    process.env.CLAUDE_MEM_AUTO_START !== "1"
  ) {
    return false
  }

  workerAutoStarted = true
  const commands = [
    "claude-mem worker start",
    "npx claude-mem worker start",
  ]

  for (const cmd of commands) {
    try {
      const proc = Bun.spawn(cmd.split(" "), {
        stdout: "inherit",
        stderr: "inherit",
        detached: true,
      })
      proc.unref()
      log.info(`Auto-starting worker: ${cmd} (PID ${proc.pid})`)

      // Wait briefly for worker to become ready
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        try {
          const res = await fetch(`${getWorkerUrl()}/api/health`, {
            signal: AbortSignal.timeout(2000),
          })
          if (res.ok) {
            log.info("Worker auto-start succeeded")
            workerHealthy = true
            return true
          }
        } catch {
          // Not ready yet
        }
      }

      log.warn(`Worker auto-start via "${cmd}" did not become ready in time`)
    } catch (err) {
      log.debug(
        `Auto-start command "${cmd}" not available: ${err instanceof Error ? err.message : err}`,
      )
    }
  }

  log.warn("Worker auto-start failed. Start manually: claude-mem worker start")
  return false
}
