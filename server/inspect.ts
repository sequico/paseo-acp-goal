import type { AgentTimelineItem } from "./host-types";

/**
 * Reading the tail of a turn out of the full timeline snapshot.
 *
 * `agent.turn_ended` hands over the entire conversation, so every signal this
 * plugin reads has to be scoped to the stretch after the last user message, or a
 * previous turn's text would satisfy a completion check.
 *
 * The joining approach follows the `latestOutputText` helper in Paseo's own
 * `plugin-examples/lifecycle-actions`, which documents how a provider's streamed
 * text arrives.
 */

export interface TurnTail {
  /** Concatenated assistant and reasoning text produced after the prompt. */
  text: string;
  /** Tool calls started in this turn. Any one of them counts as progress. */
  toolCalls: number;
}

export function turnTail(timeline: readonly AgentTimelineItem[]): TurnTail {
  let start = 0;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index]?.type === "user_message") {
      start = index + 1;
      break;
    }
  }

  let text = "";
  let toolCalls = 0;

  for (const item of timeline.slice(start)) {
    if (item.type === "tool_call") {
      toolCalls += 1;
      continue;
    }
    // Errors, notifications, todos, compactions, and plugin rows carry no prose
    // an agent authored, so none of them is evidence of progress.
    if ("text" in item && typeof item.text === "string") {
      text += `${item.text}\n`;
    }
  }

  return { text, toolCalls };
}

/**
 * A turn's last meaningful line ending in a question mark reads as the agent
 * waiting on a human, not as an agent that ran out of steam.
 */
export function endsWithQuestion(text: string): boolean {
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) {
    return false;
  }
  const lastLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1).trimEnd();
  return lastLine.endsWith("?");
}

/**
 * FNV-1a over a string. Internal on purpose: a digest is only ever meaningful for
 * the one question "is this the same turn again", so the only exported way to ask
 * is `turnDigest`, and there is no second call site to compute it differently.
 */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The canonical identity of a turn's output: `null` when the agent said nothing.
 *
 * Storing and comparing must both go through here. Computing a digest on the raw
 * text at one call site and on the trimmed text at another is a silent bug: the
 * two never match, every turn looks like progress, and the stall guard can never
 * fire.
 */
export function turnDigest(tail: TurnTail): string | null {
  const text = tail.text.trim();
  return text.length === 0 ? null : digest(text);
}

/** True when the agent said something it had not said before, or ran a tool. */
export function madeProgress(tail: TurnTail, previousDigest: string | null): boolean {
  if (tail.toolCalls > 0) {
    return true;
  }
  const current = turnDigest(tail);
  return current !== null && current !== previousDigest;
}

export function containsLine(text: string, line: string): boolean {
  return text.split("\n").some((candidate) => candidate.trim() === line);
}
