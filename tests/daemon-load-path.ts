/**
 * The build the daemon performs, transcribed.
 *
 * Both of this repository's fidelity tests need the same two facts — which
 * specifiers stay external, and how the bundle is wrapped before being evaluated —
 * so they live here once rather than in each test. The values are copied from
 * Paseo's `packages/server/src/server/plugins/{plugin-sdk-specifiers,compiler}.ts`;
 * a plugin cannot depend on Paseo's server package, so a copy is the only option,
 * and this file is where a drift in Paseo's compiler would first become visible.
 */

/** Supplied by the host and left external in an author bundle. */
export const PLUGIN_SDK_SPECIFIERS = [
  "@getpaseo/plugin",
  "@getpaseo/plugin/server",
  "@getpaseo/plugin/server/provider",
  "@getpaseo/plugin/server/acp",
  "@getpaseo/plugin/client",
  "@getpaseo/plugin/client/ui",
  "@getpaseo/plugin/client/react-native",
] as const;

/** SDK specifiers that only make sense in the app bundle. */
export const CLIENT_ONLY_SDK_SPECIFIERS = [
  "@getpaseo/plugin/client",
  "@getpaseo/plugin/client/ui",
  "@getpaseo/plugin/client/react-native",
] as const;

/** SDK specifiers that only make sense in the daemon bundle. */
export const SERVER_ONLY_SDK_SPECIFIERS = [
  "@getpaseo/plugin/server",
  "@getpaseo/plugin/server/provider",
  "@getpaseo/plugin/server/acp",
] as const;

/**
 * The server target's externals. Deliberately *not* including react, react-native,
 * or react-query: the daemon bundles those only for the client target, and reaching
 * for one from server code is a compile error rather than a host module.
 */
export const SERVER_EXTERNALS = [...PLUGIN_SDK_SPECIFIERS, "zod"] as const;

/** The client target's externals, including the UI runtime. */
export const CLIENT_EXTERNALS = [
  ...PLUGIN_SDK_SPECIFIERS,
  "@tanstack/react-query",
  "react",
  "react/jsx-runtime",
  "react-native",
  "zod",
] as const;

/** Packages the daemon resolves from its own node_modules, matched by prefix. */
export const CLIENT_PACKAGE_PREFIXES = [
  "@tanstack/react-query",
  "react",
  "react-native",
  "zod",
] as const;

/**
 * The wrapper the daemon puts around an esbuild CommonJS bundle before evaluating
 * it. Reproduced exactly, including the local `module`/`exports` that make a bare
 * `module.exports` valid inside an eval with nothing else in scope.
 */
export function wrapCommonJsBundle(code: string): string {
  return `(function(require) {\nconst module = { exports: {} };\nconst exports = module.exports;\n${code}\nreturn module.exports;\n})`;
}
