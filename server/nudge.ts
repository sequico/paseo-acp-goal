import type { Goal } from "./goal-source";
import { GOAL_TOOL_BLOCKED, GOAL_TOOL_COMPLETE } from "./mcp";

/**
 * The nudge text.
 *
 * Not a bare "continue". Paseo has a closed bug — getpaseo/paseo#3210, "active
 * Codex goal stops after compaction and leaves loading marker" — where a goal does
 * not survive context compaction. Re-anchoring the goal, the acceptance
 * criterion, and the round on every nudge is insurance against exactly that, and
 * it is why this is a builder rather than a constant.
 */

export interface NudgeOptions {
  goal: Goal;
  round: number;
  /**
   * The last verification failure, fed back so the next round has something to act
   * on. Without this a verification command would gate the loop while telling the
   * agent nothing about why it is still running.
   */
  lastFailure: string | null;
}

export function buildNudge({ goal, round, lastFailure }: NudgeOptions): string {
  const lines = [
    `[acp-goal · round ${round}/${goal.maxRounds}]`,
    "",
    `Goal: ${goal.goal}`,
    "",
    "This is an automated continuation, not a new task. Keep working on the goal above; do not",
    "summarise what you have already done unless that summary is the goal itself.",
  ];

  if (goal.verify !== null) {
    lines.push(
      "",
      `Acceptance: the command \`${goal.verify}\` must exit 0. It runs for you after this turn.`,
      "Run it yourself before finishing so you are not guessing.",
    );
  }

  if (lastFailure !== null) {
    lines.push(
      "",
      "The verification command failed on the last turn. Its output was:",
      "",
      "```",
      // An exit code with no output still has to be reported, or the agent is told
      // nothing about why the loop is still running.
      lastFailure.length > 0 ? lastFailure : "(no output)",
      "```",
      "",
      "Continue until that command exits 0.",
    );
  }

  lines.push(
    "",
    `When the goal is met: call the \`${GOAL_TOOL_COMPLETE}\` tool, or reply with the sentinel`,
    `\`${goal.sentinel}\` alone on its own line.`,
    "",
    `If you are blocked and a human has to decide, call \`${GOAL_TOOL_BLOCKED}\` with the reason`,
    "instead of guessing. That pause is respected, not overridden.",
    "",
    "If the goal tool is not available to you, say so plainly and end with your question — the",
    "loop pauses on a question rather than pushing you on.",
    "",
    "Continue from where you left off.",
  );

  return lines.join("\n");
}
