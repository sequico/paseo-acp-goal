import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { GoalState } from "../shared/goal-status";
import type { Goal } from "./goal-source";

/**
 * Loop accounting that outlives a daemon restart, and deliberately nothing else.
 *
 * The record embeds the resolved goal rather than copying its fields, so there is
 * one definition of what a goal is. The round count and the token spend are
 * persisted so a restart cannot hand an agent a fresh ceiling: a loop that had
 * spent 6 of its 8 rounds comes back knowing it has 2 left.
 *
 * It does not come back *armed*. Nothing re-sends on its own after a restart,
 * because a loop that silently resumes spending after an unrelated crash is the
 * kind of surprise this plugin exists to prevent.
 */

export interface LoopRecord {
  agentId: string;
  goal: Goal;
  /** Nudges already sent. */
  round: number;
  /** Consecutive turns that moved nothing. */
  noProgressStreak: number;
  /** Digest of the last turn's text, to notice a repeated answer. */
  lastTextDigest: string | null;
  /** Cumulative tokens spent by this loop, accumulated per turn. */
  tokensUsed: number;
  /**
   * The loop's last known disposition, so a screen can say why it is not running.
   *
   * Recorded here rather than read back from the status row because the row lives in
   * the agent's transcript: answering "why did this stop" from the transcript would
   * mean paging through it, and this is one field.
   */
  lastOutcome: { state: GoalState; reason: string } | null;
  startedAt: string;
  updatedAt: string;
}

export interface PersistedState {
  version: 1;
  loops: Record<string, LoopRecord>;
  /**
   * Goals a human set from the ACP goal screen.
   *
   * Persisted for the same reason the accounting is, and more strongly: a goal typed
   * by a person is an instruction, not a cache, so a daemon restart must not quietly
   * drop it. Absent in state files written before the screen existed, which is why it
   * is filled in on load rather than required.
   */
  uiGoals: Record<string, Goal>;
}

export function paseoHome(): string {
  const configured = process.env["PASEO_HOME"]?.trim();
  return configured !== undefined && configured.length > 0
    ? configured
    : path.join(homedir(), ".paseo");
}

export class LoopStore {
  readonly path: string;
  private readonly directory: string;

  /** The directory is explicit rather than derived, so a test can own its state. */
  constructor(directory: string) {
    this.directory = directory;
    this.path = path.join(directory, "state.json");
  }

  static forPlugin(pluginId: string): LoopStore {
    return new LoopStore(path.join(paseoHome(), "plugin-data", pluginId));
  }

  async load(): Promise<PersistedState> {
    const raw = await readFile(this.path, "utf8").catch(() => null);
    if (raw === null) {
      return emptyState();
    }
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      if (parsed.version !== 1 || parsed.loops === null || typeof parsed.loops !== "object") {
        return emptyState();
      }
      return {
        version: 1,
        loops: parsed.loops,
        uiGoals:
          parsed.uiGoals !== null && typeof parsed.uiGoals === "object" ? parsed.uiGoals : {},
      };
    } catch {
      // A corrupt state file must not stop the plugin from loading. The loops it
      // described are forgotten, which is the safe direction to fail.
      return emptyState();
    }
  }

  /** Written through a temporary file so a crash mid-write cannot truncate state. */
  async save(state: PersistedState): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporary, this.path);
  }
}

function emptyState(): PersistedState {
  return { version: 1, loops: {}, uiGoals: {} };
}

export function newLoopRecord(input: {
  agentId: string;
  goal: Goal;
  tokensUsed: number;
}): LoopRecord {
  const now = new Date().toISOString();
  return {
    agentId: input.agentId,
    goal: input.goal,
    round: 0,
    noProgressStreak: 0,
    lastTextDigest: null,
    tokensUsed: input.tokensUsed,
    lastOutcome: null,
    startedAt: now,
    updatedAt: now,
  };
}
