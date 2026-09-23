import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { build } from "esbuild";
import { SERVER_EXTERNALS, wrapCommonJsBundle } from "./daemon-load-path";

/**
 * The daemon's load path, reproduced.
 *
 * Paseo compiles a plugin's server entry with esbuild into a CommonJS bundle, wraps
 * it in `(function(require) { const module = { exports: {} }; … return module.exports; })`,
 * and evaluates that with an indirect `globalThis.eval` inside the plugin process.
 * So the bundle runs with **no `import.meta`, no `__dirname`, no `require` of its
 * own, and a working directory outside the plugin checkout**. Anything at module
 * scope that reaches for those throws during load, and the daemon reports only
 * "Plugin failed to load" with the bare error.
 *
 * This plugin's central architectural decision rests on that fact: the goal tool is
 * served over a loopback HTTP listener rather than spawned from a helper script,
 * precisely because a bundled helper cannot be located from inside the bundle. This
 * test makes that a checked claim rather than a remembered one. The community
 * plugins carry the same test (`omercnet/paseo-agent-monitor`).
 */

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = join(PLUGIN_ROOT, "index.server.ts");
const nodeRequire = createRequire(import.meta.url);

interface CompiledBundle {
  code: string;
  warnings: string[];
}

async function compileServerBundle(): Promise<CompiledBundle> {
  const result = await build({
    stdin: {
      contents: readFileSync(SERVER_ENTRY, "utf8"),
      loader: "ts",
      resolveDir: dirname(SERVER_ENTRY),
      sourcefile: SERVER_ENTRY,
    },
    bundle: true,
    format: "cjs",
    // The daemon's server target: node20, node platform.
    platform: "node",
    target: "node20",
    external: [...SERVER_EXTERNALS],
    logLevel: "silent",
    treeShaking: true,
    write: false,
  });

  return {
    code: result.outputFiles?.[0]?.text ?? "",
    warnings: result.warnings.map((warning) => warning.text),
  };
}

describe("the server bundle", () => {
  it("compiles without a single warning", async () => {
    const { warnings } = await compileServerBundle();
    // The daemon compiles with logLevel "silent", so a warning here would be a
    // silent difference between what is developed and what actually runs.
    assert.deepEqual(warnings, []);
  });

  it("is CommonJS, the format the daemon evaluates", async () => {
    const { code } = await compileServerBundle();
    assert.ok(code.length > 0, "the bundle must not be empty");
    assert.match(code, /module\.exports|exports\./, "esbuild must emit a cjs module");
  });

  it("loads inside the daemon's eval sandbox and registers exactly its hooks", async () => {
    const { code } = await compileServerBundle();

    // The daemon's shape, byte for byte: wrapper, indirect eval, factory called with
    // a require that answers only the host modules it declares.
    const wrapped = wrapCommonJsBundle(code);
    const evaluate = (source: string): unknown => (0, eval)(source);
    const factory = evaluate(wrapped) as (require: (name: string) => unknown) => unknown;

    const requested: string[] = [];
    // Matches the daemon's own runtime require: the plugin SDK answers with a stub,
    // Node builtins resolve for real, and anything else is a load failure.
    const hostRequire = (name: string): unknown => {
      requested.push(name);
      if (name === "zod" || isBuiltin(name)) {
        // The real module, so a module-scope `z.object(...)` in shared/ runs for real.
        return nodeRequire(name);
      }
      if (name.startsWith("@getpaseo/plugin")) {
        // The host module the daemon injects. `defineRpc` is identity-shaped there, so
        // the contract a plugin declares is the object it gets back.
        return { defineRpc: (definition: unknown) => definition };
      }
      throw new Error(`the bundle required a module the host does not provide: ${name}`);
    };

    const exports = factory(hostRequire) as { default?: unknown };
    const contribute = exports.default;
    if (typeof contribute !== "function") {
      throw new Error("the entry must default-export contribute");
    }

    const hooks: string[] = [];
    const rpcs: string[] = [];
    const context = {
      handle: (contract: { name: string }) => {
        rpcs.push(contract.name);
      },
      registerProvider: () => {},
      registerSettings: () => {},
      on: (name: string) => {
        hooks.push(name);
        return () => {};
      },
      before: (name: string) => {
        hooks.push(name);
        return () => {};
      },
    };

    const cleanup: unknown = contribute(context);
    if (typeof cleanup !== "function") {
      throw new Error("contribute must return a cleanup function");
    }

    // Cleanup runs before any assertion, because it closes the listener the plugin
    // opened. An assertion that threw first would leak that listener and hang the
    // whole test process instead of failing one test.
    try {
      const result: unknown = cleanup();
      await Promise.resolve(result);
    } finally {
      assert.deepEqual(
        [...hooks].sort(),
        [
          "agent.archived",
          "agent.create",
          "agent.session_open",
          "agent.turn_ended",
          "agent.turn_started",
        ],
        "the plugin registers exactly the five hooks it declares, and no others",
      );
      assert.deepEqual(
        [...rpcs].sort(),
        ["goal.clear", "goal.overview", "goal.set"],
        "and exactly the three RPCs the ACP goals screen calls",
      );
    }
  });

  it("never reaches for import.meta or __dirname at module scope", async () => {
    const { code } = await compileServerBundle();
    // The eval sandbox has neither. esbuild would have failed the cjs build on an
    // `import.meta` use, but `__dirname` and `__filename` compile to bare
    // identifiers that only fail at load time, so they are checked explicitly.
    assert.doesNotMatch(code, /\b__dirname\b/);
    assert.doesNotMatch(code, /\b__filename\b/);
    assert.doesNotMatch(code, /\bimport\.meta\b/);
  });
});
