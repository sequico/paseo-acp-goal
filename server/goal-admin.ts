import type { GoalRow } from "../shared/goal-admin";
import { resolveGoal, type Goal } from "./goal-source";
import type { LoopRecord } from "./store";

/**
 * The ACP goals screen's view of the world, built as a pure function.
 *
 * The screen asks one question — "what is going on, and what can I act on?" — so the
 * answer is computed here from data and has no I/O of its own, which is what makes it
 * testable without a daemon. What it must not do is decide anything: eligibility,
 * precedence, and whether a row is editable are all facts owned elsewhere and passed
 * in.
 */

/** An agent as the roster reports it. The subset the screen needs. */
export interface AdminAgent {
  agentId: string;
  title: string | null;
  provider: string;
  status: string;
  labels: Record<string, string>;
  archived: boolean;
}

export interface GoalRowsInput {
  agents: readonly AdminAgent[];
  /** The loop's live accounting, when an agent has a loop in flight. */
  loops: ReadonlyMap<string, LoopRecord>;
  /** Goals whose loop has already ended, kept so the screen can say how. */
  completedLoops: ReadonlyMap<string, LoopRecord>;
  /** Goals a human set from this screen. */
  uiGoals: ReadonlyMap<string, Goal>;
  /** True when the loop would watch this agent once it has a goal. */
  isEligible: (provider: string, labels: Record<string, string>) => boolean;
}

interface AgentContext {
  record: LoopRecord | undefined;
}

/**
 * The goal a row should show.
 *
 * Resolved by the loop's own precedence function rather than by a second copy of those
 * rules. The file channel is `null` here because a screen in the app cannot read an
 * agent's working directory — and it does not need to: a file-declared goal only exists
 * once the loop has acted on it, which is the record already at hand.
 */
function rowGoal(
  input: GoalRowsInput,
  agent: AdminAgent,
  record: LoopRecord | undefined,
): Goal | null {
  return (
    resolveGoal(agent.labels, input.uiGoals.get(agent.agentId) ?? null, null) ??
    record?.goal ??
    null
  );
}

/**
 * What the row says is happening.
 *
 * A live loop is running; a record whose outcome is decided reports that outcome. A goal
 * with neither has not been acted on yet, and reads as running because the next turn is
 * what will move it.
 */
function rowState(record: LoopRecord | undefined, hasGoal: boolean): GoalRow["state"] {
  if (record?.lastOutcome !== undefined && record.lastOutcome !== null) {
    return record.lastOutcome.state;
  }
  return hasGoal ? "running" : null;
}

/**
 * One row, or null when the agent is not worth showing.
 *
 * `editable` is false exactly when a launch label owns the goal. The screen must not
 * offer to clear something the plugin cannot clear, and a label is not its to remove.
 */
function buildRow(agent: AdminAgent, input: GoalRowsInput, context: AgentContext): GoalRow | null {
  const goal = rowGoal(input, agent, context.record);

  const eligible = input.isEligible(agent.provider, agent.labels);
  if (!eligible && goal === null) {
    // On a busy daemon, listing every agent would bury the ones this screen exists for.
    return null;
  }

  return {
    agentId: agent.agentId,
    title: agent.title,
    provider: agent.provider,
    status: agent.status,
    eligible,
    goal: goal?.goal ?? null,
    source: goal?.source ?? null,
    round: context.record?.round ?? 0,
    maxRounds: goal?.maxRounds ?? 1,
    state: rowState(context.record, goal !== null),
    reason: context.record?.lastOutcome?.reason ?? null,
    verify: goal?.verify ?? null,
    editable: goal?.source !== "label",
  };
}

export function buildGoalRows(input: GoalRowsInput): GoalRow[] {
  const rows: GoalRow[] = [];

  for (const agent of input.agents) {
    const row = buildRow(agent, input, {
      // A live loop is what the screen most wants to show; a completed one is what it
      // last did; a UI goal is an instruction with no run yet.
      record:
        input.loops.get(agent.agentId) ?? input.completedLoops.get(agent.agentId) ?? undefined,
    });
    if (row !== null) {
      rows.push(row);
    }
  }

  // Rows with a goal first, then by title, so the screen opens on what is actionable
  // rather than on whatever order the roster happened to return.
  return rows.sort((left, right) => {
    const leftHas = left.goal === null ? 1 : 0;
    const rightHas = right.goal === null ? 1 : 0;
    if (leftHas !== rightHas) {
      return leftHas - rightHas;
    }
    return (left.title ?? left.agentId).localeCompare(right.title ?? right.agentId);
  });
}
