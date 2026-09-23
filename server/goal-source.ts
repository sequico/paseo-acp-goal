import type { GoalSource } from "../shared/goal-status";

/**
 * Where a goal comes from.
 *
 * An agent speaking ACP cannot be handed a system prompt — Paseo's ACP adapter
 * builds `session/new` from `cwd` and `mcpServers` only, and `systemPrompt` is
 * mapped by OMP alone. So there is no channel for telling an agent, in advance,
 * how to declare a goal. There are two channels instead:
 *
 *  - a **label** set by whoever launches the agent, which is authoritative; and
 *  - a **file** in the workspace, which is the agent declaring a goal for itself.
 *
 * The file is the point of the plugin: an agent that cannot be told to write a
 * goal can still choose to write one. It is also the obvious attack surface, so
 * once a label goal exists the file may no longer redefine the goal, the
 * verification command, or the ceiling — it may only report. Without that rule an
 * agent could quietly narrow its own goal and then "finish".
 */

export const GOAL_LABEL = "paseo-acp-goal";
export const GOAL_MAX_ROUNDS_LABEL = "paseo-acp-goal-max";
export const GOAL_VERIFY_LABEL = "paseo-acp-goal-verify";
export const GOAL_DONE_LABEL = "paseo-acp-goal-done";

/** Workspace-relative. Read from the agent's `cwd` at the end of each turn. */
export const GOAL_FILE = ".acp-goal.json";

export const DEFAULT_MAX_ROUNDS = 8;
export const DEFAULT_MAX_NO_PROGRESS_ROUNDS = 2;
export const DEFAULT_SENTINEL = "GOAL_COMPLETE";
export const MAX_ROUNDS_CEILING = 50;

export interface Goal {
  goal: string;
  verify: string | null;
  maxRounds: number;
  sentinel: string;
  maxTokens: number | null;
  source: GoalSource;
}

/** The subset a workspace file may declare. */
export interface GoalFile {
  goal?: string;
  verify?: string;
  maxRounds?: number;
  maxTokens?: number;
  done?: boolean;
  note?: string;
}

/** Two goals are the same goal when every launch parameter matches. */
export function sameGoal(left: Goal, right: Goal): boolean {
  return (
    left.goal === right.goal &&
    left.verify === right.verify &&
    left.maxRounds === right.maxRounds &&
    left.sentinel === right.sentinel &&
    left.maxTokens === right.maxTokens &&
    left.source === right.source
  );
}

function clampRounds(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_MAX_ROUNDS;
  }
  const rounded = Math.floor(value);
  if (rounded < 1) {
    return 1;
  }
  return Math.min(rounded, MAX_ROUNDS_CEILING);
}

function trimmed(value: string | undefined): string | null {
  const text = value?.trim();
  return text !== undefined && text.length > 0 ? text : null;
}

function positiveOrNull(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.floor(value);
}

export function goalFromLabels(labels: Record<string, string> | null | undefined): Goal | null {
  const goal = trimmed(labels?.[GOAL_LABEL]);
  if (goal === null) {
    return null;
  }

  const rounds = Number(labels?.[GOAL_MAX_ROUNDS_LABEL]);
  return {
    goal,
    verify: trimmed(labels?.[GOAL_VERIFY_LABEL]),
    maxRounds: Number.isFinite(rounds) && rounds > 0 ? clampRounds(rounds) : DEFAULT_MAX_ROUNDS,
    sentinel: trimmed(labels?.[GOAL_DONE_LABEL]) ?? DEFAULT_SENTINEL,
    maxTokens: null,
    source: "label",
  };
}

/**
 * Parse the workspace file. A malformed file is not an error worth surfacing: the
 * agent may be mid-write, and the next turn will read it again.
 */
export function parseGoalFile(raw: string): GoalFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const file: GoalFile = {};

  if (typeof record["goal"] === "string") {
    file.goal = record["goal"];
  }
  if (typeof record["verify"] === "string") {
    file.verify = record["verify"];
  }
  if (typeof record["maxRounds"] === "number") {
    file.maxRounds = clampRounds(record["maxRounds"]);
  }
  const maxTokens = positiveOrNull(
    typeof record["maxTokens"] === "number" ? record["maxTokens"] : undefined,
  );
  if (maxTokens !== null) {
    file.maxTokens = maxTokens;
  }
  if (record["done"] === true) {
    file.done = true;
  }
  if (typeof record["note"] === "string") {
    file.note = record["note"];
  }
  return file;
}

/**
 * Resolve the goal for a turn.
 *
 * A label wins on every launch parameter. The file only defines a goal when no
 * label did, which is what lets an unmanaged agent declare one for itself without
 * letting a managed agent redefine its own terms.
 */
export function resolveGoal(
  labels: Record<string, string> | null | undefined,
  file: GoalFile | null,
): Goal | null {
  const fromLabel = goalFromLabels(labels);
  if (fromLabel !== null) {
    return fromLabel;
  }

  const goal = trimmed(file?.goal);
  if (goal === null) {
    return null;
  }

  return {
    goal,
    verify: trimmed(file?.verify),
    maxRounds: file?.maxRounds ?? DEFAULT_MAX_ROUNDS,
    sentinel: DEFAULT_SENTINEL,
    maxTokens: file?.maxTokens ?? null,
    source: "file",
  };
}

/** True when the file reports the goal was met. */
export function fileDeclaresDone(file: GoalFile | null): boolean {
  return file?.done === true;
}
