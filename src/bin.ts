#!/usr/bin/env node
import { main } from "./cli.js";

const result = await main(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  env: process.env,
});
if (typeof result === "number") {
  process.exitCode = result;
} else {
  const shutdown = (): void => {
    void result.close().then(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
