import type { PluginHandlerContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";

/**
 * Types the host already owns, derived rather than imported.
 *
 * Paseo's compiler keeps only a fixed set of specifiers external: the
 * `@getpaseo/plugin*` family, `zod`, `react`, `react-native`,
 * `@tanstack/react-query`, and Node builtins. Anything else a plugin's source
 * imports has to be present for the daemon to resolve it, and from npm the daemon
 * installs with `--omit=dev` — so a devDependency import becomes a failed install
 * with "Could not resolve type dependency", which no typecheck, test, or
 * `npm pack` catches. (The list lives in Paseo at
 * `packages/server/src/server/plugins/plugin-sdk-specifiers.ts`.)
 *
 * `@getpaseo/client` and `@getpaseo/protocol` are not on that list, yet both are
 * where the SDK's own types live. So this module reads them out of the plugin SDK
 * that *is* injected, by indexed access. That keeps the source's imports inside
 * the allowlist and, just as importantly, keeps one definition of each type: the
 * host's.
 *
 * The packages stay in `devDependencies` so `tsc` can resolve the plugin SDK's own
 * declarations — a devDependency is invisible to the daemon's import walk because
 * nothing in this repository's source imports it.
 */

/** The SDK surface a plugin handler receives, which is the whole Paseo API. */
export type PaseoApi = PluginHandlerContext["paseo"];

/** One entry of an agent's transcript, as the daemon reports it. */
export type AgentTimelineItem = PluginLifecycleEvents["agent.turn_ended"]["timeline"][number];

/** The agent identity a lifecycle event carries. */
export type HookAgent = PluginLifecycleEvents["agent.turn_ended"]["agent"];
