import type { PluginClientContext } from "@getpaseo/plugin/client";
import { GoalStatusCard } from "./client/goal-status";
import { GOAL_STATUS_KIND, GOAL_STATUS_VERSION, goalStatusSchema } from "./shared/goal-status";

/**
 * The client entry exists for exactly one reason: a daemon-appended plugin row is
 * shown as unavailable unless something on the client claims its `kind`. There is
 * no other UI here on purpose — the loop is configured by labels and by the
 * workspace file, never by a panel.
 */
export default function contribute(client: PluginClientContext) {
  return client.addTimelineRenderer({
    kind: GOAL_STATUS_KIND,
    version: GOAL_STATUS_VERSION,
    schema: goalStatusSchema,
    Component: GoalStatusCard,
  });
}
