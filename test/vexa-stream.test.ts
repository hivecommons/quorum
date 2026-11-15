import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../src/log.js";
import { VexaStream, backoffDelay, wsUrl, type VexaFrame } from "../src/vexa/stream.js";
import { FakeVexa } from "./helpers/fakeVexa.js";
import { until } from "./helpers/harness.js";

const fake = new FakeVexa();
beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(() => {
  fake.rejectWs = false;
  fake.subscribeFrames.length = 0;
});

function stream(opts: Partial<ConstructorParameters<typeof VexaStream>[0]> = {}): VexaStream {
  return new VexaStream({
    baseUrl: fake.url,
    apiKey: () => fake.apiKey,
    backoffMinMs: 10,
    backoffMaxMs: 40,
    log: silentLogger,
    random: () => 1,
    ...opts,
  });
}

describe("helpers", () => {
  it("derives the ws URL", () => {
    expect(wsUrl("https://vexa.example/api/")).toBe("wss://vexa.example/api/ws");
    expect(wsUrl("http://vexa:8000?x=1")).toBe("ws://vexa:8000/ws");
  });

  it("backs off exponentially with jitter and a cap", () => {
    expect(backoffDelay(0, 100, 1000, () => 1)).toBe(100);
    expect(backoffDelay(3, 100, 1000, () => 1)).toBe(800);
    expect(backoffDelay(10, 100, 1000, () => 1)).toBe(1000);
    expect(backoffDelay(1, 100, 1000, () => 0)).toBe(100);
  });
});

describe("VexaStream", () => {
  it("subscribes, receives frames, re-subscribes after a drop, and unsubscribes", async () => {
    const s = stream();
    const frames: VexaFrame[] = [];
    let opens = 0;
    s.on("frame", (f: VexaFrame) => frames.push(f));
    s.on("open", () => opens++);
    s.subscribe("google_meet", "abc-defg-hij");
    s.subscribe("google_meet", "abc-defg-hij");
    await until(() => s.connected && frames.some((f) => f.type === "subscribed"));
    expect(fake.wsHeaders.at(-1)?.["x-api-key"]).toBe(fake.apiKey);
    s.subscribe("zoom", "123456789");
    await until(() => fake.subscribeFrames.length >= 2);
    expect(s.subscriptions).toBe(2);
    fake.broadcast({ type: "transcript", confirmed: [] });
    fake.broadcast("not json");
    fake.broadcast("[1,2]");
    await until(() => frames.some((f) => f.type === "transcript"));

    fake.dropSockets();
    await until(() => opens === 2 && s.connected);
    await until(() =>
      fake.subscribeFrames.some((f) => (f as { meetings?: unknown[] }).meetings?.length === 2),
    );

    s.unsubscribe("zoom", "123456789");
    s.unsubscribe("zoom", "nope");
    await until(() =>
      fake.subscribeFrames.some((f) => (f as { action?: string }).action === "unsubscribe"),
    );
    s.unsubscribe("google_meet", "abc-defg-hij");
    expect(s.connected).toBe(false);
  });

  it("keeps retrying with backoff while the key is refused or missing", async () => {
    fake.rejectWs = true;
    let keyCalls = 0;
    const s = stream({
      apiKey: () => {
        keyCalls++;
        if (keyCalls === 1) throw new Error("no key file");
        return fake.apiKey;
      },
    });
    let closes = 0;
    s.on("close", () => closes++);
    s.subscribe("zoom", "1");
    await until(() => closes >= 2);
    fake.rejectWs = false;
    await until(() => s.connected);
    s.stop();
    expect(keyCalls).toBeGreaterThanOrEqual(3);
  });

  it("terminates a socket that stops answering pings", async () => {
    const s = stream({ pingIntervalMs: 20 });
    let opens = 0;
    s.on("open", () => opens++);
    s.subscribe("zoom", "2");
    await until(() => opens === 1);
    // Pause the server side so pongs stop.
    for (const ws of fake.sockets)
      (ws as unknown as { _socket: { pause(): void } })._socket.pause();
    await until(() => opens >= 2, 4000);
    s.stop();
  });

  it("does not reconnect after stop", async () => {
    const s = stream();
    s.subscribe("zoom", "3");
    await until(() => s.connected);
    s.stop();
    await new Promise((r) => setTimeout(r, 60));
    expect(s.connected).toBe(false);
  });
});
