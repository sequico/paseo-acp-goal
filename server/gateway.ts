import type { GoalStatus } from "../shared/goal-status";

/**
 * What the loop needs from the outside world, stated in its own words.
 *
 * The loop never touches the Paseo SDK or the plugin hook types directly. It
 * declares the three operations it performs and the six facts it reads, and an
 * adapter in `paseo-gateway.ts` maps those onto the SDK. That keeps the whole
 * safety story testable against plain data instead of a fake framework, and it
 * means a change to the SDK's shape lands in one adapter rather than everywhere.
 */

export interface GoalAgentSnapshot {
  labels: Record<string, string>;
  cwd: string;
  /** Tokens the agent's own last turn reported. The loop accumulates them. */
  inputTokens: number;
  outputTokens: number;
  archived: boolean;
  pendingPermissions: number;
}

export interface GoalAgentGateway {
  snapshot(agentId: string): Promise<GoalAgentSnapshot | null>;
  /** Queues a prompt for the agent, resolving when the daemon accepts it. */
  send(agentId: string, text: string): Promise<void>;
  /** Replaces the agent's single status row in its transcript. */
  writeStatus(agentId: string, status: GoalStatus): Promise<void>;
}
