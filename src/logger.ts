// ---------------------------------------------------------------------------
// opencode-cmem — Structured logging
// ---------------------------------------------------------------------------

type LogLevel = "error" | "warn" | "info" | "debug"

const LOG_LEVELS: Record<LogLevel, number> = {
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
}

const LOG_PREFIX = "[claude-mem]"

let currentLogLevel: number

function resolveLogLevel(): number {
  const envLevel = process.env.CLAUDE_MEM_LOG_LEVEL?.toLowerCase()
  if (envLevel && envLevel in LOG_LEVELS) {
    return LOG_LEVELS[envLevel as LogLevel]
  }
  return LOG_LEVELS.info
}

/** @internal Reset log level from environment (for testing) */
export function _resetLogLevel(): void {
  currentLogLevel = resolveLogLevel()
}

// Initialize on first load
currentLogLevel = resolveLogLevel()

// Use an indirection layer so that spyOn(console, ...) works in tests.
// Bun inlines direct console.* calls, preventing spyOn from intercepting them.
const con = console as unknown as Record<string, (...args: unknown[]) => void>

export const log = {
  debug: (...args: unknown[]) =>
    currentLogLevel >= 4 && con["debug"](LOG_PREFIX, ...args),
  info: (...args: unknown[]) =>
    currentLogLevel >= 3 && con["info"](LOG_PREFIX, ...args),
  warn: (...args: unknown[]) =>
    currentLogLevel >= 2 && con["warn"](LOG_PREFIX, ...args),
  error: (...args: unknown[]) =>
    currentLogLevel >= 1 && con["error"](LOG_PREFIX, ...args),
} as const

export type { LogLevel }
