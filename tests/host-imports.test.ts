import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  CLIENT_EXTERNALS,
  CLIENT_ONLY_SDK_SPECIFIERS,
  CLIENT_PACKAGE_PREFIXES,
  SERVER_EXTERNALS,
  SERVER_ONLY_SDK_SPECIFIERS,
} from "./daemon-load-path";

/**
 * The check that would otherwise first fail at install time, plus the boundary.
 *
 * Two things are verified here that nothing else in the repository can see.
 *
 * **Installability.** The daemon compiles a plugin from whatever is on disk and
 * resolves every import reachable from an entry point — type-only imports included —
 * failing the *install* when one cannot be resolved. What is on disk depends on how
 * the plugin was installed: from a directory or Git the devDependencies are present,
 * but from npm the daemon installs with `--omit=dev`, so a devDependency is simply
 * absent. No typecheck, test, or `npm pack` catches that, because all of them run
 * where the devDependencies exist. So every reachable specifier must be one of the
 * three things the daemon leaves behind: a host-injected module, a Node builtin in
 * server code, or a real runtime dependency. This plugin has no runtime
 * dependencies at all, which is why `server/host-types.ts` exists.
 *
 * **The boundary.** The daemon refuses a client import of server code, a server
 * import of client code, and a Node builtin reachable from client code. This plugin
 * declares that boundary as law in `AGENTS.md`; here it is checked.
 *
 * The specifier sets come from `./daemon-load-path.ts`, transcribed from Paseo's
 * compiler. The community plugins carry the installability half of this test
 * (`gpambrozio/paseo-plugins`, after shipping broken releases through the gap).
 */

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SERVER_ENTRY_NAMES = ["index.server.ts", "index.server.tsx"];
const CLIENT_ENTRY_NAMES = ["index.client.ts", "index.client.tsx"];

const IMPORT_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
}

function specifiersIn(file: string): string[] {
  const source = stripComments(readFileSync(file, "utf8"));
  const found: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) {
        found.push(match[1]);
      }
    }
  }
  return found;
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** The first candidate that exists on disk, or null. Used by both entry lookup and resolution. */
function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (isFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** The `./x` specifier in a dozen spellings, including a directory's `index` file. */
function relativeCandidates(fromFile: string, specifier: string): string[] {
  const base = resolve(dirname(fromFile), specifier);
  return [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
}

function existingEntry(names: string[]): string | null {
  return firstExisting(names.map((name) => join(PLUGIN_ROOT, name)));
}

/**
 * A module's own specifiers, and everything it reaches through relative imports.
 * Bare specifiers are collected as-is; resolving them is not this test's job, and a
 * pretence of resolution would only hide a package that is genuinely missing.
 */
function walk(entry: string): { files: Set<string>; bare: Map<string, string> } {
  const files = new Set<string>();
  const bare = new Map<string, string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) {
      continue;
    }
    files.add(file);

    for (const specifier of specifiersIn(file)) {
      if (!specifier.startsWith(".")) {
        bare.set(specifier, file);
        continue;
      }
      const resolved = firstExisting(relativeCandidates(file, specifier));
      if (resolved !== null) {
        queue.push(resolved);
      }
    }
  }

  return { files, bare };
}

function isHostSdk(specifier: string, externals: readonly string[]): boolean {
  return externals.includes(specifier);
}

/**
 * The files that name a package the host does not inject.
 *
 * `server/host-types.ts` is allowed to name one — that is its entire job — and
 * nothing else may, or the derivation has been duplicated back into a second place.
 */
function filesNamingANonInjectedPackage(files: Iterable<string>): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const name = relative(PLUGIN_ROOT, file);
    if (name === "server/host-types.ts") {
      continue;
    }
    if (/@getpaseo\/(client|protocol)/.test(stripComments(readFileSync(file, "utf8")))) {
      offenders.push(name);
    }
  }
  return offenders;
}

function matchesPrefix(specifier: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`));
}

const serverEntry = existingEntry(SERVER_ENTRY_NAMES);
const clientEntry = existingEntry(CLIENT_ENTRY_NAMES);

describe("entry points", () => {
  it("has both a server and a client entry", () => {
    assert.ok(serverEntry, "the plugin needs index.server.ts");
    assert.ok(clientEntry, "the plugin needs index.client.tsx for its timeline renderer");
  });
});

describe("installability", () => {
  it("keeps every server-reachable specifier installable without devDependencies", () => {
    assert.ok(serverEntry);
    const { bare } = walk(serverEntry);
    const violations: string[] = [];

    for (const [specifier, importer] of bare) {
      if (isBuiltin(specifier) || isHostSdk(specifier, SERVER_EXTERNALS)) {
        continue;
      }
      violations.push(`${relative(PLUGIN_ROOT, importer)} imports "${specifier}"`);
    }

    assert.deepEqual(
      violations,
      [],
      `These would fail a daemon install with "Could not resolve type dependency". ` +
        `Derive the type in server/host-types.ts, use a host specifier, or declare a real ` +
        `runtime dependency:\n${violations.join("\n")}`,
    );
  });

  it("keeps every client-reachable specifier installable without devDependencies", () => {
    assert.ok(clientEntry);
    const { bare } = walk(clientEntry);
    const violations: string[] = [];

    for (const [specifier, importer] of bare) {
      if (
        isHostSdk(specifier, CLIENT_EXTERNALS) ||
        matchesPrefix(specifier, CLIENT_PACKAGE_PREFIXES)
      ) {
        continue;
      }
      violations.push(`${relative(PLUGIN_ROOT, importer)} imports "${specifier}"`);
    }

    assert.deepEqual(violations, [], `client bundle cannot resolve:\n${violations.join("\n")}`);
  });
});

describe("the client and server boundary", () => {
  it("keeps client code out of the server graph and vice versa", () => {
    assert.ok(serverEntry);
    assert.ok(clientEntry);
    const server = walk(serverEntry);
    const client = walk(clientEntry);

    const shared = [...server.files].filter((file) => client.files.has(file));
    const outsideShared = shared.filter(
      (file) => !relative(PLUGIN_ROOT, file).startsWith("shared/"),
    );

    assert.deepEqual(
      outsideShared.map((file) => relative(PLUGIN_ROOT, file)),
      [],
      "the only modules both runtimes may reach are the ones in shared/",
    );
    assert.ok(
      shared.some((file) => relative(PLUGIN_ROOT, file).startsWith("shared/")),
      "the two runtimes are expected to share at least the status contract",
    );
  });

  it("keeps Node builtins out of the client graph", () => {
    assert.ok(clientEntry);
    const { bare } = walk(clientEntry);
    const offenders = [...bare]
      .filter(([specifier]) => specifier.startsWith("node:") || isBuiltin(specifier))
      .map(([specifier, importer]) => `${relative(PLUGIN_ROOT, importer)} imports "${specifier}"`);

    assert.deepEqual(offenders, [], "client code runs in the app, which has no Node builtins");
  });

  it("keeps client-only SDK specifiers out of the server graph", () => {
    assert.ok(serverEntry);
    const { bare } = walk(serverEntry);
    const offenders = [...bare]
      .filter(([specifier]) =>
        (CLIENT_ONLY_SDK_SPECIFIERS as readonly string[]).includes(specifier),
      )
      .map(([specifier, importer]) => `${relative(PLUGIN_ROOT, importer)} imports "${specifier}"`);

    assert.deepEqual(offenders, [], "the daemon bundle has no UI runtime");
  });

  it("keeps server-only SDK specifiers out of the client graph", () => {
    assert.ok(clientEntry);
    const { bare } = walk(clientEntry);
    const offenders = [...bare]
      .filter(([specifier]) =>
        (SERVER_ONLY_SDK_SPECIFIERS as readonly string[]).includes(specifier),
      )
      .map(([specifier, importer]) => `${relative(PLUGIN_ROOT, importer)} imports "${specifier}"`);

    assert.deepEqual(offenders, [], "the app bundle cannot reach the daemon SDK");
  });
});

describe("single source of truth for host types", () => {
  it("names a non-injected package in host-types.ts and nowhere else", () => {
    assert.ok(serverEntry);
    assert.deepEqual(
      filesNamingANonInjectedPackage(walk(serverEntry).files),
      [],
      "derive the type from server/host-types.ts instead",
    );
  });
});
