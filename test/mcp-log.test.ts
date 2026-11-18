import { describe, expect, it } from "vitest";
import { failure } from "../src/errors.js";
import { createLogger } from "../src/log.js";
import { logToolCall } from "../src/mcp.js";

function capture(): { lines: Record<string, unknown>[]; log: ReturnType<typeof createLogger> } {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger("debug", (l) => lines.push(JSON.parse(l) as Record<string, unknown>));
  return { lines, log };
}

describe("logToolCall", () => {
  it("logs tool, outcome and duration at info on success", () => {
    const { lines, log } = capture();
    logToolCall(log, "say", { ok: true } as never, 12.4);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "info", tool: "say", ok: true, duration_ms: 12 });
    expect(lines[0]).not.toHaveProperty("error_code");
  });

  it("logs the error code at warn on failure, never the message", () => {
    const { lines, log } = capture();
    logToolCall(log, "say", failure("upstream_error", "secret detail"), 3);
    expect(lines[0]).toMatchObject({ level: "warn", ok: false, error_code: "upstream_error" });
    expect(JSON.stringify(lines[0])).not.toContain("secret detail");
  });

  it("collapses client-supplied unknown tool names to keep values bounded", () => {
    const { lines, log } = capture();
    logToolCall(log, "x".repeat(500), failure("invalid_argument", "unknown tool"), 1);
    expect(lines[0]).toMatchObject({ tool: "unknown" });
  });
});
