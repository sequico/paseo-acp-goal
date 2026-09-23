import { z } from "zod";

/**
 * The plugin's own vocabulary, defined once.
 *
 * This module is imported by both runtimes of the plugin and by nothing outside
 * it, so it is the single home for every shared shape: the goal source, the loop
 * state, and the fields of the status row. Anything else that needs one of these
 * derives it from here rather than declaring its own.
 */

/**
 * Where a goal came from, in descending order of authority.
 *
 * - `label` — set at launch by whoever orchestrates the agent. Nothing may override it.
 * - `ui` — set by a human from the ACP goal screen. An explicit human act, so it
 *   outranks the agent's own file.
 * - `file` — declared by the agent itself in its workspace.
 *
 * Adding `ui` was an additive change to a versioned row, not a new version: every
 * value the previous set could produce is still valid, so rows already in
 * transcripts keep rendering.
 */
export const goalSourceSchema = z.enum(["label", "ui", "file"]);

/** How a loop ended, as far as the transcript is concerned. */
export const goalStateSchema = z.enum(["running", "completed", "stopped"]);

/** Stable row identity: reusing it replaces the previous row instead of stacking. */
export const GOAL_STATUS_ROW_ID = "paseo-acp-goal-status";
export const GOAL_STATUS_KIND = "paseo-acp-goal-status";
export const GOAL_STATUS_VERSION = 1;

/** How much verification output a status row carries. The one cap in the system. */
export const GOAL_STATUS_OUTPUT_TAIL = 1500;

export const goalStatusSchema = z.object({
  goal: z.string(),
  source: goalSourceSchema,
  /** Nudges already sent, so the first turn reads as round 1. */
  round: z.number().int().nonnegative(),
  maxRounds: z.number().int().positive(),
  state: goalStateSchema,
  /** Machine-readable reason, mirroring the guard's decision vocabulary. */
  reason: z.string(),
  detail: z.string().nullable(),
  verify: z.string().nullable(),
  /** Trailing output of the last failed verification, or null. */
  output: z.string().nullable(),
});

export type GoalSource = z.output<typeof goalSourceSchema>;
export type GoalState = z.output<typeof goalStateSchema>;
export type GoalStatus = z.output<typeof goalStatusSchema>;

/**
 * How each source reads to a person, rather than how the enum spells it.
 *
 * A `Record` keyed by the vocabulary instead of a chain of comparisons, because the
 * chain is exactly how this went wrong once: a two-branch test — `source === "file"
 * ? "self-declared" : "label"` — treated everything that was not the agent's own file
 * as a launch label, so a goal a human typed on the ACP goals screen was shown in a
 * transcript as one an orchestrator had set. The `Record` makes a fourth source a
 * compile error rather than a fourth silent falsehood.
 */
export const GOAL_SOURCE_LABEL: Record<GoalSource, string> = {
  label: "label",
  ui: "from the screen",
  file: "self-declared",
};
