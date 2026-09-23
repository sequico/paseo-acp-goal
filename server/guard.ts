/**
 * The whole safety story of this plugin lives in `decide`.
 *
 * It is a pure function of one turn's evidence and the loop's accounting, so
 * every way a loop can run away is a unit test rather than a hope. The
 * orchestration in `loop.ts` observes and executes; it never decides.
 */

/** The two things the goal tool can report. Defined here, imported by the server that serves it. */
export type ToolSignalKind = "complete" | "blocked";

export interface ToolSignal {
  kind: ToolSignalKind;
  /** The tool's own text: a completion summary, or a blockage reason. */
  detail: string | null;
}

export type StopReason =
  | "agent-archived"
  | "canceled"
  | "tool-blocked"
  | "tool-complete"
  | "verify-passed"
  | "sentinel"
  | "failed"
  | "permission-pending"
  | "empty-turn"
  | "question"
  | "max-rounds"
  | "token-budget"
  | "no-progress";

export interface GuardSignals {
  outcome: "completed" | "failed" | "canceled";
  /** Set when the turn was canceled, for the report. */
  cancelReason: string | null;
  /** Set when the turn failed, for the report. */
  failureMessage: string | null;
  /** The agent was archived while this turn was in flight. */
  archived: boolean;
  /** A permission or question request is waiting on a human right now. */
  permissionPending: boolean;
  /** `null` when no verification command is configured, which is what lets a claim decide. */
  verifyPassed: boolean | null;
  /** The completion sentinel or the workspace file's `done` flag was found. */
  goalDeclaredMet: boolean;
  /** What the goal tool reported, attributed to this agent. */
  toolSignal: ToolSignal | null;
  /** The turn's last line is a question. */
  endsWithQuestion: boolean;
  /** The turn produced any text or tool call at all. */
  producedOutput: boolean;
}

export interface GuardLimits {
  /** Ceiling on nudges sent to one agent for one goal. */
  maxRounds: number;
  /** Ceiling on cumulative tokens for the whole loop, or null for no ceiling. */
  maxTokens: number | null;
  /** Consecutive no-progress turns tolerated before the loop gives up. */
  maxNoProgressRounds: number;
}

export interface GuardInput {
  /** Nudges already sent. Round 1 is the first nudge. */
  round: number;
  /** Consecutive no-progress turns, including the turn being judged. */
  noProgressStreak: number;
  /** Cumulative tokens for this loop, including the turn being judged. */
  tokensUsed: number;
  signals: GuardSignals;
  limits: GuardLimits;
}

export type GuardDecision =
  | { action: "continue"; nextRound: number }
  | { action: "stop"; reason: StopReason; detail: string | null };

/**
 * Why this order and not another.
 *
 * Cancellation and archival outrank everything: the loop never argues with a person
 * who took the wheel. A blockage always stops, because a blockage is by definition a
 * human decision. The runaway guards come last, with the round ceiling before the
 * stall guard so a loop that hit both reports the ceiling — both are true, and the
 * ordering is stated here rather than left to chance.
 *
 * The subtle part is how an objective criterion relates to a claim. **A configured
 * verification command cannot be overridden in either direction**: when it passes,
 * the goal is met whatever the agent said; when it fails, the goal is not met
 * whatever the agent said. That is why the claim routes below require
 * `verifyPassed === null`, which is the documented way of saying "no verification
 * command is configured". An agent that could declare victory over a failing test
 * would make the verification decorative.
 */
export function decide(input: GuardInput): GuardDecision {
  const { signals, limits, tokensUsed } = input;

  if (signals.archived) {
    return stop("agent-archived");
  }
  if (signals.outcome === "canceled") {
    return stop("canceled", signals.cancelReason);
  }

  if (signals.toolSignal?.kind === "blocked") {
    return stop("tool-blocked", signals.toolSignal.detail);
  }
  if (signals.verifyPassed === true) {
    return stop("verify-passed");
  }

  const verified = signals.verifyPassed !== null;
  if (!verified && signals.toolSignal?.kind === "complete") {
    return stop("tool-complete", signals.toolSignal.detail);
  }
  if (!verified && signals.goalDeclaredMet) {
    return stop("sentinel");
  }

  if (signals.outcome === "failed") {
    return stop("failed", signals.failureMessage);
  }
  if (signals.permissionPending) {
    return stop("permission-pending");
  }
  if (!signals.producedOutput) {
    return stop("empty-turn");
  }
  if (signals.endsWithQuestion) {
    return stop("question");
  }

  const nextRound = input.round + 1;
  if (nextRound > limits.maxRounds) {
    return stop("max-rounds");
  }
  if (limits.maxTokens !== null && tokensUsed >= limits.maxTokens) {
    return stop("token-budget");
  }
  if (input.noProgressStreak >= limits.maxNoProgressRounds) {
    return stop("no-progress");
  }

  return { action: "continue", nextRound };
}

function stop(reason: StopReason, detail: string | null = null): GuardDecision {
  return { action: "stop", reason, detail };
}

/** Human-readable one-liner for the status row and the daemon log. */
export function describeStop(reason: StopReason): string {
  switch (reason) {
    case "agent-archived":
      return "Agent was archived.";
    case "canceled":
      return "Turn was interrupted by a human. The loop yielded.";
    case "tool-blocked":
      return "The agent reported a blockage through the goal tool.";
    case "tool-complete":
      return "The agent declared the goal met through the goal tool.";
    case "verify-passed":
      return "The verification command exited 0.";
    case "sentinel":
      return "The completion sentinel appeared in the agent's own output.";
    case "failed":
      return "The turn failed. The loop does not retry provider failures.";
    case "permission-pending":
      return "A request is waiting on a human. The loop paused rather than nudging.";
    case "empty-turn":
      return "The turn produced no text and no tool call.";
    case "question":
      return "The agent ended by asking a question, so it wants an answer, not a nudge.";
    case "max-rounds":
      return "The round ceiling was reached with the goal unmet.";
    case "token-budget":
      return "The token ceiling was reached with the goal unmet.";
    case "no-progress":
      return "Two consecutive nudges moved nothing. Stopped rather than spending again.";
  }
}
