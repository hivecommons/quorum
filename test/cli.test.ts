import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { silentLogger } from "../src/log.js";
import type { RunningQuorum } from "../src/app.js";
import { VERSION } from "../src/version.js";
import { TOKEN, tempDir, writeSecret } from "./helpers/harness.js";

function io(env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
      env,
      logger: silentLogger,
    },
  };
}

describe("cli", () => {
  it("prints the version and help", async () => {
    for (const v of ["version", "--version", "-v"]) {
      const t = io();
      expect(await main([v], t.io)).toBe(0);
      expect(t.out.join("")).toBe(`${VERSION}\n`);
    }
    for (const v of [[], ["help"], ["--help"], ["-h"]]) {
      const t = io();
      expect(await main(v, t.io)).toBe(0);
      expect(t.out.join("")).toContain("quorum serve");
    }
  });

  it("rejects unknown commands and bad config", async () => {
    let t = io();
    expect(await main(["dance"], t.io)).toBe(2);
    expect(t.err.join("")).toContain("unknown command");
    t = io({ QUORUM_LISTEN: "bad" });
    expect(await main(["serve"], t.io)).toBe(2);
    t = io({ QUORUM_LISTEN: "127.0.0.1:0" });
    expect(await main(["serve"], t.io)).toBe(1);
    expect(t.err.join("")).toContain("QUORUM_TOKEN_FILE");
  });

  it("serves until closed", async () => {
    const t = io({
      QUORUM_LISTEN: "127.0.0.1:0",
      QUORUM_TOKEN_FILE: writeSecret(tempDir(), "t", TOKEN),
      QUORUM_VEXA_URL: "http://127.0.0.1:9",
      QUORUM_VEXA_API_KEY_FILE: "/nonexistent",
    });
    const running = (await main(["serve"], t.io)) as RunningQuorum;
    const res = await fetch(running.url + "/healthz");
    expect(res.status).toBe(200);
    await running.close();
  });

  it("warns when listening beyond loopback and builds its own logger", async () => {
    const t = io({
      QUORUM_LISTEN: "0.0.0.0:0",
      QUORUM_TOKEN_FILE: writeSecret(tempDir(), "t", TOKEN),
      QUORUM_LOG_LEVEL: "error",
    });
    const running = (await main(["serve"], { ...t.io, logger: undefined })) as RunningQuorum;
    await running.close();
  });

  it("reports a port already in use", async () => {
    const tok = writeSecret(tempDir(), "t", TOKEN);
    const first = (await main(
      ["serve"],
      io({ QUORUM_LISTEN: "127.0.0.1:0", QUORUM_TOKEN_FILE: tok }).io,
    )) as RunningQuorum;
    const port = new URL(first.url).port;
    const t = io({ QUORUM_LISTEN: `127.0.0.1:${port}`, QUORUM_TOKEN_FILE: tok });
    expect(await main(["serve"], t.io)).toBe(1);
    expect(t.err.join("")).toMatch(/EADDRINUSE/);
    await first.close();
  });
});
