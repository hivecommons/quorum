import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeVexa } from "./helpers/fakeVexa.js";
import {
  openSse,
  startHarness,
  tempDir,
  until,
  writeSecret,
  type Harness,
} from "./helpers/harness.js";

const fake = new FakeVexa();
let h: Harness;

beforeAll(async () => {
  await fake.start();
});
afterAll(() => fake.stop());

beforeEach(async () => {
  fake.reset();
  fake.requests.length = 0;
  fake.rows.length = 0;
  h = await startHarness({
    QUORUM_VEXA_URL: fake.url,
    QUORUM_VEXA_API_KEY_FILE: writeSecret(tempDir(), "vexa", fake.apiKey),
    QUORUM_VEXA_WS_BACKOFF_MIN_MS: "10",
    QUORUM_VEXA_WS_BACKOFF_MAX_MS: "20",
    QUORUM_CHAT_MAX_CHARS: "20",
    QUORUM_CHAT_CONFIRM_TIMEOUT_MS: "200",
    QUORUM_CHAT_CONFIRM_POLL_MS: "10",
    QUORUM_SAY_CONFIRM_TIMEOUT_MS: "300",
    QUORUM_LOBBY_TIMEOUT_S: "90",
  });
});
afterEach(() => h.close());

const MEET = "https://meet.google.com/abc-defg-hij";

async function joinMeet(extra: Record<string, unknown> = {}): Promise<string> {
  const r = await h.call("meeting.join", { url: MEET, display_name: "Hive notes", ...extra });
  expect(r).toMatchObject({ ok: true, platform: "google_meet", state: "requested" });
  await until(() => fake.sockets.size > 0 && fake.subscribeFrames.length > 0);
  return r.meeting_id as string;
}

function status(s: string, nativeId = "abc-defg-hij", id = 100): Record<string, unknown> {
  return {
    type: "meeting.status",
    meeting: { id, platform: "google_meet", native_id: nativeId },
    payload: { status: s },
  };
}

async function goLive(): Promise<string> {
  const id = await joinMeet();
  fake.broadcast(status("active"));
  await until(() => h.q.quorum.registry.get(id)?.state === "live");
  return id;
}

describe("meeting.join and lifecycle", () => {
  it("joins, streams state, segments and chat over SSE, and reads the transcript", async () => {
    const id = await joinMeet();
    const post = fake.requests.find((r) => r.method === "POST" && r.path === "/bots");
    expect(post?.body).toEqual({
      platform: "google_meet",
      native_meeting_id: "abc-defg-hij",
      bot_name: "Hive notes",
      recording_enabled: false,
      automatic_leave: { max_wait_for_admission: 90_000 },
    });
    expect(fake.subscribeFrames.at(-1)).toEqual({
      action: "subscribe",
      meetings: [{ platform: "google_meet", native_id: "abc-defg-hij" }],
    });

    const sse = await openSse(`${h.q.url}/events?meeting_id=${id}`);
    const all = await openSse(`${h.q.url}/events`);
    await sse.waitFor((e) => e.length === 1);
    expect(sse.events[0]).toEqual({ type: "state", meeting_id: id, state: "requested" });

    fake.broadcast(status("joining"));
    fake.broadcast(status("awaiting_admission"));
    fake.broadcast({
      type: "meeting.status",
      meeting_id: 100,
      native: "abc-defg-hij",
      status: "active",
    });
    await sse.waitFor((e) => e.filter((x) => x.type === "state").length === 4);
    expect(sse.events.slice(1).map((e) => e.state)).toEqual(["joining", "lobby", "live"]);

    fake.broadcast({
      type: "transcript",
      meeting: { id: 100, platform: "google_meet", native_id: "abc-defg-hij" },
      speaker: "Alice",
      confirmed: [
        {
          segment_id: "s:1",
          speaker: "Alice",
          text: "Hello team",
          start: 1.5,
          end: 2.5,
          completed: true,
        },
      ],
      pending: [
        {
          segment_id: "s:2",
          speaker: "Bob",
          text: "and then",
          start: 3,
          end: 3.4,
          completed: false,
        },
      ],
    });
    fake.broadcast({
      type: "transcript",
      meeting: { id: 100 },
      confirmed: [
        {
          segment_id: "s:2",
          speaker: "Bob",
          text: "and then we ship",
          start: 3,
          end: 4,
          completed: true,
        },
      ],
      pending: [],
    });
    fake.broadcast({
      type: "transcription_segment",
      meeting: { id: 100 },
      speaker: "Carol",
      text: "single",
      start_time: 5,
      end_time: 6,
      completed: true,
      segment_id: "s:3",
    });
    fake.broadcast({
      type: "chat_message",
      meeting: { id: 100, native_id: "abc-defg-hij", platform: "google_meet" },
      sender: "Alice",
      text: "agenda in doc",
      timestamp: 1783728000000,
      is_from_bot: false,
    });
    // The same chat line again as a source:"chat" transcript segment: delivered once.
    fake.broadcast({
      type: "transcript",
      meeting: { id: 100 },
      confirmed: [
        {
          segment_id: "c:1",
          speaker: "Alice",
          text: "agenda in doc",
          start: 1783728000,
          end: 1783728000,
          completed: true,
          source: "chat",
        },
      ],
      pending: [],
    });
    fake.broadcast({
      type: "transcript",
      meeting: { id: 100 },
      confirmed: [
        {
          segment_id: "c:2",
          speaker: "Dan",
          text: "via segment",
          start: 2,
          end: 2,
          completed: true,
          source: "chat",
          absolute_start_time: "2026-07-11T08:00:00Z",
        },
      ],
      pending: [],
    });
    fake.broadcast({ type: "error", error: "subscription_revoked" });
    fake.broadcast({ type: "something.new" });
    fake.broadcast({ type: "meeting.status", meeting: { id: 100 }, payload: {} });
    fake.broadcast({
      type: "transcript",
      meeting: { id: 999, native_id: "other" },
      confirmed: [{ text: "not ours" }],
    });

    await sse.waitFor((e) => e.filter((x) => x.type === "chat").length === 2);
    await sse.waitFor((e) => e.filter((x) => x.type === "segment").length === 4);
    const segs = sse.events.filter((e) => e.type === "segment");
    expect(segs.map((s) => [s.seq, s.text, s.final])).toEqual([
      [1, "Hello team", true],
      [2, "and then", false],
      [3, "and then we ship", true],
      [4, "single", true],
    ]);
    expect(segs[0]).toEqual({
      type: "segment",
      meeting_id: id,
      seq: 1,
      speaker: { id: "Alice", name: "Alice" },
      text: "Hello team",
      start: 1.5,
      end: 2.5,
      final: true,
    });
    const chats = sse.events.filter((e) => e.type === "chat");
    expect(chats[0]).toEqual({
      type: "chat",
      meeting_id: id,
      seq: 5,
      author: { id: "Alice", name: "Alice" },
      text: "agenda in doc",
      at: new Date(1783728000000).toISOString(),
    });
    expect(chats[1]).toMatchObject({ text: "via segment", at: "2026-07-11T08:00:00.000Z" });
    expect(sse.raw.some((r) => r.startsWith("id: 1\n"))).toBe(true);
    await all.waitFor((e) => e.filter((x) => x.type === "segment").length === 4);

    const tr = await h.call("transcript.read", { meeting_id: id });
    expect(tr).toMatchObject({ ok: true, next_seq: 4 });
    expect((tr.segments as { text: string }[]).map((s) => s.text)).toEqual([
      "Hello team",
      "and then we ship",
      "single",
    ]);
    expect(await h.call("transcript.read", { meeting_id: id, after_seq: 3 })).toMatchObject({
      segments: [{ text: "single" }],
      next_seq: 4,
    });
    expect(await h.call("transcript.read", { meeting_id: id, after_seq: -1 })).toMatchObject({
      ok: false,
      error: { code: "invalid_argument" },
    });

    const st = await h.call("meeting.status", { meeting_id: id });
    expect(st).toMatchObject({ ok: true, state: "live" });
    expect((st.participants as { name: string }[]).map((p) => p.name).sort()).toEqual([
      "Alice",
      "Bob",
      "Carol",
      "Dan",
    ]);

    const replay = await openSse(`${h.q.url}/events?meeting_id=${id}&after_seq=4`);
    await replay.waitFor((e) => e.length >= 3);
    expect(replay.events.map((e) => e.type)).toEqual(["state", "chat", "chat"]);

    sse.close();
    all.close();
    replay.close();
  });

  it("is idempotent for the same meeting URL", async () => {
    const a = await joinMeet();
    const b = await h.call("meeting.join", { url: "abc-defg-hij", display_name: "Hive notes" });
    expect(b.meeting_id).toBe(a);
    expect(fake.requests.filter((r) => r.method === "POST" && r.path === "/bots").length).toBe(1);
  });

  it("passes passcodes, Teams hosts, legacy URLs and voice through to Vexa", async () => {
    await h.call("meeting.join", {
      url: "https://teams.microsoft.com/meet/1234567890123?p=PASS",
      display_name: "H",
      voice: true,
    });
    await h.call("meeting.join", {
      url: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc@thread.v2/0",
      display_name: "H",
    });
    await h.call("meeting.join", {
      url: "https://zoom.us/j/1234567890?pwd=z",
      display_name: "H",
      platform: "zoom",
    });
    const bodies = fake.requests
      .filter((r) => r.path === "/bots" && r.method === "POST")
      .map((r) => r.body as Record<string, unknown>);
    expect(bodies[0]).toMatchObject({
      platform: "teams",
      native_meeting_id: "1234567890123",
      passcode: "PASS",
      teams_base_host: "teams.microsoft.com",
      voice_agent_enabled: true,
    });
    expect(bodies[1]).toMatchObject({
      platform: "teams",
      meeting_url: expect.stringContaining("meetup-join"),
    });
    expect(bodies[2]).toMatchObject({
      platform: "zoom",
      native_meeting_id: "1234567890",
      passcode: "z",
      meeting_url: "https://zoom.us/j/1234567890?pwd=z",
    });
    expect(bodies[2]).not.toHaveProperty("voice_agent_enabled");
  });

  it("sends Vexa the exact Zoom /bots shape, meeting_url included", async () => {
    const url = "https://us05web.zoom.us/j/81234567890?pwd=PLACEHOLDER";
    const r = await h.call("meeting.join", { url, display_name: "Betty", voice: true });
    expect(r).toMatchObject({ ok: true, platform: "zoom", state: "requested" });
    const body = fake.requests.find((x) => x.path === "/bots" && x.method === "POST")?.body;
    expect(body).toEqual({
      platform: "zoom",
      native_meeting_id: "81234567890",
      bot_name: "Betty",
      recording_enabled: false,
      automatic_leave: { max_wait_for_admission: 90_000 },
      voice_agent_enabled: true,
      passcode: "PLACEHOLDER",
      meeting_url: url,
    });
  });

  it("builds the Zoom meeting_url for a bare numeric id", async () => {
    await h.call("meeting.join", { url: "1234567890", display_name: "H" });
    const body = fake.requests.find((x) => x.path === "/bots" && x.method === "POST")?.body;
    expect(body).toMatchObject({
      platform: "zoom",
      native_meeting_id: "1234567890",
      meeting_url: "https://zoom.us/j/1234567890",
    });
    expect(body).not.toHaveProperty("passcode");
  });

  it.each([
    [{ url: "https://example.com/x", display_name: "H" }, "invalid_argument"],
    [{ url: MEET }, "invalid_argument"],
    [{ url: MEET, display_name: "x".repeat(101) }, "invalid_argument"],
    [{ url: MEET, display_name: "H", platform: "teams" }, "invalid_argument"],
    [{ url: MEET, display_name: 5 }, "invalid_argument"],
    [{ url: MEET, display_name: "H", voice: "yes" }, "invalid_argument"],
    [{ display_name: "H" }, "invalid_argument"],
    [{ platform: "discord", guild_id: "123456", channel_id: "654321" }, "platform_unavailable"],
    [{ platform: "discord", guild_id: "x", channel_id: "654321" }, "invalid_argument"],
  ])("rejects join %j with %s", async (args, code) => {
    expect(await h.call("meeting.join", args)).toMatchObject({ ok: false, error: { code } });
  });

  it.each([
    [500, "upstream_error"],
    [429, "rate_limited"],
    [422, "invalid_argument"],
    [403, "upstream_error"],
  ])("maps a POST /bots %i to %s and forgets the meeting", async (statusCode, code) => {
    fake.on("POST", /^\/bots$/, { status: statusCode, body: { detail: "upstream says no" } });
    const r = await h.call("meeting.join", { url: MEET, display_name: "H" });
    expect(r).toMatchObject({
      ok: false,
      error: { code, message: expect.stringContaining("upstream says no") },
    });
    expect(h.q.quorum.registry.all()).toEqual([]);
  });

  it("adopts a bot that is already running on 409, and fails when there is none", async () => {
    fake.on("POST", /^\/bots$/, { status: 409, body: { detail: "bot exists" } });
    let r = await h.call("meeting.join", { url: MEET, display_name: "H" });
    expect(r).toMatchObject({ ok: false, error: { code: "upstream_error" } });
    fake.rows.push({
      id: 7,
      platform: "google_meet",
      native_meeting_id: "abc-defg-hij",
      status: "active",
    });
    r = await h.call("meeting.join", { url: MEET, display_name: "H" });
    expect(r).toMatchObject({ ok: true, state: "live" });
    expect(h.q.quorum.registry.get(r.meeting_id as string)?.vexaId).toBe(7);
  });

  it("maps terminal statuses using the end reason from GET /bots", async () => {
    const cases: [string, string | null, string | null, string, string | undefined][] = [
      ["completed", "platform_join_refused", null, "blocked", "platform_join_refused"],
      ["failed", "awaiting_admission_timeout", "awaiting_admission", "failed", "lobby_timeout"],
      ["completed", "left_alone", null, "ended", "left_alone"],
      ["failed", null, "joining", "failed", "failed_while_joining"],
      ["completed", null, null, "ended", undefined],
      ["failed", null, null, "failed", undefined],
    ];
    for (const [vexaStatus, reason, stage, state, why] of cases) {
      const id = await joinMeet();
      const row = fake.rows[0];
      if (!row) throw new Error("no row");
      row.completion_reason = reason;
      row.failure_stage = stage;
      row.status = vexaStatus;
      fake.broadcast(status(vexaStatus, "abc-defg-hij", row.id));
      await until(() => h.q.quorum.registry.get(id)?.terminal === true);
      const m = h.q.quorum.registry.get(id);
      expect([m?.state, m?.reason]).toEqual([state, why]);
      await until(
        () =>
          fake.subscribeFrames.some((f) => (f as { action?: string }).action === "unsubscribe") ||
          fake.sockets.size === 0,
      );
    }
  });

  it("still ends the meeting when the end reason cannot be read", async () => {
    const id = await joinMeet();
    fake.on("GET", /^\/bots/, { status: 500 });
    fake.broadcast(status("completed"));
    await until(() => h.q.quorum.registry.get(id)?.state === "ended");
  });

  it("maps needs_help, stopping and unknown statuses", async () => {
    const id = await joinMeet();
    fake.broadcast(status("needs_human_help"));
    await until(() => h.q.quorum.registry.get(id)?.reason === "needs_help");
    expect(h.q.quorum.registry.get(id)?.state).toBe("lobby");
    fake.broadcast(status("brand_new_status"));
    await until(() => h.q.quorum.registry.get(id)?.reason === "brand_new_status");
    fake.broadcast(status("stopping"));
    await until(() => h.q.quorum.registry.get(id)?.state === "ended");
  });
});

describe("chat.post and say", () => {
  it("posts chat when live and drops the bot's own echo", async () => {
    const id = await goLive();
    const sse = await openSse(`${h.q.url}/events?meeting_id=${id}`);
    const r = await h.call("chat.post", { meeting_id: id, text: "recording notice" });
    expect(r).toMatchObject({ ok: true });
    expect(Date.parse(r.posted_at as string)).not.toBeNaN();
    const req = fake.requests.find((x) => x.path === "/bots/google_meet/abc-defg-hij/chat");
    expect(req?.body).toEqual({ text: "recording notice" });
    fake.broadcast({
      type: "chat_message",
      meeting: { native_id: "abc-defg-hij" },
      sender: "Hive notes",
      text: "recording notice",
      timestamp: 1,
    });
    fake.broadcast({
      type: "chat_message",
      meeting: { native_id: "abc-defg-hij" },
      sender: "Alice",
      text: "thanks",
      timestamp: 2,
    });
    fake.broadcast({
      type: "chat_message",
      meeting: { native_id: "abc-defg-hij" },
      sender: "Alice",
      text: "  ",
    });
    fake.broadcast({
      type: "chat_message",
      meeting: { native_id: "abc-defg-hij" },
      sender: 42,
      text: "no timestamp",
    });
    await sse.waitFor((e) => e.filter((x) => x.type === "chat").length === 2);
    expect(sse.events.filter((e) => e.type === "chat").map((e) => e.text)).toEqual([
      "thanks",
      "no timestamp",
    ]);
    sse.close();
  });

  it.each([
    [{ status: 409, body: { detail: "bot not admitted" } }, "not_live"],
    [{ status: 404, body: { detail: "No active meeting for this bot" } }, "not_live"],
    [{ status: 404, body: { detail: "Not Found" } }, "platform_unavailable"],
    [
      { status: 422, body: { detail: "in-meeting chat cannot be sent on 'zoom'" } },
      "platform_unavailable",
    ],
    [{ status: 422, body: { detail: "'text' must be a non-empty string" } }, "invalid_argument"],
    [
      { status: 429, body: { detail: "slow down" }, headers: { "Retry-After": "5" } },
      "rate_limited",
    ],
    [{ status: 502, body: { detail: "bad gateway" } }, "upstream_error"],
  ])("maps chat reply %j to %s", async (reply, code) => {
    const id = await goLive();
    fake.on("POST", /\/chat$/, reply);
    expect(await h.call("chat.post", { meeting_id: id, text: "hi" })).toMatchObject({
      ok: false,
      error: { code },
    });
  });

  it("answers delivery unconfirmed without confirm, and never reads the delivery record", async () => {
    const id = await goLive();
    const r = await h.call("chat.post", { meeting_id: id, text: "hello" });
    expect(r).toMatchObject({ ok: true, delivery: "unconfirmed" });
    expect(fake.requests.some((x) => x.method === "GET" && /\/chat\//.test(x.path))).toBe(false);
  });

  it("confirms a chat line once the bot reports it posted", async () => {
    const id = await goLive();
    let reads = 0;
    fake.on("GET", /\/chat\/req1$/, () => {
      reads += 1;
      return { status: 200, body: { status: reads < 3 ? "queued" : "posted" } };
    });
    const r = await h.call("chat.post", { meeting_id: id, text: "consent", confirm: true });
    expect(r).toMatchObject({ ok: true, delivery: "confirmed" });
    expect(reads).toBe(3);
  });

  it("answers platform_unavailable with the bot's reason when the send failed", async () => {
    const id = await goLive();
    fake.on("GET", /\/chat\/req1$/, {
      status: 200,
      body: { status: "failed", reason: "no_composer" },
    });
    const r = await h.call("chat.post", { meeting_id: id, text: "consent", confirm: true });
    expect(r).toMatchObject({ ok: false, error: { code: "platform_unavailable" } });
    expect((r.error as { message: string }).message).toContain("no_composer");
  });

  it.each([
    ["the bot never settles the send", { status: 200, body: { status: "queued" } }],
    ["Vexa reads the send as unconfirmed", { status: 200, body: { status: "unconfirmed" } }],
    ["this Vexa has no delivery route", { status: 404, body: { detail: "Not Found" } }],
  ])("answers delivery unconfirmed when %s", async (_why, reply) => {
    const id = await goLive();
    fake.on("GET", /\/chat\/req1$/, reply);
    const r = await h.call("chat.post", { meeting_id: id, text: "consent", confirm: true });
    expect(r).toMatchObject({ ok: true, delivery: "unconfirmed" });
  });

  it("answers delivery unconfirmed when Vexa gives no request id", async () => {
    const id = await goLive();
    fake.on("POST", /\/chat$/, { status: 200, body: { status: "queued" } });
    const r = await h.call("chat.post", { meeting_id: id, text: "consent", confirm: true });
    expect(r).toMatchObject({ ok: true, delivery: "unconfirmed" });
  });

  it("refuses a confirm that is not a boolean", async () => {
    const id = await goLive();
    expect(await h.call("chat.post", { meeting_id: id, text: "x", confirm: "yes" })).toMatchObject({
      error: { code: "invalid_argument" },
    });
  });

  it("validates text and the meeting state", async () => {
    const id = await joinMeet();
    expect(await h.call("chat.post", { meeting_id: id, text: "hi" })).toMatchObject({
      error: { code: "not_live" },
    });
    expect(await h.call("chat.post", { meeting_id: id, text: "x".repeat(21) })).toMatchObject({
      error: { code: "invalid_argument" },
    });
    expect(await h.call("chat.post", { meeting_id: id })).toMatchObject({
      error: { code: "invalid_argument" },
    });
    expect(await h.call("chat.post", { meeting_id: "m_nope", text: "x" })).toMatchObject({
      error: { code: "not_found" },
    });
    expect(await h.call("say", { meeting_id: id, text: "x".repeat(1001) })).toMatchObject({
      error: { code: "invalid_argument" },
    });
  });

  it("answers blocked and lobby_timeout for meetings that ended that way", async () => {
    let id = await joinMeet();
    let row = fake.rows[0];
    if (row) row.completion_reason = "platform_join_refused";
    fake.broadcast(status("failed"));
    await until(() => h.q.quorum.registry.get(id)?.state === "blocked");
    expect(await h.call("chat.post", { meeting_id: id, text: "x" })).toMatchObject({
      error: { code: "blocked" },
    });

    id = await joinMeet();
    row = fake.rows[0];
    if (row) row.completion_reason = "awaiting_admission_timeout";
    fake.broadcast(status("completed", "abc-defg-hij", row?.id));
    await until(() => h.q.quorum.registry.get(id)?.state === "failed");
    expect(await h.call("say", { meeting_id: id, text: "x" })).toMatchObject({
      error: { code: "lobby_timeout" },
    });
  });

  it("speaks only when the bot joined with voice", async () => {
    const id = await goLive();
    expect(await h.call("say", { meeting_id: id, text: "hello" })).toMatchObject({
      error: { code: "platform_unavailable" },
    });
    const live = h.q.quorum.registry.get(id);
    if (live) live.voice = true;
    expect(await h.call("say", { meeting_id: id, text: "hello" })).toEqual({
      ok: true,
      queued: true,
    });
    expect(fake.requests.find((r) => r.path.endsWith("/speak"))?.body).toEqual({ text: "hello" });
    for (const [s, code] of [
      [404, "platform_unavailable"],
      [409, "platform_unavailable"],
      [429, "rate_limited"],
      [422, "invalid_argument"],
    ] as const) {
      fake.on("POST", /\/speak$/, { status: s, body: { detail: "d" } });
      expect(await h.call("say", { meeting_id: id, text: "hello" })).toMatchObject({
        error: { code },
      });
    }
  });
  it("plays says strictly one after another and reports the clip's real duration", async () => {
    const id = await goLive();
    const live = h.q.quorum.registry.get(id);
    if (live) live.voice = true;
    let n = 0;
    fake.on("POST", /\/speak$/, () => ({
      status: 200,
      body: { status: "queued", request_id: `s${++n}` },
    }));
    let reads1 = 0;
    fake.on("GET", /\/speak\/s1$/, () => {
      reads1 += 1;
      return {
        status: 200,
        body: reads1 < 4 ? { status: "speaking" } : { status: "spoken", duration_ms: 1840.4 },
      };
    });
    fake.on("GET", /\/speak\/s2$/, { status: 200, body: { status: "spoken", duration_ms: 610 } });
    const first = h.call("say", { meeting_id: id, text: "One moment." });
    const second = h.call("say", { meeting_id: id, text: "Here is the answer." });
    expect(await first).toEqual({ ok: true, queued: true, duration_ms: 1840 });
    expect(await second).toEqual({ ok: true, queued: true, duration_ms: 610 });
    const order = fake.requests
      .filter((r) => r.path.includes("/speak"))
      .map((r) => `${r.method} ${r.path.replace(/^.*\/speak/, "speak")}`);
    // The second line is sent only once the first was reported spoken.
    expect(order).toEqual([
      "POST speak",
      "GET speak/s1",
      "GET speak/s1",
      "GET speak/s1",
      "GET speak/s1",
      "POST speak",
      "GET speak/s2",
    ]);
  });

  it("answers platform_unavailable naming the bot's reason when a line was not spoken", async () => {
    const id = await goLive();
    const live = h.q.quorum.registry.get(id);
    if (live) live.voice = true;
    fake.on("POST", /\/speak$/, { status: 200, body: { status: "queued", request_id: "m1" } });
    fake.on("GET", /\/speak\/m1$/, {
      status: 200,
      body: { status: "failed", reason: "mic_muted" },
    });
    const r = await h.call("say", { meeting_id: id, text: "Betty is taking notes." });
    expect(r).toEqual({
      ok: false,
      error: { code: "platform_unavailable", message: "the line was not spoken: mic_muted" },
    });
    // A refusal at the speak route itself passes the bot's detail through the same code.
    fake.on("POST", /\/speak$/, { status: 409, body: { detail: "mic_muted" } });
    expect(await h.call("say", { meeting_id: id, text: "again" })).toEqual({
      ok: false,
      error: { code: "platform_unavailable", message: "speak is not available: mic_muted" },
    });
    // A failed line does not block the next one.
    fake.on("POST", /\/speak$/, { status: 200, body: { status: "queued", duration_ms: 900 } });
    expect(await h.call("say", { meeting_id: id, text: "next" })).toEqual({
      ok: true,
      queued: true,
      duration_ms: 900,
    });
  });

  it.each([
    ["this Vexa has no playback route", { status: 404, body: { detail: "Not Found" } }],
    ["the bot never settles the line", { status: 200, body: { status: "speaking" } }],
    ["Vexa reads an unknown status", { status: 200, body: { status: "mystery" } }],
  ])("resolves without a duration when %s", async (_why, reply) => {
    const id = await goLive();
    const live = h.q.quorum.registry.get(id);
    if (live) live.voice = true;
    fake.on("POST", /\/speak$/, { status: 200, body: { status: "queued", request_id: "u1" } });
    fake.on("GET", /\/speak\/u1$/, reply);
    expect(await h.call("say", { meeting_id: id, text: "hello" })).toEqual({
      ok: true,
      queued: true,
    });
  });

  it("passes voice_id through as the per-speak voice and validates it", async () => {
    expect(
      await h.call("meeting.join", { url: MEET, display_name: "Hive", voice_id: "x".repeat(101) }),
    ).toMatchObject({
      error: { code: "invalid_argument", message: expect.stringContaining("voice_id") },
    });
    expect(
      await h.call("meeting.join", { url: MEET, display_name: "Hive", voice_id: 7 }),
    ).toMatchObject({ error: { code: "invalid_argument" } });
    const id = await joinMeet({ voice: true, voice_id: "af_bella" });
    expect(
      fake.requests.find((r) => r.method === "POST" && r.path === "/bots")?.body,
    ).not.toHaveProperty("voice_id");
    fake.broadcast(status("active"));
    await until(() => h.q.quorum.registry.get(id)?.state === "live");
    expect(await h.call("say", { meeting_id: id, text: "hi" })).toMatchObject({ ok: true });
    expect(fake.requests.find((r) => r.path.endsWith("/speak"))?.body).toEqual({
      text: "hi",
      voice: "af_bella",
    });
  });
});

describe("meeting.leave, meeting.delete and status", () => {
  it("leaves once and treats a vanished bot as already gone", async () => {
    const id = await goLive();
    expect(await h.call("meeting.leave", { meeting_id: id })).toEqual({ ok: true, state: "ended" });
    expect(
      fake.requests.filter((r) => r.method === "DELETE" && r.path.startsWith("/bots/")).length,
    ).toBe(1);
    expect(await h.call("meeting.leave", { meeting_id: id })).toEqual({ ok: true, state: "ended" });
    expect(
      fake.requests.filter((r) => r.method === "DELETE" && r.path.startsWith("/bots/")).length,
    ).toBe(1);

    const id2 = await joinMeet();
    fake.on("DELETE", /^\/bots\//, { status: 404, body: { detail: "gone" } });
    expect(await h.call("meeting.leave", { meeting_id: id2 })).toEqual({
      ok: true,
      state: "ended",
    });
    const id3 = await joinMeet();
    fake.on("DELETE", /^\/bots\//, { status: 500, body: { detail: "boom" } });
    expect(await h.call("meeting.leave", { meeting_id: id3 })).toMatchObject({
      error: { code: "upstream_error" },
    });
    expect(await h.call("meeting.leave", { meeting_id: "m_x" })).toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("deletes upstream, forgets the meeting and closes its event stream", async () => {
    const id = await goLive();
    const sse = await openSse(`${h.q.url}/events?meeting_id=${id}`);
    await sse.waitFor((e) => e.length > 0);
    expect(await h.call("meeting.delete", { meeting_id: id })).toEqual({ ok: true, deleted: true });
    expect(
      fake.requests.some(
        (r) => r.method === "DELETE" && r.path === "/meetings/google_meet/abc-defg-hij",
      ),
    ).toBe(true);
    expect(
      fake.requests.some(
        (r) => r.method === "DELETE" && r.path === "/bots/google_meet/abc-defg-hij",
      ),
    ).toBe(true);
    expect(await h.call("meeting.status", { meeting_id: id })).toMatchObject({
      error: { code: "not_found" },
    });
    expect(await h.call("transcript.read", { meeting_id: id })).toMatchObject({
      error: { code: "not_found" },
    });
    sse.close();
  });

  it("treats a 404 on delete as nothing left to erase, and reports other failures", async () => {
    let id = await goLive();
    await h.call("meeting.leave", { meeting_id: id });
    fake.on("DELETE", /^\/meetings\//, { status: 404, body: { detail: "none" } });
    expect(await h.call("meeting.delete", { meeting_id: id })).toEqual({ ok: true, deleted: true });
    id = await goLive();
    fake.on("DELETE", /^\/meetings\//, { status: 500, body: { detail: "db down" } });
    expect(await h.call("meeting.delete", { meeting_id: id })).toMatchObject({
      error: { code: "upstream_error" },
    });
  });

  it("refreshes over REST while the live feed is down, and after reconnecting", async () => {
    const id = await joinMeet();
    fake.rejectWs = true;
    fake.dropSockets();
    await until(() => fake.sockets.size === 0);
    const row = fake.rows[0];
    if (row) row.status = "awaiting_admission";
    expect(await h.call("meeting.status", { meeting_id: id })).toMatchObject({
      ok: true,
      state: "lobby",
    });
    fake.on("GET", /^\/bots/, { status: 500 });
    expect(await h.call("meeting.status", { meeting_id: id })).toMatchObject({
      ok: true,
      state: "lobby",
    });
    fake.reset();
    if (row) row.status = "active";
    fake.rejectWs = false;
    await until(() => h.q.quorum.registry.get(id)?.state === "live", 5000);
    expect(fake.subscribeFrames.at(-1)).toMatchObject({ action: "subscribe" });
  });
});

describe("tool surface", () => {
  it("lists the seven tools and rejects unknown ones", async () => {
    const tools = await h.raw.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual([
      "meeting.join",
      "meeting.leave",
      "meeting.status",
      "transcript.read",
      "chat.post",
      "say",
      "meeting.delete",
    ]);
    const res = await h.raw.callTool({ name: "meeting.nope", arguments: {} });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
    expect(JSON.parse((res.content as { text: string }[])[0]?.text ?? "{}")).toMatchObject({
      ok: false,
    });
  });
});
