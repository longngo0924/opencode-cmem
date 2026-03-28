import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test"

// ---------------------------------------------------------------------------
// Unit tests for src/logger.ts
//
// Covers: resolveLogLevel, log.debug, log.info, log.warn, log.error
// Uncovered lines from report: 14-33
//
// NOTE: Bun hoists import declarations, so process.env set before import
// is NOT guaranteed to be available at module-load time. We use
// _resetLogLevel() to re-evaluate the log level after setting the env var.
// ---------------------------------------------------------------------------

import { log, _resetLogLevel } from "../src/logger"

describe("logger", () => {
  let debugSpy: ReturnType<typeof spyOn>
  let infoSpy: ReturnType<typeof spyOn>
  let warnSpy: ReturnType<typeof spyOn>
  let errorSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    process.env.CLAUDE_MEM_LOG_LEVEL = "debug"
    _resetLogLevel()

    debugSpy = spyOn(console, "debug").mockImplementation(() => {})
    infoSpy = spyOn(console, "info").mockImplementation(() => {})
    warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    errorSpy = spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    debugSpy.mockRestore()
    infoSpy.mockRestore()
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it("should call console.debug with LOG_PREFIX (lines 27-28)", () => {
    log.debug("test debug message")
    expect(debugSpy).toHaveBeenCalled()
    expect(debugSpy.mock.calls[0][0]).toBe("[claude-mem]")
    expect(debugSpy.mock.calls[0][1]).toBe("test debug message")
  })

  it("should call console.info with LOG_PREFIX (lines 29-30)", () => {
    log.info("test info message")
    expect(infoSpy).toHaveBeenCalled()
    expect(infoSpy.mock.calls[0][0]).toBe("[claude-mem]")
    expect(infoSpy.mock.calls[0][1]).toBe("test info message")
  })

  it("should call console.warn with LOG_PREFIX (lines 31-32)", () => {
    log.warn("test warn message")
    expect(warnSpy).toHaveBeenCalled()
    expect(warnSpy.mock.calls[0][0]).toBe("[claude-mem]")
    expect(warnSpy.mock.calls[0][1]).toBe("test warn message")
  })

  it("should call console.error with LOG_PREFIX (lines 33-34)", () => {
    log.error("test error message")
    expect(errorSpy).toHaveBeenCalled()
    expect(errorSpy.mock.calls[0][0]).toBe("[claude-mem]")
    expect(errorSpy.mock.calls[0][1]).toBe("test error message")
  })

  it("should pass multiple arguments to console methods", () => {
    log.info("msg1", "msg2", { key: "val" })
    expect(infoSpy).toHaveBeenCalledWith("[claude-mem]", "msg1", "msg2", { key: "val" })
  })

  it("should handle no arguments", () => {
    log.info()
    expect(infoSpy).toHaveBeenCalledWith("[claude-mem]")
  })
})
