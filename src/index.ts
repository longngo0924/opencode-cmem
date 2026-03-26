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

function getWorkerUrl(): string {
  const port = process.env.CLAUDE_MEM_WORKER_PORT || DEFAULT_PORT
  return `http://127.0.0.1:${port}`
}

/**
 * Fire-and-forget fetch — never blocks the agent.
 * Returns null on failure instead of throwing.
 */
async function workerFetch(
  path: string,
  init?: RequestInit & { timeout?: number },
): Promise<Response | null> {
  const { timeout = 5000, ...fetchInit } = init || {}
  try {
    return await fetch(`${getWorkerUrl()}${path}`, {
      ...fetchInit,
      signal: AbortSignal.timeout(timeout),
    })
  } catch {
    return null
  }
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

  // -- Health check on startup (non-blocking) ---------------------------------
  const healthRes = await workerFetch("/api/health", { timeout: 2000 })
  if (!healthRes || !healthRes.ok) {
    console.warn(
      `[claude-mem] Worker not reachable at ${getWorkerUrl()}. ` +
        `Start it with: claude-mem worker start`,
    )
  }

  // -- Stage 1: SessionStart — inject prior context ---------------------------
  async function injectContext(): Promise<string> {
    const res = await workerFetch(
      `/api/context/inject?projects=${encodeURIComponent(project)}`,
      { timeout: 3000 },
    )
    if (res && res.ok) {
      const text = await res.text()
      if (text && text.trim().length > 0) return text
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
    })
    sessionInitialized = true
  }

  // -- Stage 3: Record observation --------------------------------------------
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

    await workerFetch("/api/sessions/observations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentSessionId: claudeSessionId,
        tool_name: toolName,
        tool_input: stripPrivateTags(inputStr).slice(0, 10000),
        tool_response: stripPrivateTags(responseStr).slice(0, 10000),
        cwd: ctx.directory || process.cwd(),
      }),
    })
  }

  // -- Stage 4: Stop — generate summary ---------------------------------------
  async function sendSummary(): Promise<void> {
    if (!claudeSessionId || summarySent) return
    summarySent = true

    await workerFetch("/api/sessions/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentSessionId: claudeSessionId,
        last_user_message: lastUserMessage.slice(0, 5000),
        last_assistant_message: lastAssistantMessage.slice(0, 5000),
      }),
    })

    // Signal processing complete (updates web viewer UI)
    await workerFetch("/api/processing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isProcessing: false }),
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
    })

    claudeSessionId = null
    lastUserMessage = ""
    lastAssistantMessage = ""
    contextInjected = false
    sessionInitialized = false
    summarySent = false
    recentToolFiles.clear()
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
          return await res.text()
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
          const res = await workerFetch("/api/memory/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: args.content,
              project,
              source: "opencode",
            }),
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
    },

    // == Event hooks ===========================================================
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created":
          claudeSessionId = `opencode-${project}-${Date.now()}`
          contextInjected = false
          sessionInitialized = false
          summarySent = false
          recentToolFiles.clear()
          break

        case "session.idle":
          await sendSummary()
          break

        case "session.deleted":
          await completeSession()
          break

        // P0: Track assistant messages for better summaries
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

        // P1: Track file edits as observations (skip if already captured by tool.execute.after)
        case "file.edited": {
          const file = (event as any).properties?.file
          if (file && recentToolFiles.has(file)) {
            recentToolFiles.delete(file)
            break
          }
          recordObservation("file.edited", (event as any).properties, null).catch(() => {})
          break
        }

        // P2: Track session errors as observations
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
