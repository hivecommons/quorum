// Smoke-tests the release bundle from a directory with no node_modules:
//   node scripts/smoke.mjs dist/quorum.mjs [--with-davey]
// Checks `version`, then `serve`: /healthz, bearer auth, MCP initialize and tools/list, and
// whether the Discord runtime loads (it needs @snazzah/davey next to the bundle).
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** The tools docs/contract.md lists: join, leave, status, transcript.read, chat.post, say, say.prewarm, delete. */
const EXPECTED_TOOLS = 8;
const bundle = resolve(process.argv[2] ?? "dist/quorum.mjs");
const withDavey = process.argv.includes("--with-davey");
const dir = mkdtempSync(join(tmpdir(), "quorum-smoke-"));
const bin = join(dir, "quorum.mjs");
copyFileSync(bundle, bin);
if (withDavey) {
  // Install exactly the DAVE version the lockfile pins, as the hive image does.
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const version = lock.packages?.["node_modules/@snazzah/davey"]?.version;
  if (!version) throw new Error("cannot find the @snazzah/davey version in package-lock.json");
  execFileSync(
    "npm",
    ["install", "--prefix", dir, "--no-save", "--no-package-lock", `@snazzah/davey@${version}`],
    {
      stdio: "inherit",
    },
  );
}

function fail(msg) {
  console.error(`smoke: FAIL ${msg}`);
  process.exit(1);
}

const version = execFileSync(process.execPath, [bin, "version"], {
  cwd: dir,
  encoding: "utf8",
}).trim();
if (!/^\d+\.\d+\.\d+/.test(version)) fail(`version printed ${JSON.stringify(version)}`);
console.log(`smoke: version ${version}`);

const token = "smoke-token-0123456789";
writeFileSync(join(dir, "token"), token);
writeFileSync(join(dir, "discord"), "not-a-real-discord-token");
const PORT = 18765 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, [bin, "serve"], {
  cwd: dir,
  env: {
    PATH: process.env.PATH,
    QUORUM_LISTEN: `127.0.0.1:${PORT}`,
    QUORUM_TOKEN_FILE: join(dir, "token"),
    QUORUM_DISCORD_TOKEN_FILE: join(dir, "discord"),
    QUORUM_TRANSCRIBE_URL: "http://127.0.0.1:9",
  },
  stdio: ["ignore", "inherit", "pipe"],
});
let logs = "";
child.stderr.on("data", (d) => (logs += d.toString()));
const base = `http://127.0.0.1:${PORT}`;

async function waitFor(pred, ms, what) {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) fail(`timed out waiting for ${what}\n${logs}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

try {
  await waitFor(
    () =>
      fetch(`${base}/healthz`).then(
        (r) => r.ok,
        () => false,
      ),
    15_000,
    "/healthz",
  );
  if ((await fetch(`${base}/mcp`, { method: "POST" })).status !== 401)
    fail("unauthenticated /mcp was not 401");
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const init = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke", version: "0" },
      },
    }),
  }).then((r) => r.json());
  if (init?.result?.serverInfo?.name !== "quorum") fail(`initialize: ${JSON.stringify(init)}`);
  const list = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  }).then((r) => r.json());
  const names = list?.result?.tools?.map((t) => t.name) ?? [];
  if (names.length !== EXPECTED_TOOLS) fail(`tools/list: ${JSON.stringify(names)}`);
  console.log(`smoke: MCP ok, tools ${names.join(", ")}`);
  const expected = withDavey ? "discord login failed" : "discord disabled";
  await waitFor(() => logs.includes(expected), 30_000, `log line "${expected}"`);
  console.log(
    `smoke: Discord runtime ${withDavey ? "loaded (login refused the fake token)" : "disabled without @snazzah/davey, as documented"}`,
  );
} finally {
  child.kill("SIGTERM");
}
console.log("smoke: PASS");
