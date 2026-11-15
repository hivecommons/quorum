import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTRACT_VERSION, VERSION } from "../src/version.js";

describe("version", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });

  it("names the contract it implements", () => {
    const contract = readFileSync(new URL("../docs/contract.md", import.meta.url), "utf8");
    expect(contract).toContain(CONTRACT_VERSION);
  });
});
