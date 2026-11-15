import type { AdapterFactory } from "../app.js";
import { readSecretFile } from "../config.js";
import { DiscordAdapter } from "./adapter.js";
import { loadDiscordRuntime } from "./runtime.js";
import { Transcriber } from "./transcribe.js";
import type { DiscordRuntime } from "./types.js";

/**
 * Wires the Discord adapter when QUORUM_DISCORD_TOKEN_FILE is set. Login runs in the background;
 * until the gateway is ready (or if login fails) Discord tools answer platform_unavailable.
 */
export function discordAdapters(
  load: () => Promise<DiscordRuntime> = loadDiscordRuntime,
): AdapterFactory {
  return async ({ config, registry, log }) => {
    if (!config.discordTokenFile) {
      return {};
    }
    let token: string;
    let runtime: DiscordRuntime;
    try {
      token = readSecretFile(config.discordTokenFile, "QUORUM_DISCORD_TOKEN_FILE");
      runtime = await load();
    } catch (err) {
      log.error("discord disabled", { error: (err as Error).message });
      return {};
    }
    const transcriber = config.transcribeUrl
      ? new Transcriber({
          url: config.transcribeUrl,
          token: () =>
            config.transcribeTokenFile
              ? readSecretFile(config.transcribeTokenFile, "QUORUM_TRANSCRIBE_TOKEN_FILE")
              : undefined,
          ...(config.transcribeLanguage ? { language: config.transcribeLanguage } : {}),
          timeoutMs: config.transcribeTimeoutMs,
        })
      : undefined;
    const adapter = new DiscordAdapter({ runtime, registry, log, config, transcriber });
    adapter.start(token).catch((err: unknown) => {
      log.error("discord login failed; Discord tools answer platform_unavailable", {
        error: (err as Error).message,
      });
    });
    return { discord: adapter };
  };
}
