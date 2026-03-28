// ---------------------------------------------------------------------------
// opencode-cmem — Configuration validation
// ---------------------------------------------------------------------------

import { DEFAULT_PORT } from "./constants"
import { log } from "./logger"

export interface WorkerConfig {
  url: string
  port: number
  errors: string[]
}

let validatedConfig: WorkerConfig | null = null

/**
 * Validate environment-based configuration and return a cached result.
 * Reads `CLAUDE_MEM_WORKER_PORT` and `CLAUDE_MEM_WORKER_URL` from env.
 */
export function validateConfig(): WorkerConfig {
  if (validatedConfig) return validatedConfig

  const errors: string[] = []
  let port = DEFAULT_PORT
  let baseUrl = ""

  // Validate CLAUDE_MEM_WORKER_PORT
  const portRaw = process.env.CLAUDE_MEM_WORKER_PORT
  if (portRaw) {
    const parsed = Number(portRaw)
    if (!Number.isInteger(parsed) || isNaN(parsed)) {
      errors.push(`CLAUDE_MEM_WORKER_PORT="${portRaw}" is not a valid integer`)
    } else if (parsed < 1024 || parsed > 65535) {
      errors.push(`CLAUDE_MEM_WORKER_PORT=${parsed} is out of range (1024-65535)`)
    } else {
      port = parsed
    }
  }

  // Validate CLAUDE_MEM_WORKER_URL
  const urlRaw = process.env.CLAUDE_MEM_WORKER_URL
  if (urlRaw) {
    try {
      const url = new URL(urlRaw)
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        errors.push(
          `CLAUDE_MEM_WORKER_URL must use http:// or https://, got "${url.protocol}"`,
        )
      } else {
        baseUrl = urlRaw.replace(/\/+$/, "")
      }
    } catch {
      errors.push(`CLAUDE_MEM_WORKER_URL="${urlRaw}" is not a valid URL`)
    }
  }

  const url = baseUrl || `http://127.0.0.1:${port}`
  validatedConfig = { url, port, errors }
  return validatedConfig
}

/** Reset cached config (useful for testing). */
export function resetConfig(): void {
  validatedConfig = null
}

/** Get the validated worker base URL. */
export function getWorkerUrl(): string {
  return validateConfig().url
}

/**
 * Log configuration warnings/errors on startup.
 * Returns the validated config for convenience.
 */
export function logConfigStatus(): WorkerConfig {
  const config = validateConfig()
  if (config.errors.length > 0) {
    for (const err of config.errors) log.error(err)
    log.warn(`Using default worker URL: ${config.url}`)
  } else {
    log.debug(`Worker URL: ${config.url}`)
  }
  return config
}
