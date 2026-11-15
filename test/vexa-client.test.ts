import { describe, expect, it } from "vitest";
import {
  VexaClient,
  VexaHttpError,
  botPath,
  codeForStatus,
  errorDetail,
  routeOf,
} from "../src/vexa/client.js";

function client(fetchImpl: typeof fetch, timeoutMs = 1000): VexaClient {
  return new VexaClient({ baseUrl: "http://vexa", apiKey: () => "k", timeoutMs, fetchImpl });
}

function reply(status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch {
  return (async () =>
    new Response(
      body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body),
      {
        status,
        headers,
      },
    )) as typeof fetch;
}

describe("VexaClient", () => {
  it("sends the API key and JSON body", async () => {
    let seen: RequestInit | undefined;
    let seenUrl = "";
    const c = client((async (url: string, init: RequestInit) => {
      seenUrl = url;
      seen = init;
      return new Response(JSON.stringify({ id: 1, status: "requested" }), { status: 201 });
    }) as unknown as typeof fetch);
    expect(c.baseUrl).toBe("http://vexa");
    const row = await c.createBot({ platform: "zoom", native_meeting_id: "123456789" });
    expect(row).toEqual({ id: 1, status: "requested" });
    expect(seenUrl).toBe("http://vexa/bots");
    expect((seen?.headers as Record<string, string>)["X-API-Key"]).toBe("k");
    expect(JSON.parse(String(seen?.body))).toEqual({
      platform: "zoom",
      native_meeting_id: "123456789",
    });
  });

  it.each([
    [400, "invalid_argument"],
    [422, "invalid_argument"],
    [401, "upstream_error"],
    [403, "upstream_error"],
    [404, "not_found"],
    [409, "upstream_error"],
    [429, "rate_limited"],
    [500, "upstream_error"],
    [503, "upstream_error"],
  ])("maps HTTP %i to %s", async (status, code) => {
    const c = client(reply(status, { detail: "nope" }, { "retry-after": "7" }));
    const err = (await c.stopBot("zoom", "1").catch((e: unknown) => e)) as VexaHttpError;
    expect(err).toBeInstanceOf(VexaHttpError);
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(err.detail).toBe("nope");
    if (status === 429) expect(err.message).toContain("retry after 7s");
    if (status === 401) expect(err.message).toMatch(/refused/);
    expect(err.message).not.toContain("/bots/zoom/1");
  });

  it("handles non-JSON, empty and array bodies", async () => {
    expect(await client(reply(200, "plain text")).listBots("zoom")).toEqual([]);
    expect(await client(reply(200, [{ id: 1, status: "active" }])).listBots("zoom")).toEqual([
      { id: 1, status: "active" },
    ]);
    expect(await client(reply(200, {})).listBots("zoom")).toEqual([]);
    expect(await client(reply(200, undefined)).postChat("zoom", "1", "x")).toEqual({});
    await client(reply(200, undefined)).speak("zoom", "1", "x");
    await client(reply(202, { status: "scheduled" })).deleteMeeting("zoom", "1");
    const err = (await client(reply(502, ""))
      .stopBot("zoom", "1")
      .catch((e: unknown) => e)) as VexaHttpError;
    expect(err.detail).toMatch(/Bad Gateway|HTTP 502/);
  });

  it("reports network failures and timeouts as upstream_error", async () => {
    const down = client((async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    await expect(down.listBots("zoom")).rejects.toMatchObject({
      code: "upstream_error",
      message: expect.stringMatching(/unreachable/),
    });
    const slow = client(
      ((_u: string, init: RequestInit) =>
        new Promise((_r, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error));
        })) as unknown as typeof fetch,
      20,
    );
    await expect(slow.listBots("zoom")).rejects.toMatchObject({
      message: expect.stringMatching(/timed out/),
    });
  });
});

describe("helpers", () => {
  it("extracts FastAPI details", () => {
    expect(errorDetail({ detail: "x" }, "f")).toBe("x");
    expect(errorDetail({ detail: [{ msg: "a" }, "b"] }, "f")).toBe("a; b");
    expect(errorDetail({ detail: { why: 1 } }, "f")).toBe('{"why":1}');
    expect(errorDetail("raw", "f")).toBe("raw");
    expect(errorDetail(undefined, "f")).toBe("f");
    expect(errorDetail({ detail: "y".repeat(500) }, "f").length).toBe(300);
  });

  it("builds paths and route templates", () => {
    expect(botPath("teams", "a/b")).toBe("/bots/teams/a%2Fb");
    expect(routeOf("/bots/zoom/123/chat")).toBe("/bots/{platform}/{native_id}/chat");
    expect(routeOf("/meetings/zoom/123")).toBe("/meetings/{platform}/{native_id}");
    expect(routeOf("/bots?platform=zoom")).toBe("/bots");
    expect(codeForStatus(418)).toBe("upstream_error");
  });
});
