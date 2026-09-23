import {
  GOAL_STATUS_KIND,
  GOAL_STATUS_ROW_ID,
  GOAL_STATUS_VERSION,
  type GoalStatus,
} from "../shared/goal-status";
import type { GoalAgentGateway, GoalAgentSnapshot } from "./gateway";
import type { AdminAgent } from "./goal-admin";
import type { PaseoApi } from "./host-types";

/**
 * The one place that knows the Paseo SDK's shape.
 *
 * `agents.ref(id).refresh()` returns a full agent payload whose fields the loop
 * does not need; this adapter narrows it to the six facts the loop reads, so a
 * change in the payload is a compile error here rather than a silent `undefined`
 * somewhere in the safety logic.
 */
export function paseoGateway(paseo: PaseoApi): GoalAgentGateway {
  return {
    async snapshot(agentId: string): Promise<GoalAgentSnapshot | null> {
      const result = await paseo.agents.ref(agentId).refresh();
      const agent = result?.agent;
      if (agent === undefined) {
        return null;
      }
      const usage = agent.lastUsage ?? null;
      return {
        labels: agent.labels,
        cwd: agent.cwd,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        archived: agent.archivedAt !== undefined && agent.archivedAt !== null,
        pendingPermissions: agent.pendingPermissions.length,
      };
    },

    async send(agentId: string, text: string): Promise<void> {
      await paseo.agents.ref(agentId).send(text);
    },

    async writeStatus(agentId: string, status: GoalStatus): Promise<void> {
      await paseo.agents.ref(agentId).timeline.append({
        type: "plugin",
        id: GOAL_STATUS_ROW_ID,
        kind: GOAL_STATUS_KIND,
        version: GOAL_STATUS_VERSION,
        data: status,
      });
    },
  };
}

/**
 * The agent roster, one page, for the ACP goals screen.
 *
 * This lives in the adapter because it is SDK knowledge, like everything else here.
 * The list payload already carries the labels, so eligibility is answerable without
 * the per-agent refresh the turn path needs.
 */
export async function listAdminAgents(paseo: PaseoApi): Promise<AdminAgent[]> {
  // Default scope excludes archived agents, which is what the screen wants: an
  // archived agent has no loop left to show.
  const { entries } = await paseo.agents.list();
  return entries.map(({ agent }) => ({
    agentId: agent.id,
    title: agent.title,
    provider: agent.provider,
    status: agent.status,
    labels: agent.labels,
    archived: agent.archivedAt !== undefined && agent.archivedAt !== null,
  }));
}
