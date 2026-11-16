// Builds dist/quorum.mjs: one ESM file with every pure-JS dependency inlined, plus
// dist/quorum.mjs.sha256. Native and optional modules stay external and load at runtime
// through createRequire from the bundle's own directory (see README "Release bundle").
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const OUT = "dist/quorum.mjs";

/** Native or optional modules; each is loaded inside try/catch or only when Discord is enabled. */
const EXTERNAL = [
  "@discordjs/opus",
  "node-opus",
  "sodium-native",
  "sodium",
  "libsodium-wrappers",
  "@stablelib/xchacha20poly1305",
  "@noble/ciphers",
  "bufferutil",
  "utf-8-validate",
  "zlib-sync",
  "ffmpeg-static",
];

/**
 * @discordjs/voice's ESM build does `import Davey from "@snazzah/davey"`. Left external, that
 * static import would make the whole bundle fail to start where the native DAVE module is not
 * installed. This shim turns it into a require() that runs only when the Discord adapter loads
 * @discordjs/voice, so a missing module disables Discord instead of crashing quorum.
 */
const daveyShim = {
  name: "davey-shim",
  setup(b) {
    b.onResolve({ filter: /^@snazzah\/davey$/ }, (args) =>
      args.namespace === "davey-shim"
        ? { path: args.path, external: true }
        : { path: "davey", namespace: "davey-shim" },
    );
    b.onLoad({ filter: /.*/, namespace: "davey-shim" }, () => ({
      contents: 'const davey = require("@snazzah/davey"); export default davey;',
      loader: "js",
    }));
  },
};

await build({
  entryPoints: ["src/bin.ts"],
  outfile: OUT,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: EXTERNAL,
  plugins: [daveyShim],
  legalComments: "eof",
  logLevel: "warning",
  // CommonJS globals for inlined CJS code. opusscript's asm.js build (Opus decode and encode for
  // Discord) reads __dirname when it initialises under Node; without it, creating an encoder or
  // decoder throws a ReferenceError in the ESM bundle.
  banner: {
    js: [
      "import { createRequire as __quorumCreateRequire } from 'node:module';",
      "import { fileURLToPath as __quorumFileURLToPath } from 'node:url';",
      "import { dirname as __quorumDirname } from 'node:path';",
      "const require = __quorumCreateRequire(import.meta.url);",
      "const __filename = __quorumFileURLToPath(import.meta.url);",
      "const __dirname = __quorumDirname(__filename);",
    ].join(" "),
  },
});

const sha = createHash("sha256").update(readFileSync(OUT)).digest("hex");
writeFileSync(`${OUT}.sha256`, `${sha}  quorum.mjs\n`);
console.log(`${OUT} sha256 ${sha}`);
