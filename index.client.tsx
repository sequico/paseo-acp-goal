import type { PluginClientContext } from "@getpaseo/plugin/client";
import { AcpGoalsSurface } from "./client/acp-goals";
import { GoalStatusCard } from "./client/goal-status";
import { GOAL_STATUS_KIND, GOAL_STATUS_VERSION, goalStatusSchema } from "./shared/goal-status";

/**
 * Two client contributions, for two different reasons.
 *
 * The **timeline renderer** exists because a daemon-appended plugin row is shown as
 * unavailable unless something claims its `kind`, so without it the loop's status row
 * would be a blank in every transcript.
 *
 * The **sidebar surface** is the ACP goals screen: the place a human sets and clears
 * goals, and sees which agents are being driven at all. The loop is complete without
 * it — labels and the workspace file both still work — but a plugin whose only input
 * is a command-line flag is a plugin most people will never turn on.
 */
export default function contribute(client: PluginClientContext) {
  const renderer = client.addTimelineRenderer({
    kind: GOAL_STATUS_KIND,
    version: GOAL_STATUS_VERSION,
    schema: goalStatusSchema,
    Component: GoalStatusCard,
  });

  const surface = client.addSurface("acp-goals", AcpGoalsSurface);
  const sidebarItem = client.addSidebarItem({
    id: "acp-goals",
    title: "ACP goals",
    icon: "Target",
    surface: "acp-goals",
  });
  const command = client.addCommandCenterItem({
    id: "open-acp-goals",
    title: "Open ACP goals",
    icon: "Target",
    context: "global",
    onSelect({ openSurface }) {
      openSurface("acp-goals");
    },
  });

  return () => {
    renderer();
    surface();
    sidebarItem();
    command();
  };
}
