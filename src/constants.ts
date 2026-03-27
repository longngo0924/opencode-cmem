// ---------------------------------------------------------------------------
// opencode-cmem — Configuration constants
// ---------------------------------------------------------------------------

/** Default port for the claude-mem worker API. */
export const DEFAULT_PORT = 37777

/** Maximum retry attempts for worker requests. */
export const RETRY_MAX = 3

/** Base delay (ms) for exponential backoff: 1s × 2^attempt. */
export const RETRY_BASE_DELAY_MS = 1_000

/** Hard cap (ms) on backoff delay to prevent excessive waits. */
export const RETRY_MAX_DELAY_MS = 8_000

/** Interval (ms) between periodic worker health checks. */
export const HEALTH_CHECK_INTERVAL_MS = 30_000

/** Interval (ms) between automatic observation buffer flushes. */
export const BATCH_FLUSH_INTERVAL_MS = 5_000

/** Number of observations to buffer before triggering an immediate flush. */
export const BATCH_MAX_SIZE = 10

/** Time window (ms) during which duplicate observations are suppressed. */
export const DEDUP_WINDOW_MS = 60_000

/** TTL (ms) for the injected context cache. */
export const CONTEXT_CACHE_TTL_MS = 60_000

/** TTL (ms) for the folder-level context cache. */
export const FOLDER_CONTEXT_TTL_MS = 120_000

/** Maximum number of folders to keep in the folder context cache. */
export const FOLDER_CACHE_MAX_ENTRIES = 10

/** Maximum concurrent observation flush requests. */
export const FLUSH_CONCURRENCY = 5

/** Maximum characters for prompt content sent to the worker. */
export const MAX_PROMPT_LENGTH = 5_000

/** Maximum characters for tool input/response sent to the worker. */
export const MAX_OBSERVATION_LENGTH = 10_000

/** Maximum characters for assistant/user messages stored for summary. */
export const MAX_MESSAGE_LENGTH = 5_000

/** Tools whose usage produces low-value observations and should be skipped. */
export const SKIP_TOOLS = new Set([
  "TodoWrite",
  "AskUserQuestion",
  "ListMcpResourcesTool",
  "SlashCommand",
  "Skill",
])
