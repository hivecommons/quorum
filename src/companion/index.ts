import { readSecretFile, type Config } from "../config.js";
import { Transcriber } from "../discord/transcribe.js";
import type { Logger } from "../log.js";
import type { Metrics } from "../metrics.js";
import { CompanionAdapter } from "./adapter.js";

/**
 * The companion platform is always registered: it only listens on quorum's own loopback HTTP
 * surface. Without QUORUM_TRANSCRIBE_URL a companion join answers platform_unavailable.
 */
export function companionAdapter(config: Config, log: Logger, metrics?: Metrics): CompanionAdapter {
  const transcriber = config.transcribeUrl
    ? new Transcriber({
        url: config.transcribeUrl,
        token: () =>
          config.transcribeTokenFile
            ? readSecretFile(config.transcribeTokenFile, "QUORUM_TRANSCRIBE_TOKEN_FILE")
            : undefined,
        ...(config.transcribeLanguage ? { language: config.transcribeLanguage } : {}),
        timeoutMs: config.transcribeTimeoutMs,
        ...(metrics ? { metrics } : {}),
        hotwords: config.transcribeHotwords,
        retry: {
          maxAttempts: config.transcribeMaxAttempts,
          backoffBaseMs: config.transcribeBackoffBaseMs,
          backoffMaxMs: config.transcribeBackoffMaxMs,
        },
      })
    : undefined;
  return new CompanionAdapter({ config, log, transcriber });
}
