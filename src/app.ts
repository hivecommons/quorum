import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { PlatformAdapter } from "./adapter.js";
import { readSecretFile, type Config } from "./config.js";
import { createHttpServer } from "./http.js";
import type { Logger } from "./log.js";
import { Metrics } from "./metrics.js";
import { Registry, type Platform } from "./meeting.js";
import { Quorum } from "./service.js";
import { companionAdapter } from "./companion/index.js";
import { VexaAdapter } from "./vexa/adapter.js";
import { VexaClient } from "./vexa/client.js";
import { VexaStream } from "./vexa/stream.js";

const MS_PER_S = 1000;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
/** How often terminal meetings past QUORUM_MEETING_RETENTION_S are forgotten. */
const SWEEP_INTERVAL_MS = 60_000;

export interface RunningQuorum {
  server: Server;
  url: string;
  quorum: Quorum;
  close(): Promise<void>;
}

/** Extra platform adapters (Discord) are wired in by the caller so they stay optional. */
export type AdapterFactory = (ctx: {
  config: Config;
  registry: Registry;
  log: Logger;
  metrics?: Metrics;
}) => Promise<
  Partial<
    Record<Platform, PlatformAdapter & { close?: () => Promise<void>; connected?: () => boolean }>
  >
>;

export async function startQuorum(
  config: Config,
  log: Logger,
  extraAdapters?: AdapterFactory,
): Promise<RunningQuorum> {
  const token = readSecretFile(config.tokenFile, "QUORUM_TOKEN_FILE");
  if (!LOOPBACK.has(config.host)) {
    log.warn(
      "QUORUM_LISTEN is not a loopback address; quorum is meant to listen on loopback only",
      {
        host: config.host,
      },
    );
  }
  const metrics = new Metrics();
  const registry = new Registry(config.meetingRetentionS * MS_PER_S);
  const adapters: Partial<Record<Platform, PlatformAdapter & { close?: () => Promise<void> }>> = {};
  let stream: VexaStream | undefined;

  if (config.vexaUrl) {
    const apiKey = (): string => readSecretFile(config.vexaApiKeyFile, "QUORUM_VEXA_API_KEY_FILE");
    const client = new VexaClient({
      baseUrl: config.vexaUrl,
      apiKey,
      timeoutMs: config.vexaTimeoutMs,
      metrics,
    });
    stream = new VexaStream({
      baseUrl: config.vexaUrl,
      apiKey,
      backoffMinMs: config.wsBackoffMinMs,
      backoffMaxMs: config.wsBackoffMaxMs,
      log,
    });
    const vexa = new VexaAdapter({
      client,
      stream,
      registry,
      log,
      lobbyTimeoutS: config.lobbyTimeoutS,
      echoWindowS: config.echoWindowS,
      chatConfirmTimeoutMs: config.chatConfirmTimeoutMs,
      chatConfirmPollMs: config.chatConfirmPollMs,
      sayConfirmTimeoutMs: config.sayConfirmTimeoutMs,
      sayPollMs: config.sayPollMs,
      leaveDrainTimeoutMs: config.leaveDrainTimeoutMs,
    });
    adapters.google_meet = vexa;
    adapters.teams = vexa;
    adapters.zoom = vexa;
    // The gateway socket only exists while a meeting is followed, so idle counts as connected.
    const followed = stream;
    metrics.adapter("vexa", () => followed.connected || followed.subscriptions === 0);
  } else {
    log.info("QUORUM_VEXA_URL is unset: Meet, Teams and Zoom answer platform_unavailable");
  }
  const companion = companionAdapter(config, log, metrics);
  adapters.companion = companion;
  metrics.adapter("companion", () => companion.connected());
  if (extraAdapters) {
    const extra = await extraAdapters({ config, registry, log, metrics });
    Object.assign(adapters, extra);
    const discord = extra.discord;
    if (discord?.connected) {
      metrics.adapter("discord", () => discord.connected?.() ?? false);
    }
  }

  const quorum = new Quorum({ config, registry, adapters, log });
  const server = createHttpServer({ quorum, config, log, token, companion, metrics });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  const host = addr.family === "IPv6" ? `[${addr.address}]` : addr.address;
  const url = `http://${host}:${addr.port}`;
  const sweeper = setInterval(() => registry.sweep(), SWEEP_INTERVAL_MS);
  sweeper.unref();
  log.info("quorum listening", { url, platforms: Object.keys(adapters) });

  return {
    server,
    url,
    quorum,
    async close() {
      clearInterval(sweeper);
      stream?.stop();
      const unique = new Set(Object.values(adapters));
      await Promise.all([...unique].map((a) => a?.close?.()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
