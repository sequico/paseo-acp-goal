import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerGoalLoop } from "./server/loop";
import { pluginHost } from "./server/plugin-host";

export default function contribute(server: PluginServerContext) {
  return registerGoalLoop(pluginHost(server)).cleanup;
}
