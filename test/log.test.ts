import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addSecret,
  clearSecrets,
  createLogger,
  parseLevel,
  redact,
  silentLogger,
} from "../src/log.js";

afterEach(() => clearSecrets());

describe("logger", () => {
  it("writes JSON lines at or above the level and redacts secrets", () => {
    const lines: string[] = [];
    addSecret("tok-123456");
    addSecret("ab");
    addSecret(undefined);
    const log = createLogger("info", (l) => lines.push(l));
    log.debug("hidden");
    log.info("hello", { key: "tok-123456" });
    log.warn("w");
    log.error("e ab");
    expect(lines.length).toBe(3);
    const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(first).toMatchObject({ level: "info", msg: "hello", key: "[redacted]" });
    expect(lines[2]).toContain("e ab");
    expect(redact("tok-123456tok-123456")).toBe("[redacted][redacted]");
  });

  it("parses levels", () => {
    expect(parseLevel("DEBUG")).toBe("debug");
    expect(parseLevel("warn")).toBe("warn");
    expect(parseLevel("error")).toBe("error");
    expect(parseLevel(undefined)).toBe("info");
    expect(parseLevel("loud")).toBe("info");
  });

  it("defaults to stderr", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    createLogger().info("to stderr");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("silent logger does nothing", () => {
    silentLogger.debug("a");
    silentLogger.info("a");
    silentLogger.warn("a");
    silentLogger.error("a");
  });
});
