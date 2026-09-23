import type { PluginServerContext } from "@getpaseo/plugin/server";
import { goalClear, goalOverview, goalSet } from "./shared/goal-admin";
import { registerGoalLoop } from "./server/loop";
import { pluginHost } from "./server/plugin-host";

export default function contribute(server: PluginServerContext) {
  const loop = registerGoalLoop(pluginHost(server));

  // The screen's three operations, each a straight pass-through to the loop's own
  // admin surface. `paseo` arrives with the handler because a plugin's server code
  // only ever receives a client inside a hook or handler context.
  server.handle(goalOverview, async (_input, { paseo }) => ({
    rows: await loop.admin.rows(paseo),
  }));
  server.handle(goalSet, async (input, { paseo }) => loop.admin.set(paseo, input.agentId, input));
  server.handle(goalClear, async (input) => loop.admin.clear(input.agentId));

  return loop.cleanup;
}
