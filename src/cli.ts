import { loadConfig } from "./config.js";
import { createLogger, parseLevel, type Logger } from "./log.js";
import { startQuorum, type AdapterFactory, type RunningQuorum } from "./app.js";
import { CONTRACT_VERSION, VERSION } from "./version.js";
import { discordAdapters } from "./discord/index.js";

const USAGE = `quorum ${VERSION} (${CONTRACT_VERSION})

Usage:
  quorum serve      Run the MCP server (configuration from QUORUM_* env vars; see README)
  quorum version    Print the version
  quorum help       Show this help
`;

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
  env: Record<string, string | undefined>;
  logger?: Logger;
  adapters?: AdapterFactory;
}

/** Returns an exit code, or a running server for `serve`. */
export async function main(argv: string[], io: CliIo): Promise<number | RunningQuorum> {
  const cmd = argv[0] ?? "help";
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    io.out(`${VERSION}\n`);
    return 0;
  }
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    io.out(USAGE);
    return 0;
  }
  if (cmd !== "serve") {
    io.err(`unknown command: ${cmd}\n\n${USAGE}`);
    return 2;
  }
  let config;
  try {
    config = loadConfig(io.env);
  } catch (err) {
    io.err(`quorum: ${(err as Error).message}\n`);
    return 2;
  }
  const log = io.logger ?? createLogger(parseLevel(config.logLevel));
  try {
    return await startQuorum(config, log, io.adapters ?? discordAdapters());
  } catch (err) {
    io.err(`quorum: ${(err as Error).message}\n`);
    return 1;
  }
}
