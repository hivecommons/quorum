import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSCRIBE_HOTWORDS,
  DEFAULTS,
  loadConfig,
  parseListen,
  readSecretFile,
} from "../src/config.js";
import { QuorumError } from "../src/errors.js";
import { clearSecrets, redact } from "../src/log.js";
import { tempDir, writeSecret } from "./helpers/harness.js";

describe("loadConfig", () => {
  it("uses the contract defaults", () => {
    const c = loadConfig({});
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(8765);
    expect(c.chatMaxChars).toBe(2000);
    expect(c.transcriptBuffer).toBe(DEFAULTS.transcriptBuffer);
    expect(c.transcribeHotwords).toContain("pull request");
    expect(c.transcribeHotwords).toContain("Betty");
    expect(c.discordSilenceMs).toBe(500);
    expect(c.discordCommands).toBe("guild");
    expect(c.vexaVoiceDefault).toBe(false);
    expect(c.vexaUrl).toBeUndefined();
  });

  it("defaults the speech, leave and early transcription settings", () => {
    expect(loadConfig({})).toMatchObject({
      ttsCacheMaxBytes: 33_554_432,
      leaveDrainTimeoutMs: 8000,
      sayPrewarmMaxLines: 32,
      sayPollMs: 200,
      companionEarlyMs: 100,
    });
  });

  it("reads the speech, leave and early transcription overrides", () => {
    expect(
      loadConfig({
        QUORUM_TTS_CACHE_MAX_BYTES: "1024",
        QUORUM_LEAVE_DRAIN_TIMEOUT_MS: "0",
        QUORUM_SAY_PREWARM_MAX_LINES: "4",
        QUORUM_SAY_POLL_MS: "50",
        QUORUM_COMPANION_EARLY_MS: "0",
      }),
    ).toMatchObject({
      ttsCacheMaxBytes: 1024,
      leaveDrainTimeoutMs: 0,
      sayPrewarmMaxLines: 4,
      sayPollMs: 50,
      companionEarlyMs: 0,
    });
    expect(loadConfig({ QUORUM_COMPANION_EARLY_MS: "250" }).companionEarlyMs).toBe(250);
  });

  it("sends the project's vocabulary as default hotwords, the bot's name and hive first", () => {
    const words = loadConfig({}).transcribeHotwords;
    expect(words.join(", ")).toBe(DEFAULT_TRANSCRIBE_HOTWORDS);
    expect(words.slice(0, 3)).toEqual(["Betty", "hive", "hive queue"]);
    for (const w of [
      "Kubernetes",
      "KubeCon",
      "CNCF",
      "Spektacular",
      "Spek",
      "Plaud",
      "RFC",
      "inbox",
      "spoke",
      "hub",
    ]) {
      expect(words).toContain(w);
    }
    expect(loadConfig({ QUORUM_TRANSCRIBE_HOTWORDS: "alpha, beta" }).transcribeHotwords).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("reads overrides and trims trailing slashes", () => {
    const c = loadConfig({
      QUORUM_LISTEN: "0.0.0.0:9000",
      QUORUM_VEXA_URL: "http://vexa:8000///",
      QUORUM_TRANSCRIBE_URL: "http://stt/",
      QUORUM_CHAT_MAX_CHARS: "50",
      QUORUM_DISCORD_COMMANDS: "global",
      QUORUM_VEXA_VOICE: "yes",
      QUORUM_LOG_LEVEL: "debug",
      QUORUM_TOKEN_FILE: " /t ",
    });
    expect(c).toMatchObject({
      host: "0.0.0.0",
      port: 9000,
      vexaUrl: "http://vexa:8000",
      transcribeUrl: "http://stt",
      chatMaxChars: 50,
      discordCommands: "global",
      vexaVoiceDefault: true,
      logLevel: "debug",
      tokenFile: "/t",
    });
    expect(loadConfig({ QUORUM_VEXA_VOICE: "off" }).vexaVoiceDefault).toBe(false);
  });

  it.each([
    [{ QUORUM_CHAT_MAX_CHARS: "0" }, /positive integer/],
    [{ QUORUM_CHAT_MAX_CHARS: "1.5" }, /positive integer/],
    [{ QUORUM_DISCORD_COMMANDS: "some" }, /guild, global or off/],
    [{ QUORUM_VEXA_VOICE: "maybe" }, /true or false/],
    [{ QUORUM_LISTEN: "nope" }, /host:port/],
    [
      { QUORUM_COMPANION_EARLY_MS: "-1" },
      /QUORUM_COMPANION_EARLY_MS must be a non-negative integer/,
    ],
    [{ QUORUM_COMPANION_EARLY_MS: "1.5" }, /non-negative integer/],
    [{ QUORUM_COMPANION_EARLY_MS: "soon" }, /non-negative integer/],
    [{ QUORUM_LEAVE_DRAIN_TIMEOUT_MS: "-5" }, /non-negative integer/],
    [{ QUORUM_TTS_CACHE_MAX_BYTES: "0" }, /positive integer/],
    [{ QUORUM_SAY_PREWARM_MAX_LINES: "0" }, /positive integer/],
    [{ QUORUM_SAY_POLL_MS: "0" }, /positive integer/],
  ])("rejects %j", (env, msg) => {
    expect(() => loadConfig(env)).toThrow(msg);
  });
});

describe("parseListen", () => {
  it.each([
    ["127.0.0.1:8765", "127.0.0.1", 8765],
    [":9000", "127.0.0.1", 9000],
    ["[::1]:8080", "::1", 8080],
    ["localhost:0", "localhost", 0],
  ])("%s", (raw, host, port) => {
    expect(parseListen(raw)).toEqual({ host, port });
  });

  it("rejects ports out of range", () => {
    expect(() => parseListen("h:70000")).toThrow();
  });
});

describe("readSecretFile", () => {
  it("reads, trims and registers the secret for redaction", () => {
    clearSecrets();
    const p = writeSecret(tempDir(), "k", "s3cret-value");
    expect(readSecretFile(p, "key")).toBe("s3cret-value");
    expect(redact("x s3cret-value y")).toBe("x [redacted] y");
    clearSecrets();
  });

  it.each([
    [undefined, /not configured/],
    ["/does/not/exist", /cannot be read/],
  ])("fails with platform_unavailable for %s", (p, msg) => {
    try {
      readSecretFile(p, "key");
      expect.unreachable();
    } catch (err) {
      expect((err as QuorumError).code).toBe("platform_unavailable");
      expect((err as Error).message).toMatch(msg);
    }
  });

  it("rejects an empty file", () => {
    const p = writeSecret(tempDir(), "k", "   ");
    expect(() => readSecretFile(p, "key")).toThrow(/empty/);
  });
});
