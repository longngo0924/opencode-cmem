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

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

import {
  BATCH_FLUSH_INTERVAL_MS,
  BATCH_MAX_SIZE,
  CONTEXT_CACHE_TTL_MS,
  DEDUP_WINDOW_MS,
  FOLDER_CACHE_MAX_ENTRIES,
  FOLDER_CONTEXT_TTL_MS,
  FLUSH_CONCURRENCY,
  HEALTH_CHECK_INTERVAL_MS,
  MAX_MESSAGE_LENGTH,
  MAX_OBSERVATION_LENGTH,
  MAX_PROMPT_LENGTH,
  SKIP_TOOLS,
} from "./constants"
import { log } from "./logger"
import { logConfigStatus, getWorkerUrl } from "./config"
import {
  workerFetch,
  isWorkerHealthy,
  startHealthMonitor,
  initialHealthCheck,
  tryAutoStartWorker,
  getPendingCriticalRequests,
} from "./worker"
import {
  stripPrivateTags,
  contentHash,
  enrichSearchResults,
  parseSummaryResponse,
  generateSessionId,
  generatePartId,
} from "./utils"
import type { StructuredSummary } from "./utils"

// -- Folder context cache (module-level, shared across plugin instances) -----

interface FolderContext {
  folder: string
  observations: string[]
  timestamp: number
}

const folderContextCache = new Map<string, FolderContext>()

// -- Cross-session summary (module-level) -----------------------------------

let lastSummary: StructuredSummary | null = null
let previousSessionMessage: string | null = null

// -- Folder context helper ---------------------------------------------------

async function fetchFolderContext(
  folder: string,
  projectName?: string,
): Promise<string> {
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
        pruneFolderCache()
        return text
      }
    }
  } catch (err) {
    log.debug(
      `Failed to fetch folder context for ${folder}: ${err instanceof Error ? err.message : err}`,
    )
  }

  return ""
}

function pruneFolderCache(): void {
  if (folderContextCache.size <= FOLDER_CACHE_MAX_ENTRIES) return
  const sorted = [...folderContextCache.entries()].sort(
    (a, b) => a[1].timestamp - b[1].timestamp,
  )
  const toRemove = sorted.length - FOLDER_CACHE_MAX_ENTRIES
  for (let i = 0; i < toRemove; i++) {
    folderContextCache.delete(sorted[i][0])
  }
}

// -- Plugin ------------------------------------------------------------------

export const ClaudeMemPlugin: Plugin = async (ctx) => {
  const project =
    ctx.worktree?.split("/").pop() ||
    ctx.directory?.split("/").pop() ||
    "default"

  // -- Session state --------------------------------------------------------
  let claudeSessionId: string | null = null
  let lastUserMessage = ""
  let lastAssistantMessage = ""
  let contextInjected = false
  let sessionInitialized = false
  let promptPrivate = false
  let summarySent = false
  const recentToolFiles = new Set<string>()

  // -- Observation batching -------------------------------------------------
  interface BufferedObservation {
    contentSessionId: string
    tool_name: string
    tool_input: string
    tool_response: string
    cwd: string
  }

  const observationBuffer: BufferedObservation[] = []
  let batchTimer: ReturnType<typeof setInterval> | null = null

  // -- Dedup cache ----------------------------------------------------------
  const recentHashes = new Map<string, number>()

  // -- Context injection cache ----------------------------------------------
  let contextCache: { text: string; timestamp: number } | null = null

  // -- Startup --------------------------------------------------------------

  startHealthMonitor()
  logConfigStatus()

  const healthy = await initialHealthCheck()
  if (!healthy) {
    log.warn(
      `Worker not reachable at ${getWorkerUrl()}. Start it with: claude-mem worker start`,
    )
    const started = await tryAutoStartWorker()
    if (!started) {
      log.warn("Set CLAUDE_MEM_AUTO_START=true to enable automatic worker startup")
    }
  } else {
    log.debug("Worker health check passed")
  }

  // -- Observation buffer flush ---------------------------------------------

  async function flushBuffer(): Promise<void> {
    if (observationBuffer.length === 0) return
    const items = observationBuffer.splice(0)

    for (let i = 0; i < items.length; i += FLUSH_CONCURRENCY) {
      const batch = items.slice(i, i + FLUSH_CONCURRENCY)
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

  function startBatchTimer(): void {
    if (batchTimer) return
    batchTimer = setInterval(() => {
      flushBuffer().catch(() => {})
    }, BATCH_FLUSH_INTERVAL_MS)
    if (batchTimer.unref) batchTimer.unref()
  }

  startBatchTimer()

  // -- Dedup cache cleanup --------------------------------------------------

  function cleanDedupCache(): void {
    const now = Date.now()
    for (const [hash, ts] of recentHashes) {
      if (now - ts > DEDUP_WINDOW_MS) recentHashes.delete(hash)
    }
  }

  // -- Context injection ----------------------------------------------------

  function invalidateContextCache(): void {
    contextCache = null
  }

  async function injectContext(): Promise<string> {
    if (contextCache && Date.now() - contextCache.timestamp < CONTEXT_CACHE_TTL_MS) {
      log.debug("Context injection cache hit")
      return contextCache.text
    }

    const res = await workerFetch(
      `/api/context/inject?projects=${encodeURIComponent(project)}`,
      { timeout: 3000 },
    )
    if (!res) {
      log.debug("injectContext: worker unreachable")
      return ""
    }
    if (!res.ok) {
      log.debug(`injectContext: worker returned ${res.status}`)
      return ""
    }

    let workerContext = ""
    // Read body as text first to avoid "body already used" if JSON parse fails
    const bodyText = await res.text()
    try {
      const data = JSON.parse(bodyText) as { content?: Array<{ type: string; text: string }>; text?: string }
      if (data?.content?.[0]?.text) {
        workerContext = data.content[0].text
      } else if (typeof data?.text === "string") {
        workerContext = data.text
      } else if (typeof (data as any) === "string") {
        workerContext = data as unknown as string
      }
    } catch {
      // Response is plain text, use as-is
      workerContext = bodyText
    }

    if (!workerContext.trim()) return ""

    contextCache = { text: workerContext, timestamp: Date.now() }
    log.debug("Context injection cache miss — fetched and cached")

    // Build enriched context with progressive disclosure layers
    const sections: string[] = [workerContext]

    // Layer: Last session summary enrichment
    if (lastSummary) {
      const summaryParts: string[] = []
      if (lastSummary.request) {
        summaryParts.push(`**Request:** ${lastSummary.request}`)
      }
      if (lastSummary.learned?.length) {
        summaryParts.push(
          "### Key Learnings from Last Session\n" +
            lastSummary.learned.map((l) => `- ${l}`).join("\n"),
        )
      }
      if (lastSummary.completed?.length) {
        summaryParts.push(
          "### Completed\n" +
            lastSummary.completed.map((c) => `- ${c}`).join("\n"),
        )
      }
      if (lastSummary.next_steps?.length) {
        summaryParts.push(
          "### Suggested Next Steps\n" +
            lastSummary.next_steps.map((s) => `- ${s}`).join("\n"),
        )
      }
      if (summaryParts.length > 0) {
        sections.push(summaryParts.join("\n\n"))
      }
    }

    // Layer: "Previously" — last assistant message from prior session
    if (previousSessionMessage) {
      const truncated = previousSessionMessage.slice(0, 500)
      sections.push(
        `**Previously**\n\n${truncated}${previousSessionMessage.length > 500 ? "..." : ""}`
      )
    }

    return sections.join("\n\n")
  }

  // -- Session lifecycle ----------------------------------------------------

  async function initSession(prompt: string): Promise<void> {
    if (!claudeSessionId) {
      claudeSessionId = generateSessionId(project)
    }

    await workerFetch("/api/sessions/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentSessionId: claudeSessionId,
        project,
        prompt: stripPrivateTags(prompt).slice(0, MAX_PROMPT_LENGTH) || "[opencode session]",
      }),
      critical: true,
    })
    sessionInitialized = true
  }

  async function recordObservation(
    toolName: string,
    toolInput: unknown,
    toolResponse: unknown,
  ): Promise<void> {
    if (!claudeSessionId) {
      claudeSessionId = generateSessionId(project)
    }

    if (!sessionInitialized) {
      await initSession(lastUserMessage || "[opencode session]")
    }

    const inputStr =
      typeof toolInput === "string"
        ? toolInput
        : JSON.stringify(toolInput ?? {})
    const responseStr =
      typeof toolResponse === "string"
        ? toolResponse
        : JSON.stringify(toolResponse ?? {})

    // Content-hash dedup
    const hash = contentHash(toolName, inputStr, responseStr)
    const now = Date.now()
    if (recentHashes.has(hash) && now - (recentHashes.get(hash) ?? 0) < DEDUP_WINDOW_MS) {
      return
    }
    recentHashes.set(hash, now)
    cleanDedupCache()

    // Buffer observation
    const observation: BufferedObservation = {
      contentSessionId: claudeSessionId,
      tool_name: toolName,
      tool_input: stripPrivateTags(inputStr).slice(0, MAX_OBSERVATION_LENGTH),
      tool_response: stripPrivateTags(responseStr).slice(0, MAX_OBSERVATION_LENGTH),
      cwd: ctx.directory || process.cwd(),
    }
    observationBuffer.push(observation)

    if (observationBuffer.length >= BATCH_MAX_SIZE) {
      await flushBuffer()
    }
  }

  async function sendSummary(): Promise<void> {
    if (!claudeSessionId || summarySent) return

    await flushBuffer()
    summarySent = true

    const summaryRes = await workerFetch("/api/sessions/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentSessionId: claudeSessionId,
        last_user_message: lastUserMessage.slice(0, MAX_MESSAGE_LENGTH),
        last_assistant_message: lastAssistantMessage.slice(0, MAX_MESSAGE_LENGTH),
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

    await workerFetch("/api/processing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isProcessing: false }),
      critical: true,
    })
  }

  function resetSession(): void {
    claudeSessionId = null
    lastUserMessage = ""
    lastAssistantMessage = ""
    contextInjected = false
    sessionInitialized = false
    summarySent = false
    promptPrivate = false
    recentToolFiles.clear()
    observationBuffer.length = 0
    recentHashes.clear()
    folderContextCache.clear()
    invalidateContextCache()
  }

  // -- Plugin return --------------------------------------------------------

  return {
    // == Custom tools (LLM-callable) ========================================
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
          limit: tool.schema.number().optional().describe("Max results (default: 20)"),
          obs_type: tool.schema
            .enum(["discovery", "decision", "bugfix", "feature", "refactor", "change"])
            .optional()
            .describe("Filter by observation type"),
          concepts: tool.schema.string().optional().describe("Filter by concepts (comma-separated)"),
          files: tool.schema.string().optional().describe("Filter by file paths (comma-separated)"),
          dateStart: tool.schema.string().optional().describe("ISO timestamp filter start"),
          dateEnd: tool.schema.string().optional().describe("ISO timestamp filter end"),
          orderBy: tool.schema
            .enum(["date_desc", "date_asc", "relevance"])
            .optional()
            .describe("Sort order (default: relevance)"),
          offset: tool.schema.number().optional().describe("Pagination offset"),
        },
        async execute(args) {
          if (!isWorkerHealthy()) {
            return "⚠️ claude-mem worker is currently unreachable. The search will be attempted but may fail."
          }

          const params = new URLSearchParams({ query: args.query, format: "index" })
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
          return enrichSearchResults(await res.text())
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
          if (!isWorkerHealthy()) {
            return "⚠️ claude-mem worker is currently unreachable."
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
          limit: tool.schema.number().optional().describe("Number of recent sessions (default: 3)"),
          anchor: tool.schema.number().optional().describe("Observation ID to center timeline around"),
          depth_before: tool.schema.number().optional().describe("Records before anchor (default: 3)"),
          depth_after: tool.schema.number().optional().describe("Records after anchor (default: 3)"),
        },
        async execute(args) {
          if (!isWorkerHealthy()) {
            return "⚠️ claude-mem worker is currently unreachable."
          }

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
          content: tool.schema.string().describe("The memory content to save"),
        },
        async execute(args) {
          if (!isWorkerHealthy()) {
            return "⚠️ claude-mem worker is currently unreachable. Memory not saved."
          }

          const res = await workerFetch("/api/memory/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: args.content, project, source: "opencode" }),
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
          lines.push(`Queued critical requests: ${getPendingCriticalRequests()}`)
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
            lines.push(`Observations: ${s.database?.observations ?? "?"}`)
            lines.push(`Sessions: ${s.database?.sessions ?? "?"}`)
          }

          lines.push(`Project: ${project}`)
          lines.push(`Active session: ${claudeSessionId || "none"}`)
          return lines.join("\n")
        },
      }),

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
          if (!isWorkerHealthy()) {
            return "⚠️ claude-mem worker is currently unreachable."
          }
          return (
            (await fetchFolderContext(args.folder, project)) ||
            "No recent observations for this folder."
          )
        },
      }),
    },

    // == Event hooks =========================================================
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created":
          flushBuffer().catch(() => {})
          resetSession()
          break

        case "session.idle":
          await sendSummary()
          break

        case "session.deleted":
          await sendSummary()
          if (claudeSessionId) {
            await workerFetch("/api/sessions/complete", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ contentSessionId: claudeSessionId }),
              critical: true,
            })
          }
          // Preserve last message for "Previously" section in next session
          if (lastAssistantMessage) {
            previousSessionMessage = lastAssistantMessage
          }
          resetSession()
          break

        case "message.updated": {
          const msg = (event as { properties?: { info?: { role?: string; parts?: Array<{ type: string; text?: string }> } } }).properties?.info
          if (msg?.role === "assistant") {
            const text =
              msg.parts
                ?.filter((p) => p.type === "text")
                .map((p) => p.text ?? "")
                .join("\n") ?? ""
            if (text) lastAssistantMessage = text.slice(0, MAX_MESSAGE_LENGTH)
          }
          break
        }

        case "file.edited": {
          const file = (event as { properties?: { file?: string } }).properties?.file
          if (file && recentToolFiles.has(file)) {
            recentToolFiles.delete(file)
            break
          }
          recordObservation("file.edited", (event as Record<string, unknown>).properties, null).catch(
            () => {},
          )

          if (file && typeof file === "string") {
            const folder = file.split("/").slice(0, -1).join("/") || "."
            fetchFolderContext(folder, project).catch(() => {})
          }
          break
        }

        case "session.error": {
          recordObservation("session.error", (event as Record<string, unknown>).properties, null).catch(
            () => {},
          )
          break
        }
      }
    },

    // == Chat message hook (capture user prompts) ===========================
    // OpenCode's chat.message hook fires for each user message. Subagent
    // delegation (task tool) does NOT trigger this hook — it uses SubtaskPart
    // internally — so no agent filtering is needed here.
    "chat.message": async (input, output) => {
      // Capture user's original text BEFORE injecting context, so we don't
      // pollute the session prompt with injected claude-mem context.
      const userTextParts = output.parts
        .filter((p): p is typeof p & { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
      const userText = userTextParts.join("\n")

      if (!contextInjected) {
        contextInjected = true
        const context = await injectContext()
        if (context) {
          const header =
            `## Claude-Mem: Recent Session Context\n\n` +
            `⚠️ **MANDATORY: claude-mem Context Check** — BEFORE starting work, use \`claude_mem_search\` to query past observations, \`claude_mem_timeline\` for chronological context, and \`claude_mem_get_observations\` to fetch full details by ID. This ensures you have complete project history.\n\n`
          output.parts.push({
            type: "text",
            id: generatePartId(),
            sessionID: input.sessionID ?? "",
            messageID: input.messageID ?? "",
            text: header + context,
            synthetic: true,
          })
          log.debug(`Context injected into first message (${context.length} chars)`)
        } else {
          log.debug("No context available for injection (worker returned empty or unreachable)")
        }
      }

      // Store the user's original prompt (not the injected context)
      if (stripPrivateTags(userText).trim().length === 0) {
        promptPrivate = true
        return
      }

      promptPrivate = false
      if (userTextParts.length > 0) {
        lastUserMessage = userText
        initSession(lastUserMessage).catch(() => {})
      }
    },

    // == Tool execution hook (capture tool usage) ===========================
    "tool.execute.after": async (input, output) => {
      if (input.tool.startsWith("claude_mem_") || SKIP_TOOLS.has(input.tool)) return
      if (promptPrivate) return

      const filePath = input.args?.file_path || input.args?.path || input.args?.file
      if (typeof filePath === "string") recentToolFiles.add(filePath)

      if (output.output) {
        lastAssistantMessage = output.output.slice(0, MAX_MESSAGE_LENGTH)
      }

      recordObservation(input.tool, input.args, output.output).catch(() => {})
    },

    // == System prompt injection (first message) ============================
    "experimental.chat.system.transform": async (_input, output) => {
      log.debug("system.transform hook fired")
      if (contextInjected) {
        log.debug("Context already injected, skipping")
        return
      }
      contextInjected = true
      const context = await injectContext()
      if (context) {
        const header =
          `## Claude-Mem: Recent Session Context\n\n` +
          `⚠️ **MANDATORY: claude-mem Context Check** — BEFORE starting work, use \`claude_mem_search\` to query past observations, \`claude_mem_timeline\` for chronological context, and \`claude_mem_get_observations\` to fetch full details by ID. This ensures you have complete project history.\n\n`
        output.system.push(header + context)
        log.debug(`Context injected into system prompt (${context.length} chars)`)
      } else {
        log.debug("No context available for injection (worker returned empty or unreachable)")
      }
    },

    // == Context re-injection during compaction =============================
    "experimental.session.compacting": async (_input, output) => {
      log.debug("session.compacting hook fired — re-injecting context")
      const context = await injectContext()
      if (context) {
        output.context.push(`## Claude-Mem: Previous Session Context\n\n${context}`)
        log.debug(`Context re-injected during compaction (${context.length} chars)`)
      }
    },
  }
}

export default ClaudeMemPlugin
