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

function resolveLogLevel(): number {
  const envLevel = process.env.CLAUDE_MEM_LOG_LEVEL?.toLowerCase()
  if (envLevel && envLevel in LOG_LEVELS) {
    return LOG_LEVELS[envLevel as LogLevel]
  }
  return LOG_LEVELS.info
}

const currentLogLevel = resolveLogLevel()

export const log = {
  debug: (...args: unknown[]) =>
    currentLogLevel >= 4 && console.debug(LOG_PREFIX, ...args),
  info: (...args: unknown[]) =>
    currentLogLevel >= 3 && console.info(LOG_PREFIX, ...args),
  warn: (...args: unknown[]) =>
    currentLogLevel >= 2 && console.warn(LOG_PREFIX, ...args),
  error: (...args: unknown[]) =>
    currentLogLevel >= 1 && console.error(LOG_PREFIX, ...args),
} as const

export type { LogLevel }
