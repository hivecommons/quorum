import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startQuorum, type AdapterFactory, type RunningQuorum } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { silentLogger } from "../../src/log.js";

export const TOKEN = "quorum-test-bearer-token";

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "quorum-test-"));
}

export function writeSecret(dir: string, name: string, value: string): string {
  const p = join(dir, name);
  writeFileSync(p, value + "\n");
  return p;
}

export interface Harness {
  q: RunningQuorum;
  call(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  raw: Client;
  close(): Promise<void>;
}

export async function startHarness(
  env: Record<string, string | undefined>,
  adapters?: AdapterFactory,
): Promise<Harness> {
  const dir = tempDir();
  const config = loadConfig({
    QUORUM_LISTEN: "127.0.0.1:0",
    QUORUM_TOKEN_FILE: writeSecret(dir, "token", TOKEN),
    ...env,
  });
  const q = await startQuorum(config, silentLogger, adapters);
  const client = new Client({ name: "test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(q.url + "/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  await client.connect(transport);
  return {
    q,
    raw: client,
    async call(name, args = {}) {
      const res = await client.callTool({ name, arguments: args });
      return res.structuredContent as Record<string, unknown>;
    },
    async close() {
      await client.close();
      await q.close();
    },
  };
}

export interface SseReader {
  events: Record<string, unknown>[];
  raw: string[];
  status: number;
  close(): void;
  waitFor(pred: (events: Record<string, unknown>[]) => boolean, timeoutMs?: number): Promise<void>;
}

export async function openSse(url: string, token = TOKEN): Promise<SseReader> {
  const ac = new AbortController();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: ac.signal,
  });
  const reader: SseReader = {
    events: [],
    raw: [],
    status: res.status,
    close: () => ac.abort(),
    async waitFor(pred, timeoutMs = 3000) {
      const start = Date.now();
      while (!pred(reader.events)) {
        if (Date.now() - start > timeoutMs)
          throw new Error("timed out waiting for SSE events: " + JSON.stringify(reader.events));
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
  if (res.status !== 200 || !res.body) {
    return reader;
  }
  void (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          reader.raw.push(block);
          for (const line of block.split("\n")) {
            if (line.startsWith("data: "))
              reader.events.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
          }
        }
      }
    } catch {
      // aborted
    }
  })();
  return reader;
}

export async function until(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
