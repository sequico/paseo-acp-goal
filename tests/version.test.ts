import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { PLUGIN_VERSION } from "../server/loop";

/**
 * The version has three homes, and this is what keeps them the same home.
 *
 * `package.json` is where a release is cut from; `PLUGIN_VERSION` is what the shipped
 * bundle reports, because the daemon evaluates the bundle with `globalThis.eval` —
 * no `import.meta.url`, no path to its own directory — so server code cannot read
 * `package.json` at runtime; and `package-lock.json` mirrors the version in two fields
 * of its own. The copies are therefore forced, and forced copies are exactly what
 * drifts. The lockfile one drifts silently and for the longest: a version bumped by hand
 * in `package.json` leaves it behind, because `npm ci` compares the lockfile against the
 * manifests' dependencies and not against their version field.
 *
 * So the equality is asserted here rather than remembered. This file runs where those
 * manifests exist, which the shipped bundle does not, and that is the whole asymmetry
 * being exploited.
 */

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(PLUGIN_ROOT, name), "utf8")) as Record<string, unknown>;
}

describe("the plugin version", () => {
  it("is the same in the manifest and in the constant the bundle reports", () => {
    const manifest = readJson("package.json");

    assert.equal(
      PLUGIN_VERSION,
      manifest.version,
      "bump package.json and PLUGIN_VERSION together; the daemon cannot read one from the other",
    );
  });

  it("is mirrored by the lockfile, which nothing else keeps in step", () => {
    const manifest = readJson("package.json");
    const lock = readJson("package-lock.json");
    const packages = lock.packages as Record<string, { version?: unknown } | undefined>;

    assert.equal(
      lock.version,
      manifest.version,
      "run `npm install --package-lock-only` after a version bump",
    );
    assert.equal(
      packages[""]?.version,
      manifest.version,
      "the lockfile states the version twice; the root package entry is the second one",
    );
  });
});
