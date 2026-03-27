import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

// ---------------------------------------------------------------------------
// opencode-cmem — OpenCode plugin for claude-mem
//
// Bridges claude-mem's worker API (port 37777) into OpenCode's plugin system.
// Shares the same worker + SQLite database as Claude Code, so knowledge
// flows between both tools automatically.
//
// Based on: https://docs.claude-mem.ai/platform-integration
// Implements the 5-stage hook lifecycle:
//   1. SessionStart  → POST /api/sessions/init      (register session + prompt)
//                    → GET  /api/context/inject      (inject prior context)
//   2. UserPrompt    → POST /api/sessions/init       (register each prompt)
//   3. PostToolUse   → POST /api/sessions/observations (capture tool usage)
//   4. Stop/Summary  → POST /api/sessions/summarize
//   5. SessionEnd    → POST /api/sessions/complete
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 37777
const RETRY_MAX = 3
const RETRY_BASE_DELAY_MS = 1000
const HEALTH_CHECK_INTERVAL_MS = 30_000
const BATCH_FLUSH_INTERVAL_MS = 5_000
const BATCH_MAX_SIZE = 10
const DEDUP_WINDOW_MS = 60_000
const CONTEXT_CACHE_TTL_MS = 60_000
const FOLDER_CONTEXT_TTL_MS = 120_000

// -- P1.2: Structured logging ---------------------------------------------------

type LogLevel = "error" | "warn" | "info" | "debug"
const LOG_LEVELS: Record<LogLevel, number> = { error: 1, warn: 2, info: 3, debug: 4 }

function resolveLogLevel(): number {
  const envLevel = process.env.CLAUDE_MEM_LOG_LEVEL?.toLowerCase()
  if (envLevel && envLevel in LOG_LEVELS) return LOG_LEVELS[envLevel as LogLevel]
  return LOG_LEVELS.info // default
}

const currentLogLevel = resolveLogLevel()

const log = {
  debug: (...args: unknown[]) => currentLogLevel >= 4 && console.debug("[claude-mem]", ...args),
  info: (...args: unknown[]) => currentLogLevel >= 3 && console.info("[claude-mem]", ...args),
  warn: (...args: unknown[]) => currentLogLevel >= 2 && console.warn("[claude-mem]", ...args),
  error: (...args: unknown[]) => currentLogLevel >= 1 && console.error("[claude-mem]", ...args),
}

// -- P1.4: Configuration validation ---------------------------------------------

interface WorkerConfig {
  url: string
  port: number
  errors: string[]
}

let _validatedConfig: WorkerConfig | null = null

function validateConfig(): WorkerConfig {
  if (_validatedConfig) return _validatedConfig

  const errors: string[] = []
  let port = DEFAULT_PORT
  let baseUrl = ""

  // Validate CLAUDE_MEM_WORKER_PORT
  if (process.env.CLAUDE_MEM_WORKER_PORT) {
    const raw = process.env.CLAUDE_MEM_WORKER_PORT
    const parsed = Number(raw)
    if (!Number.isInteger(parsed) || isNaN(parsed)) {
      errors.push(`CLAUDE_MEM_WORKER_PORT="${raw}" is not a valid integer`)
    } else if (parsed < 1024 || parsed > 65535) {
      errors.push(`CLAUDE_MEM_WORKER_PORT=${parsed} is out of range (1024-65535)`)
    } else {
      port = parsed
    }
  }

  // Validate CLAUDE_MEM_WORKER_URL
  if (process.env.CLAUDE_MEM_WORKER_URL) {
    try {
      const url = new URL(process.env.CLAUDE_MEM_WORKER_URL)
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        errors.push(`CLAUDE_MEM_WORKER_URL must use http:// or https://, got "${url.protocol}"`)
      } else {
        baseUrl = process.env.CLAUDE_MEM_WORKER_URL.replace(/\/+$/, "")
      }
    } catch {
      errors.push(`CLAUDE_MEM_WORKER_URL="${process.env.CLAUDE_MEM_WORKER_URL}" is not a valid URL`)
    }
  }

  const url = baseUrl || `http://127.0.0.1:${port}`

  _validatedConfig = { url, port, errors }
  return _validatedConfig
}

function getWorkerUrl(): string {
  return validateConfig().url
}

// -- Health monitoring (module-level, shared across plugin instances) ---------

let workerHealthy = true
let healthCheckTimer: ReturnType<typeof setInterval> | null = null

// Queue of critical requests that failed and should be retried when worker recovers
const failedCriticalRequests: Array<{ path: string; init: RequestInit }> = []

/**
 * Fetch with exponential backoff retry (P0.1).
 *
 * - Retries up to `retries` times with 1s × 2^attempt backoff (1s, 2s, 4s).
 * - Non-retryable HTTP status codes (4xx) return immediately.
 * - Critical requests (session init, complete, summary) are queued for later
 *   retry if all attempts fail.
 */
async function workerFetch(
  path: string,
  init?: RequestInit & { timeout?: number; retries?: number; critical?: boolean },
): Promise<Response | null> {
  const { timeout = 5000, retries = RETRY_MAX, critical = false, ...fetchInit } = init || {}
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
      log.debug(`Request to ${path} failed (attempt ${attempt + 1}/${retries + 1}): ${err instanceof Error ? err.message : err}`)
    }

    if (attempt < retries) {
      const delay = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt), 8000)
      await new Promise((r) => setTimeout(r, delay))
    }
  }

  if (critical) {
    failedCriticalRequests.push({ path, init: fetchInit })
    log.warn(`Critical request to ${path} failed after ${retries + 1} attempts, queued for retry`)
  }

  return null
}

/**
 * Strip privacy and recursion-prevention tags before sending to worker.
 * - <private>...</private> — user-level privacy control
 * - <claude-mem-context>...</claude-mem-context> — system-level recursion prevention
 */
function stripPrivateTags(text: string): string {
  return text
    .replace(/<private>[\s\S]*?<\/private>/g, "")
    .replace(/<claude-mem-context>[\s\S]*?<\/claude-mem-context>/g, "")
}

/**
 * Simple deterministic content hash for deduplication (P0.4).
 * Uses first 500 chars of input/response to avoid hashing huge payloads.
 */
function contentHash(toolName: string, input: string, response: string): string {
  let hash = 0
  const str = `${toolName}:${input.slice(0, 500)}:${response.slice(0, 500)}`
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return String(hash)
}

/**
 * Start periodic health monitoring (P0.2). Checks worker health every 30s.
 * When worker recovers, retries any queued critical requests.
 */
function startHealthMonitor(): void {
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

// -- P2.1: Token cost enrichment for search results ----------------------------

/**
 * Parse worker search response and surface token cost information.
 * The worker returns results that may include `read_cost` or `token_count`
 * fields. We enrich the response so the LLM can make informed decisions
 * about how many full observations to fetch.
 */
function enrichSearchResults(rawText: string): string {
  try {
    const parsed = JSON.parse(rawText)
    // Handle both array and object wrappers
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

    // Preserve the original wrapper structure
    if (Array.isArray(parsed)) return JSON.stringify(enriched, null, 2)
    const wrapper = { ...parsed }
    if (parsed.results != null) wrapper.results = enriched
    else if (parsed.data != null) wrapper.data = enriched
    else if (parsed.observations != null) wrapper.observations = enriched
    return JSON.stringify(wrapper, null, 2)
  } catch {
    // Not JSON — return as-is (worker may return plain text)
    return rawText
  }
}

// -- P2.3: Worker auto-start ---------------------------------------------------

let workerAutoStarted = false

/**
 * Attempt to auto-start the claude-mem worker if health check fails.
 * Controlled by CLAUDE_MEM_AUTO_START env var (default: disabled).
 * Tries common binary paths and `npx` fallback.
 */
async function tryAutoStartWorker(): Promise<boolean> {
  if (workerAutoStarted) return false
  if (process.env.CLAUDE_MEM_AUTO_START !== "true" && process.env.CLAUDE_MEM_AUTO_START !== "1") {
    return false
  }

  workerAutoStarted = true
  const commands = [
    "claude-mem worker start",
    "npx claude-mem worker start",
  ]

  for (const cmd of commands) {
    try {
      const binary = cmd.split(" ")[0]
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
      log.debug(`Auto-start command "${cmd}" not available: ${err instanceof Error ? err.message : err}`)
    }
  }

  log.warn("Worker auto-start failed. Start manually: claude-mem worker start")
  return false
}

// -- P2.2: Structured summary storage ------------------------------------------

/**
 * Stored structured session summary from the worker.
 * Used to enhance context injection with learned patterns.
 */
interface StructuredSummary {
  request?: string
  investigated?: string[]
  learned?: string[]
  completed?: string[]
  next_steps?: string[]
  raw?: string
  timestamp: number
}

let lastSummary: StructuredSummary | null = null

/**
 * Parse the worker's summarize response into a structured summary.
 * The worker may return JSON with sections like Request, Investigated,
 * Learned, Completed, Next Steps — or a plain text summary.
 */
function parseSummaryResponse(raw: string): StructuredSummary {
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

// -- P2.4: Folder context tracking ---------------------------------------------

interface FolderContext {
  folder: string
  observations: string[]
  timestamp: number
}

const folderContextCache = new Map<string, FolderContext>()

/**
 * Fetch recent observations for a folder and cache them.
 */
async function fetchFolderContext(folder: string, projectName?: string): Promise<string> {
  const now = Date.now()
  const cached = folderContextCache.get(folder)
  if (cached && now - cached.timestamp < FOLDER_CONTEXT_TTL_MS) {
    log.debug(`Folder context cache hit for ${folder}`)
    return cached.observations.join("\n")
  }

  try {
    const params = new URLSearchParams({
      query: folder,
      type: "observations",
      limit: "5",
      orderBy: "date_desc",
    })
    if (projectName) params.set("project", projectName)

    const res = await workerFetch(`/api/search?${params}`)
    if (res?.ok) {
      const text = await res.text()
      if (text.trim()) {
        folderContextCache.set(folder, { folder, observations: [text], timestamp: now })
        // Prune old entries (keep max 10 folders)
        if (folderContextCache.size > 10) {
          const oldest = [...folderContextCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)
          for (let i = 0; i < oldest.length - 10; i++) {
            folderContextCache.delete(oldest[i][0])
          }
        }
        return text
      }
    }
  } catch (err) {
    log.debug(`Failed to fetch folder context for ${folder}: ${err instanceof Error ? err.message : err}`)
  }

  return ""
}

// -- Plugin -------------------------------------------------------------------

export const ClaudeMemPlugin: Plugin = async (ctx) => {
  const project =
    ctx.worktree?.split("/").pop() ||
    ctx.directory?.split("/").pop() ||
    "default"

  // Tools that produce low-value observations (matches claude-mem's save-hook skip list)
  const SKIP_TOOLS = new Set([
    "TodoWrite", "AskUserQuestion", "ListMcpResourcesTool",
    "SlashCommand", "Skill",
  ])

  // Session tracking
  let claudeSessionId: string | null = null
  let lastUserMessage = ""
  let lastAssistantMessage = ""
  let contextInjected = false
  let sessionInitialized = false
  let promptPrivate = false
  let summarySent = false
  const recentToolFiles = new Set<string>()

  // P0.3: Observation batching
  interface BufferedObservation {
    contentSessionId: string
    tool_name: string
    tool_input: string
    tool_response: string
    cwd: string
  }
  const observationBuffer: BufferedObservation[] = []
  let batchTimer: ReturnType<typeof setInterval> | null = null

  // P0.4: Content-hash dedup
  const recentHashes = new Map<string, number>() // hash -> timestamp

  // -- Start health monitoring -------------------------------------------------
  startHealthMonitor()

  // -- P1.4: Validate configuration on startup --------------------------------
  const config = validateConfig()
  if (config.errors.length > 0) {
    for (const err of config.errors) log.error(err)
    log.warn(`Using default worker URL: ${config.url}`)
  } else {
    log.info(`Worker URL: ${config.url}`)
  }

  // -- Health check on startup (non-blocking) ---------------------------------
  const healthRes = await workerFetch("/api/health", { timeout: 2000, retries: 0 })
  workerHealthy = !!(healthRes && healthRes.ok)
  if (!workerHealthy) {
    log.warn(
      `Worker not reachable at ${getWorkerUrl()}. Start it with: claude-mem worker start`,
    )
    // P2.3: Attempt auto-start if enabled
    const started = await tryAutoStartWorker()
    if (!started) {
      log.warn("Set CLAUDE_MEM_AUTO_START=true to enable automatic worker startup")
    }
  } else {
    log.info("Worker health check passed")
  }

  // -- P0.3: Observation buffer flush ------------------------------------------
  async function flushBuffer(): Promise<void> {
    if (observationBuffer.length === 0) return

    // Take all items from buffer
    const items = observationBuffer.splice(0)

    // Send in parallel (up to 5 concurrent)
    const batchSize = 5
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize)
      await Promise.all(
        batch.map((obs) =>
          workerFetch("/api/sessions/observations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(obs),
          }),
        ),
      )
    }
  }

  // Start batch flush timer
  function startBatchTimer(): void {
    if (batchTimer) return
    batchTimer = setInterval(() => {
      flushBuffer().catch(() => {})
    }, BATCH_FLUSH_INTERVAL_MS)
    if (batchTimer.unref) batchTimer.unref()
  }

  startBatchTimer()

  // -- P0.4: Dedup cache cleanup (remove entries older than DEDUP_WINDOW_MS) ---
  function cleanDedupCache(): void {
    const now = Date.now()
    for (const [hash, ts] of recentHashes) {
      if (now - ts > DEDUP_WINDOW_MS) recentHashes.delete(hash)
    }
  }

  // -- P1.3: Context injection cache (60s TTL) ----------------------------------
  let contextCache: { text: string; timestamp: number } | null = null

  function invalidateContextCache(): void {
    contextCache = null
  }

  // -- Stage 1: SessionStart — inject prior context ---------------------------
  async function injectContext(): Promise<string> {
    // Return cached context if still valid
    if (contextCache && Date.now() - contextCache.timestamp < CONTEXT_CACHE_TTL_MS) {
      log.debug("Context injection cache hit")
      return contextCache.text
    }

    const res = await workerFetch(
      `/api/context/inject?projects=${encodeURIComponent(project)}`,
      { timeout: 3000 },
    )
    if (res && res.ok) {
      const text = await res.text()
      if (text && text.trim().length > 0) {
        contextCache = { text, timestamp: Date.now() }
        log.debug("Context injection cache miss — fetched and cached")
        // P2.2: Append last session's learned patterns if available
        let enriched = text
        if (lastSummary) {
          const parts: string[] = []
          if (lastSummary.learned?.length) {
            parts.push("### Key Learnings from Last Session\n" + lastSummary.learned.map((l) => `- ${l}`).join("\n"))
          }
          if (lastSummary.next_steps?.length) {
            parts.push("### Suggested Next Steps\n" + lastSummary.next_steps.map((s) => `- ${s}`).join("\n"))
          }
          if (parts.length > 0) {
            enriched = text + "\n\n" + parts.join("\n\n")
          }
        }
        return enriched
      }
    }
    return ""
  }

  // -- Stage 2: Init session + register user prompt with worker ---------------
  async function initSession(prompt: string): Promise<void> {
    if (!claudeSessionId) {
      claudeSessionId = `opencode-${project}-${Date.now()}`
    }

    await workerFetch("/api/sessions/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentSessionId: claudeSessionId,
        project,
        prompt: stripPrivateTags(prompt).slice(0, 5000) || "[opencode session]",
      }),
      critical: true,
    })
    sessionInitialized = true
  }

  // -- Stage 3: Record observation (with batching + dedup) --------------------
  async function recordObservation(
    toolName: string,
    toolInput: unknown,
    toolResponse: unknown,
  ): Promise<void> {
    if (!claudeSessionId) {
      claudeSessionId = `opencode-${project}-${Date.now()}`
    }

    if (!sessionInitialized) {
      await initSession(lastUserMessage || "[opencode session]")
    }

    const inputStr =
      typeof toolInput === "string"
        ? toolInput
        : JSON.stringify(toolInput || {})
    const responseStr =
      typeof toolResponse === "string"
        ? toolResponse
        : JSON.stringify(toolResponse || {})

    // P0.4: Content-hash dedup — skip if seen within dedup window
    const hash = contentHash(toolName, inputStr, responseStr)
    const now = Date.now()
    if (recentHashes.has(hash) && now - (recentHashes.get(hash) ?? 0) < DEDUP_WINDOW_MS) {
      return // Skip duplicate
    }
    recentHashes.set(hash, now)
    cleanDedupCache()

    // P0.3: Buffer observation instead of sending immediately
    const observation: BufferedObservation = {
      contentSessionId: claudeSessionId,
      tool_name: toolName,
      tool_input: stripPrivateTags(inputStr).slice(0, 10000),
      tool_response: stripPrivateTags(responseStr).slice(0, 10000),
      cwd: ctx.directory || process.cwd(),
    }
    observationBuffer.push(observation)

    // Flush immediately if buffer is full
    if (observationBuffer.length >= BATCH_MAX_SIZE) {
      await flushBuffer()
    }
  }

  // -- Stage 4: Stop — generate summary ---------------------------------------
  async function sendSummary(): Promise<void> {
    if (!claudeSessionId || summarySent) return

    // P0.3: Flush remaining observations before summary
    await flushBuffer()

    summarySent = true

    // P2.2: Parse structured summary from worker response
    const summaryRes = await workerFetch("/api/sessions/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentSessionId: claudeSessionId,
        last_user_message: lastUserMessage.slice(0, 5000),
        last_assistant_message: lastAssistantMessage.slice(0, 5000),
      }),
      critical: true,
    })

    if (summaryRes?.ok) {
      const summaryText = await summaryRes.text()
      if (summaryText.trim()) {
        lastSummary = parseSummaryResponse(summaryText)
        log.debug(`Session summary stored (${lastSummary.raw?.length ?? 0} chars)`)
      }
    }

    // Signal processing complete (updates web viewer UI)
    await workerFetch("/api/processing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isProcessing: false }),
      critical: true,
    })
  }

  // -- Stage 5: SessionEnd — complete session ---------------------------------
  async function completeSession(): Promise<void> {
    if (!claudeSessionId) return

    await sendSummary()
    await workerFetch("/api/sessions/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentSessionId: claudeSessionId }),
      critical: true,
    })

    claudeSessionId = null
    lastUserMessage = ""
    lastAssistantMessage = ""
    contextInjected = false
    sessionInitialized = false
    summarySent = false
    recentToolFiles.clear()
    observationBuffer.length = 0
    recentHashes.clear()
    folderContextCache.clear()
  }

  // -- Return plugin definition -----------------------------------------------

  return {
    // == Custom tools (LLM-callable) ==========================================
    tool: {
      claude_mem_search: tool({
        description:
          "Search claude-mem memory for past coding session observations. " +
          "Returns compact index with IDs (~50-100 tokens/result). " +
          "Use get_observations to fetch full details by IDs.",
        args: {
          query: tool.schema.string().describe("Search query keywords"),
          type: tool.schema
            .enum(["all", "observations", "sessions", "prompts"])
            .optional()
            .describe("Type of results (default: all)"),
          limit: tool.schema
            .number()
            .optional()
            .describe("Max results (default: 20)"),
          obs_type: tool.schema
            .enum(["discovery", "decision", "bugfix", "feature", "refactor", "change"])
            .optional()
            .describe("Filter by observation type"),
          concepts: tool.schema
            .string()
            .optional()
            .describe("Filter by concepts (comma-separated)"),
          files: tool.schema
            .string()
            .optional()
            .describe("Filter by file paths (comma-separated)"),
          dateStart: tool.schema
            .string()
            .optional()
            .describe("ISO timestamp filter start"),
          dateEnd: tool.schema
            .string()
            .optional()
            .describe("ISO timestamp filter end"),
          orderBy: tool.schema
            .enum(["date_desc", "date_asc", "relevance"])
            .optional()
            .describe("Sort order (default: relevance)"),
          offset: tool.schema
            .number()
            .optional()
            .describe("Pagination offset"),
        },
        async execute(args) {
          if (!workerHealthy) {
            return (
              "\u26a0\ufe0f claude-mem worker is currently unreachable. " +
              "The search will be attempted but may fail."
            )
          }

          const params = new URLSearchParams({
            query: args.query,
            format: "index",
          })
          if (args.type) params.set("type", args.type)
          if (args.limit) params.set("limit", String(args.limit))
          if (args.obs_type) params.set("obs_type", args.obs_type)
          if (args.concepts) params.set("concepts", args.concepts)
          if (args.files) params.set("files", args.files)
          if (args.dateStart) params.set("dateStart", args.dateStart)
          if (args.dateEnd) params.set("dateEnd", args.dateEnd)
          if (args.orderBy) params.set("orderBy", args.orderBy)
          if (args.offset) params.set("offset", String(args.offset))
          if (project) params.set("project", project)

          const res = await workerFetch(`/api/search?${params}`)
          if (!res) return "claude-mem worker unreachable"
          if (!res.ok) return `Search failed: ${res.status}`
          const rawText = await res.text()
          // P2.1: Enrich results with token cost information
          return enrichSearchResults(rawText)
        },
      }),

      claude_mem_get_observations: tool({
        description:
          "Fetch full observation details by IDs (~500-1000 tokens/result). " +
          "Use after search/timeline to get complete details. " +
          "Always batch multiple IDs in one call.",
        args: {
          ids: tool.schema
            .array(tool.schema.number())
            .describe("Array of observation IDs to fetch"),
        },
        async execute(args) {
          if (!workerHealthy) {
            return "\u26a0\ufe0f claude-mem worker is currently unreachable."
          }

          const results = await Promise.all(
            args.ids.map((id) => workerFetch(`/api/observation/${id}`)),
          )
          const observations: unknown[] = []
          for (const res of results) {
            if (res?.ok) observations.push(await res.json())
            else if (res) observations.push({ error: true, status: res.status })
          }
          return JSON.stringify(observations, null, 2)
        },
      }),

      claude_mem_timeline: tool({
        description:
          "Get a timeline of recent observations from claude-mem. " +
          "Shows what happened in recent coding sessions. " +
          "Can center on a specific observation with anchor.",
        args: {
          limit: tool.schema
            .number()
            .optional()
            .describe("Number of recent sessions (default: 3)"),
          anchor: tool.schema
            .number()
            .optional()
            .describe("Observation ID to center timeline around"),
          depth_before: tool.schema
            .number()
            .optional()
            .describe("Records before anchor (default: 3)"),
          depth_after: tool.schema
            .number()
            .optional()
            .describe("Records after anchor (default: 3)"),
        },
        async execute(args) {
          if (!workerHealthy) {
            return "\u26a0\ufe0f claude-mem worker is currently unreachable."
          }

          // Anchor-based timeline uses a different endpoint
          if (args.anchor != null) {
            const params = new URLSearchParams({ project })
            params.set("anchor", String(args.anchor))
            if (args.depth_before != null) params.set("depth_before", String(args.depth_before))
            if (args.depth_after != null) params.set("depth_after", String(args.depth_after))
            const res = await workerFetch(`/api/timeline?${params}`)
            if (!res) return "claude-mem worker unreachable"
            if (!res.ok) return `Timeline failed: ${res.status}`
            return await res.text()
          }

          const params = new URLSearchParams({
            project,
            limit: String(args.limit || 3),
          })
          const res = await workerFetch(`/api/context/recent?${params}`)
          if (!res) return "claude-mem worker unreachable"
          if (!res.ok) return `Timeline failed: ${res.status}`
          return await res.text()
        },
      }),

      claude_mem_save: tool({
        description:
          "Manually save a memory to claude-mem. " +
          "Use when the user explicitly asks to remember something.",
        args: {
          content: tool.schema
            .string()
            .describe("The memory content to save"),
        },
        async execute(args) {
          if (!workerHealthy) {
            return (
              "\u26a0\ufe0f claude-mem worker is currently unreachable. " +
              "Memory not saved."
            )
          }

          const res = await workerFetch("/api/memory/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: args.content,
              project,
              source: "opencode",
            }),
            critical: true,
          })
          if (!res) return "claude-mem worker unreachable"
          if (!res.ok) return `Save failed: ${res.status}`
          return "Memory saved."
        },
      }),

      claude_mem_status: tool({
        description: "Check claude-mem worker status.",
        args: {},
        async execute() {
          const [health, version, stats] = await Promise.all([
            workerFetch("/api/health", { timeout: 2000 }),
            workerFetch("/api/version", { timeout: 2000 }),
            workerFetch("/api/stats", { timeout: 2000 }),
          ])

          const lines: string[] = []
          lines.push(`Worker: ${health?.ok ? "healthy" : "unreachable"}`)
          lines.push(`Health monitoring: active (${HEALTH_CHECK_INTERVAL_MS / 1000}s interval)`)
          lines.push(`Observation buffer: ${observationBuffer.length} pending`)
          lines.push(`Queued critical requests: ${failedCriticalRequests.length}`)
          lines.push(`Log level: ${process.env.CLAUDE_MEM_LOG_LEVEL || "info"}`)
          lines.push(`Folder context cache: ${folderContextCache.size} folders`)
          lines.push(`Last summary: ${lastSummary ? "available" : "none"}`)

          if (version?.ok) {
            const v = (await version.json()) as { version?: string }
            lines.push(`Version: ${v.version || "unknown"}`)
          }
          if (stats?.ok) {
            const s = (await stats.json()) as {
              database?: { observations?: number; sessions?: number }
            }
            lines.push(
              `Observations: ${s.database?.observations ?? "?"}`,
            )
            lines.push(`Sessions: ${s.database?.sessions ?? "?"}`)
          }

          lines.push(`Project: ${project}`)
          lines.push(
            `Active session: ${claudeSessionId || "none"}`,
          )
          return lines.join("\n")
        },
      }),

      // P2.4: Folder context tool
      claude_mem_folder_context: tool({
        description:
          "Get recent observations for a specific folder in the project. " +
          "Useful for understanding recent activity in a directory before making changes.",
        args: {
          folder: tool.schema
            .string()
            .describe("Folder path relative to project root (e.g. 'src/auth')"),
        },
        async execute(args) {
          if (!workerHealthy) {
            return "\u26a0\ufe0f claude-mem worker is currently unreachable."
          }

          return await fetchFolderContext(args.folder, project) || "No recent observations for this folder."
        },
      }),
    },

    // == Event hooks ===========================================================
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created":
          // P0.3: Flush buffer from previous session
          flushBuffer().catch(() => {})
          claudeSessionId = `opencode-${project}-${Date.now()}`
          contextInjected = false
          sessionInitialized = false
          summarySent = false
          recentToolFiles.clear()
          recentHashes.clear()
          observationBuffer.length = 0
          invalidateContextCache()
          break

        case "session.idle":
          await sendSummary()
          break

        case "session.deleted":
          await completeSession()
          break

        // Track assistant messages for better summaries
        case "message.updated": {
          const msg = (event as any).properties?.info
          if (msg?.role === "assistant") {
            const text = msg.parts
              ?.filter((p: any) => p.type === "text")
              .map((p: any) => p.text)
              .join("\n") || ""
            if (text) lastAssistantMessage = text.slice(0, 5000)
          }
          break
        }

        // Track file edits as observations (skip if already captured by tool.execute.after)
        case "file.edited": {
          const file = (event as any).properties?.file
          if (file && recentToolFiles.has(file)) {
            recentToolFiles.delete(file)
            break
          }
          recordObservation("file.edited", (event as any).properties, null).catch(() => {})

          // P2.4: Fetch folder-level context for edited file
          if (file && typeof file === "string") {
            const folder = file.split("/").slice(0, -1).join("/") || "."
            fetchFolderContext(folder, project).catch(() => {})
          }
          break
        }

        // Track session errors as observations
        case "session.error": {
          recordObservation("session.error", (event as any).properties, null).catch(() => {})
          break
        }
      }
    },

    // == Stage 2: Capture user messages ========================================
    "chat.message": async (_input, output) => {
      const textParts = output.parts
        .filter((p): p is typeof p & { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
      const joined = textParts.join("\n")

      // Skip fully private prompts (entire message wrapped in <private> tags)
      if (stripPrivateTags(joined).trim().length === 0) {
        promptPrivate = true
        return
      }

      promptPrivate = false
      if (textParts.length > 0) {
        lastUserMessage = joined
        initSession(lastUserMessage).catch(() => {})
      }
    },

    // == Stage 3: Capture tool usage (PostToolUse) =============================
    "tool.execute.after": async (input, output) => {
      if (input.tool.startsWith("claude_mem_") || SKIP_TOOLS.has(input.tool)) return
      if (promptPrivate) return

      // Track file paths from tool args to dedup against file.edited events
      const filePath = input.args?.file_path || input.args?.path || input.args?.file
      if (typeof filePath === "string") recentToolFiles.add(filePath)

      if (output.output) {
        lastAssistantMessage = output.output.slice(0, 5000)
      }

      recordObservation(input.tool, input.args, output.output).catch(() => {})
    },

    // == Stage 1a: Inject context on first message =============================
    "experimental.chat.system.transform": async (_input, output) => {
      if (contextInjected) return
      contextInjected = true
      const context = await injectContext()
      if (context) {
        output.system.push(
          `## Claude-Mem: Previous Session Context\n\n${context}`,
        )
      }
    },

    // == Stage 1b: Re-inject context during compaction =========================
    "experimental.session.compacting": async (_input, output) => {
      const context = await injectContext()
      if (context) {
        output.context.push(
          `## Claude-Mem: Previous Session Context\n\n${context}`,
        )
      }
    },
  }
}

export default ClaudeMemPlugin
