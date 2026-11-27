import { request } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bearerMatches } from "../src/http.js";
import { Meeting } from "../src/meeting.js";
import { TOKEN, openSse, startHarness, type Harness } from "./helpers/harness.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness({ QUORUM_SSE_HEARTBEAT_S: "1", QUORUM_MAX_BODY_BYTES: "2048" });
});
afterEach(() => h.close());

function rawRequest(
  method: string,
  path: string,
  body?: string,
  auth = true,
): Promise<{ status: number; text: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const u = new URL(h.q.url + path);
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}),
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c: Buffer) => (text += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe("bearerMatches", () => {
  it("compares in constant time and needs a non-empty token", () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`bearer   ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches("Bearer wrong", TOKEN)).toBe(false);
    expect(bearerMatches(undefined, TOKEN)).toBe(false);
    expect(bearerMatches("Basic abc", TOKEN)).toBe(false);
    expect(bearerMatches("Bearer ", "")).toBe(false);
  });
});

describe("HTTP surface", () => {
  it("serves /healthz without auth", async () => {
    const r = await rawRequest("GET", "/healthz", undefined, false);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toMatchObject({ ok: true, contract: "quorum.contract/v1" });
  });

  it("refuses requests without the bearer token", async () => {
    for (const path of ["/mcp", "/events", "/other"]) {
      const r = await rawRequest("GET", path, undefined, false);
      expect(r.status).toBe(401);
      expect(r.headers["www-authenticate"]).toBe("Bearer");
    }
    const bad = await openSse(`${h.q.url}/events`, "nope");
    expect(bad.status).toBe(401);
  });

  it("answers 404, 405, 413 and parse errors", async () => {
    expect((await rawRequest("GET", "/nope")).status).toBe(404);
    expect((await rawRequest("GET", "/mcp")).status).toBe(405);
    expect((await rawRequest("DELETE", "/mcp")).status).toBe(405);
    expect((await rawRequest("POST", "/mcp", "x".repeat(5000))).status).toBe(413);
    expect((await rawRequest("POST", "/mcp", "{not json")).status).toBe(400);
    expect((await rawRequest("POST", "/events")).status).toBe(405);
    expect((await rawRequest("GET", "/events?meeting_id=m_missing")).status).toBe(404);
    expect((await rawRequest("GET", "/events?after_seq=-2")).status).toBe(400);
    for (const bad of ["", "1e2", "0x10", "4.0"]) {
      expect((await rawRequest("GET", `/events?after_seq=${bad}`)).status).toBe(400);
    }
  });

  it("answers a JSON-RPC error when the MCP request is not valid JSON-RPC", async () => {
    const r = await rawRequest("POST", "/mcp", JSON.stringify({ hello: 1 }));
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it("sends heartbeats and pending Discord requests on the global stream", async () => {
    const m = new Meeting({ platform: "discord", bufferSize: 5 });
    m.guildId = "111111";
    m.channelId = "222222";
    h.q.quorum.registry.add(m);
    const other = new Meeting({ platform: "zoom", bufferSize: 5, state: "live" });
    h.q.quorum.registry.add(other);
    const done = new Meeting({ platform: "zoom", bufferSize: 5, state: "ended" });
    h.q.quorum.registry.add(done);
    const sse = await openSse(`${h.q.url}/events`);
    await sse.waitFor((e) => e.length === 2);
    expect(sse.events[0]).toEqual({
      type: "state",
      meeting_id: m.id,
      state: "requested",
      platform: "discord",
      guild_id: "111111",
      channel_id: "222222",
    });
    expect(sse.events[1]).toEqual({ type: "state", meeting_id: other.id, state: "live" });
    await new Promise((r) => setTimeout(r, 1200));
    expect(sse.raw.some((b) => b === ": ping")).toBe(true);
    m.setState("failed", "declined");
    await sse.waitFor((e) => e.some((x) => x.reason === "declined"));
    sse.close();
  });

  it("starts a meeting stream with its current state including the reason", async () => {
    const m = new Meeting({ platform: "zoom", bufferSize: 5 });
    h.q.quorum.registry.add(m);
    m.setState("lobby", "needs_help");
    const sse = await openSse(`${h.q.url}/events?meeting_id=${m.id}`);
    await sse.waitFor((e) => e.length === 1);
    expect(sse.events[0]).toEqual({
      type: "state",
      meeting_id: m.id,
      state: "lobby",
      reason: "needs_help",
    });
    sse.close();
  });

  it("answers platform_unavailable for Vexa platforms when QUORUM_VEXA_URL is unset", async () => {
    expect(
      await h.call("meeting.join", {
        url: "https://meet.google.com/abc-defg-hij",
        display_name: "H",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "platform_unavailable" },
    });
  });
});
