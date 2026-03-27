// ---------------------------------------------------------------------------
// opencode-cmem — Pure utility functions
// ---------------------------------------------------------------------------

// -- Privacy & recursion prevention ------------------------------------------

/**
 * Strip privacy and recursion-prevention tags before sending to worker.
 * - `<private>...</private>` — user-level privacy control
 * - `<claude-mem-context>...</claude-mem-context>` — system-level recursion prevention
 */
export function stripPrivateTags(text: string): string {
  return text
    .replace(/<private>[\s\S]*?<\/private>/g, "")
    .replace(/<claude-mem-context>[\s\S]*?<\/claude-mem-context>/g, "")
}

// -- Content hashing for deduplication --------------------------------------

/**
 * Deterministic content hash for deduplication.
 * Uses first 500 chars of input/response to avoid hashing huge payloads.
 */
export function contentHash(
  toolName: string,
  input: string,
  response: string,
): string {
  let hash = 0
  const str = `${toolName}:${input.slice(0, 500)}:${response.slice(0, 500)}`
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return String(hash)
}

// -- Search result enrichment ------------------------------------------------

interface SearchResultItem {
  read_cost?: number
  token_count?: number
  estimated_tokens?: number
  [key: string]: unknown
}

interface SearchResultWrapper {
  results?: SearchResultItem[]
  data?: SearchResultItem[]
  observations?: SearchResultItem[]
  [key: string]: unknown
}

/**
 * Parse worker search response and surface token cost information.
 * The worker returns results that may include `read_cost` or `token_count`
 * fields. We enrich the response so the LLM can make informed decisions
 * about how many full observations to fetch.
 */
export function enrichSearchResults(rawText: string): string {
  try {
    const parsed = JSON.parse(rawText) as SearchResultItem[] | SearchResultWrapper

    // Handle both array and object wrappers
    const results: SearchResultItem[] = Array.isArray(parsed)
      ? parsed
      : parsed.results ?? parsed.data ?? parsed.observations ?? [parsed]

    if (!Array.isArray(results)) return rawText

    const enriched = results.map((item) => {
      const cost = item.read_cost ?? item.token_count ?? item.estimated_tokens
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

// -- Structured summary parsing ----------------------------------------------

/** Stored structured session summary from the worker. */
export interface StructuredSummary {
  request?: string
  investigated?: string[]
  learned?: string[]
  completed?: string[]
  next_steps?: string[]
  raw?: string
  timestamp: number
}

/**
 * Parse the worker's summarize response into a structured summary.
 * The worker may return JSON with sections like Request, Investigated,
 * Learned, Completed, Next Steps — or a plain text summary.
 */
export function parseSummaryResponse(raw: string): StructuredSummary {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      request: (parsed.request ?? parsed.summary_request) as string | undefined,
      investigated: (parsed.investigated ?? parsed.files_investigated) as string[] | undefined,
      learned: (parsed.learned ?? parsed.key_learnings ?? parsed.insights) as string[] | undefined,
      completed: (parsed.completed ?? parsed.tasks_completed) as string[] | undefined,
      next_steps: (parsed.next_steps ?? parsed.suggested_next) as string[] | undefined,
      raw,
      timestamp: Date.now(),
    }
  } catch {
    return { raw, timestamp: Date.now() }
  }
}

// -- Session ID generation ---------------------------------------------------

/**
 * Generate a unique session ID prefixed with "opencode" and the project name.
 */
export function generateSessionId(project: string): string {
  return `opencode-${project}-${Date.now()}`
}
