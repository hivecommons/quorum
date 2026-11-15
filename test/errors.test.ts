import { describe, expect, it } from "vitest";
import { ERROR_CODES, QuorumError, failure, success, toFailure } from "../src/errors.js";

describe("errors", () => {
  it("lists the contract codes", () => {
    expect(ERROR_CODES).toEqual([
      "invalid_argument",
      "not_found",
      "platform_unavailable",
      "blocked",
      "lobby_timeout",
      "not_live",
      "rate_limited",
      "upstream_error",
    ]);
  });

  it("builds result shapes", () => {
    expect(success({ a: 1 })).toEqual({ ok: true, a: 1 });
    expect(failure("blocked", "no")).toEqual({
      ok: false,
      error: { code: "blocked", message: "no" },
    });
    expect(toFailure(new QuorumError("not_live", "x"))).toEqual(failure("not_live", "x"));
    expect(toFailure(new Error("boom"))).toEqual(failure("upstream_error", "boom"));
    expect(toFailure("str")).toEqual(failure("upstream_error", "str"));
  });
});
