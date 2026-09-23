import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";
import { goalSourceSchema, goalStateSchema } from "./goal-status";

/**
 * The ACP goal screen's one round trip.
 *
 * The screen asks one question — "what is going on, and what can I act on?" — so it
 * gets one answer rather than three. Everything it renders comes from a single RPC,
 * which is also why the overview carries the agent roster: the picker needs agents
 * the plugin has never seen, and the client cannot read the plugin's own state.
 */

/** One agent, as the screen needs it. */
export const goalRowSchema = z.object({
  agentId: z.string(),
  title: z.string().nullable(),
  provider: z.string(),
  status: z.string(),
  /** Whether the agent is one the loop would watch once it has a goal. */
  eligible: z.boolean(),
  /** The resolved goal, or null when this agent has none. */
  goal: z.string().nullable(),
  source: goalSourceSchema.nullable(),
  round: z.number().int().nonnegative(),
  maxRounds: z.number().int().positive(),
  state: goalStateSchema.nullable(),
  reason: z.string().nullable(),
  verify: z.string().nullable(),
  /**
   * True when the goal can be cleared from here. A launch label is not the plugin's
   * to remove, so those rows are read-only and the screen says so.
   */
  editable: z.boolean(),
});

export type GoalRow = z.output<typeof goalRowSchema>;

export const goalOverview = defineRpc({
  name: "goal.overview",
  input: z.object({}),
  output: z.object({ rows: z.array(goalRowSchema) }),
});

export const goalSet = defineRpc({
  name: "goal.set",
  input: z.object({
    agentId: z.string().min(1),
    goal: z.string().min(1),
    /** Empty string means "no validation command", which is how a form clears one. */
    verify: z.string().optional(),
    maxRounds: z.number().int().min(1).max(50).optional(),
    maxTokens: z.number().int().positive().optional(),
  }),
  output: z.object({ ok: z.boolean() }),
});

export const goalClear = defineRpc({
  name: "goal.clear",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({ ok: z.boolean() }),
});
