import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TtsClient } from "../src/discord/tts.js";
import { Transcriber } from "../src/discord/transcribe.js";
import { TOOLS, boundedToolName } from "../src/mcp.js";
import { DURATION_BUCKETS, Metrics, timedUpstream } from "../src/metrics.js";
import { VexaClient } from "../src/vexa/client.js";
import { TOKEN, startHarness, type Harness } from "./helpers/harness.js";

function reply(status: number, body: string): typeof fetch {
  return (async () => new Response(body, { status })) as typeof fetch;
}

const unreachable = (async () => {
  throw new TypeError("fetch failed");
}) as unknown as typeof fetch;

describe("Metrics", () => {
  it("renders counters, histograms and adapter gauges in Prometheus text", () => {
    const m = new Metrics();
    m.toolCall("say", "ok", 120);
    m.toolCall("say", "ok", 30);
    m.toolCall("say", "error", 7000);
    m.adapter("discord", () => true);
    m.adapter("vexa", () => false);
    const text = m.render();
    expect(text).toContain("# TYPE quorum_tool_calls_total counter");
    expect(text).toContain('quorum_tool_calls_total{tool="say",outcome="ok"} 2');
    expect(text).toContain('quorum_tool_calls_total{tool="say",outcome="error"} 1');
    expect(text).toContain("# TYPE quorum_tool_call_duration_seconds histogram");
    // 0.03 s and 0.12 s fall in the 0.05 and 0.25 buckets and above; 7 s only from le=10.
    expect(text).toContain('quorum_tool_call_duration_seconds_bucket{tool="say",le="0.025"} 0');
    expect(text).toContain('quorum_tool_call_duration_seconds_bucket{tool="say",le="0.05"} 1');
    expect(text).toContain('quorum_tool_call_duration_seconds_bucket{tool="say",le="5"} 2');
    expect(text).toContain('quorum_tool_call_duration_seconds_bucket{tool="say",le="10"} 3');
    expect(text).toContain('quorum_tool_call_duration_seconds_bucket{tool="say",le="+Inf"} 3');
    expect(text).toContain('quorum_tool_call_duration_seconds_count{tool="say"} 3');
    expect(text).toContain('quorum_tool_call_duration_seconds_sum{tool="say"} 7.15');
    expect(text).toContain('quorum_adapter_connected{adapter="discord"} 1');
    expect(text).toContain('quorum_adapter_connected{adapter="vexa"} 0');
    expect(text.endsWith("\n")).toBe(true);
    expect(DURATION_BUCKETS.length).toBeGreaterThan(0);
  });

  it("renders a family header even with no series yet", () => {
    const text = new Metrics().render();
    expect(text).toContain("# TYPE quorum_upstream_requests_total counter");
    expect(text).toContain("# TYPE quorum_adapter_connected gauge");
    expect(text).not.toContain("quorum_adapter_connected{");
  });

  it("escapes label values and treats a throwing adapter probe as down", () => {
    const m = new Metrics();
    m.toolCall('a"b\\c\nd', "ok", 1);
    m.adapter("companion", () => {
      throw new Error("boom");
    });
    const text = m.render();
    expect(text).toContain('tool="a\\"b\\\\c\\nd"');
    expect(text).toContain('quorum_adapter_connected{adapter="companion"} 0');
  });

  it("times an upstream call as ok or error, and rethrows", async () => {
    const m = new Metrics();
    await expect(timedUpstream(m, "tts", async () => 5)).resolves.toBe(5);
    await expect(
      timedUpstream(m, "tts", async () => {
        throw new Error("down");
      }),
    ).rejects.toThrow("down");
    await expect(timedUpstream(undefined, "tts", async () => 1)).resolves.toBe(1);
    const text = m.render();
    expect(text).toContain('quorum_upstream_requests_total{service="tts",outcome="ok"} 1');
    expect(text).toContain('quorum_upstream_requests_total{service="tts",outcome="error"} 1');
    expect(text).toContain('quorum_upstream_duration_seconds_count{service="tts"} 2');
  });
});

describe("upstream clients record metrics", () => {
  it("counts each transcription request, retries included", async () => {
    const m = new Metrics();
    const statuses = [503, 200];
    const t = new Transcriber({
      url: "http://stt",
      token: () => undefined,
      timeoutMs: 1000,
      metrics: m,
      sleep: async () => undefined,
      fetchImpl: (async () => {
        const status = statuses.shift() ?? 200;
        return new Response(JSON.stringify({ text: "hi" }), { status });
      }) as unknown as typeof fetch,
    });
    await expect(t.transcribe(Buffer.alloc(4))).resolves.toBe("hi");
    const text = m.render();
    expect(text).toContain(
      'quorum_upstream_requests_total{service="transcribe",outcome="error"} 1',
    );
    expect(text).toContain('quorum_upstream_requests_total{service="transcribe",outcome="ok"} 1');
  });

  it("counts an unreachable transcription service as an error", async () => {
    const m = new Metrics();
    const t = new Transcriber({
      url: "http://stt",
      token: () => undefined,
      timeoutMs: 100,
      metrics: m,
      retry: { maxAttempts: 1 },
      fetchImpl: unreachable,
    });
    await expect(t.transcribe(Buffer.alloc(4))).rejects.toMatchObject({ code: "upstream_error" });
    expect(m.render()).toContain(
      'quorum_upstream_requests_total{service="transcribe",outcome="error"} 1',
    );
  });

  it("counts TTS requests by outcome", async () => {
    const m = new Metrics();
    const opts = { url: "http://tts", token: () => undefined, timeoutMs: 100, metrics: m };
    await new TtsClient({ ...opts, fetchImpl: reply(200, "pcm") }).synthesize("x", "v");
    await expect(
      new TtsClient({ ...opts, fetchImpl: reply(500, "") }).synthesize("x", "v"),
    ).rejects.toMatchObject({ code: "upstream_error" });
    const text = m.render();
    expect(text).toContain('quorum_upstream_requests_total{service="tts",outcome="ok"} 1');
    expect(text).toContain('quorum_upstream_requests_total{service="tts",outcome="error"} 1');
  });

  it("counts Vexa requests by outcome without putting paths in labels", async () => {
    const m = new Metrics();
    const make = (f: typeof fetch): VexaClient =>
      new VexaClient({
        baseUrl: "http://vexa",
        apiKey: () => "k",
        timeoutMs: 100,
        metrics: m,
        fetchImpl: f,
      });
    await make(reply(200, "{}")).request("GET", "/bots/zoom/123456789");
    await expect(make(reply(404, "{}")).request("GET", "/bots/zoom/123456789")).rejects.toThrow();
    await expect(make(unreachable).request("GET", "/bots")).rejects.toThrow();
    const text = m.render();
    expect(text).toContain('quorum_upstream_requests_total{service="vexa",outcome="ok"} 1');
    expect(text).toContain('quorum_upstream_requests_total{service="vexa",outcome="error"} 2');
    expect(text).not.toContain("123456789");
  });
});

describe("GET /metrics", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness({});
  });
  afterEach(() => h.close());

  const scrape = (auth: string | undefined): Promise<Response> =>
    fetch(h.q.url + "/metrics", auth ? { headers: { Authorization: auth } } : {});

  it("rejects a missing or wrong bearer token", async () => {
    const missing = await scrape(undefined);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");
    expect((await scrape("Bearer wrong")).status).toBe(401);
  });

  it("answers GET only", async () => {
    const res = await fetch(h.q.url + "/metrics", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  it("counts tool calls by contract tool and outcome", async () => {
    await h.call("meeting.status", { meeting_id: "nope" });
    await h.call("meeting.status", { meeting_id: "nope" });
    await h.call("not.a.tool");
    const res = await scrape(`Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain('quorum_tool_calls_total{tool="meeting.status",outcome="error"} 2');
    expect(text).toContain('quorum_tool_calls_total{tool="unknown",outcome="error"} 1');
    expect(text).toContain('quorum_tool_call_duration_seconds_count{tool="meeting.status"} 2');
    expect(text).not.toContain("not.a.tool");
    expect(text).not.toContain("nope");
  });

  it("keeps every tool label inside the contract tool list", async () => {
    await h.call("meeting.status", { meeting_id: "x" });
    await h.call("x".repeat(300));
    await h.call("../../etc/passwd");
    const text = await (await scrape(`Bearer ${TOKEN}`)).text();
    const allowed = new Set<string>([...TOOLS.map((t) => t.name), "unknown"]);
    const tools = [...text.matchAll(/\btool="([^"]*)"/g)].map((m) => m[1] as string);
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(allowed.has(tool)).toBe(true);
    }
    expect(boundedToolName("say")).toBe("say");
    expect(boundedToolName("anything else")).toBe("unknown");
  });

  it("reports adapter connectivity", async () => {
    // No QUORUM_TRANSCRIBE_URL: a companion join would answer platform_unavailable.
    const text = await (await scrape(`Bearer ${TOKEN}`)).text();
    expect(text).toContain('quorum_adapter_connected{adapter="companion"} 0');
    expect(text).not.toContain('adapter="vexa"');
    expect(text).not.toContain('adapter="discord"');
  });
});

describe("GET /metrics with upstreams configured", () => {
  it("reports companion up with a transcription URL and vexa idle as connected", async () => {
    const h = await startHarness({
      QUORUM_TRANSCRIBE_URL: "http://127.0.0.1:9",
      QUORUM_VEXA_URL: "http://127.0.0.1:9",
    });
    try {
      const text = await (
        await fetch(h.q.url + "/metrics", { headers: { Authorization: `Bearer ${TOKEN}` } })
      ).text();
      expect(text).toContain('quorum_adapter_connected{adapter="companion"} 1');
      expect(text).toContain('quorum_adapter_connected{adapter="vexa"} 1');
    } finally {
      await h.close();
    }
  });
});
