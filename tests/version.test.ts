import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { PLUGIN_VERSION } from "../server/loop";

/**
 * The version has two homes, and this is what keeps them the same home.
 *
 * `package.json` is where a release is cut from; `PLUGIN_VERSION` is what the shipped
 * bundle reports, because the daemon evaluates the bundle with `globalThis.eval` —
 * no `import.meta.url`, no path to its own directory — so server code cannot read
 * `package.json` at runtime. The copy is therefore forced, and a forced copy is
 * exactly the thing that drifts: bumping one and not the other would ship a plugin
 * that reports the old version on every handshake, silently, forever.
 *
 * So the equality is asserted here rather than remembered. This file runs where
 * `package.json` exists, which the shipped bundle does not, and that is the whole
 * asymmetry being exploited.
 */

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("the plugin version", () => {
  it("is the same in the manifest and in the constant the bundle reports", () => {
    const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, "package.json"), "utf8")) as {
      version?: unknown;
    };

    assert.equal(
      PLUGIN_VERSION,
      manifest.version,
      "bump package.json and PLUGIN_VERSION together; the daemon cannot read one from the other",
    );
  });
});
