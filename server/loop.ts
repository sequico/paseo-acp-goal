import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GoalStatus } from "../shared/goal-status";
import type { GoalAgentGateway } from "./gateway";
import {
  DEFAULT_MAX_NO_PROGRESS_ROUNDS,
  GOAL_FILE,
  GOAL_LABEL,
  fileDeclaresDone,
  goalFromUiInput,
  goalFromLabels,
  parseGoalFile,
  resolveGoal,
  sameGoal,
  type Goal,
  type GoalFile,
  type UiGoalInput,
} from "./goal-source";
import {
  decide,
  decideBeforeVerification,
  describeStop,
  type GuardSignals,
  type StopReason,
  type ToolSignal,
} from "./guard";
import type { PaseoApi } from "./host-types";
import { buildGoalRows } from "./goal-admin";
import type { GoalRow } from "../shared/goal-admin";
import { containsLine, endsWithQuestion, madeProgress, turnDigest, turnTail } from "./inspect";
import { MCP_SERVER_NAME, mintToken, startGoalMcp, type GoalMcp, type ToolCallEvent } from "./mcp";
import { buildNudge } from "./nudge";
import { paseoGateway, listAdminAgents } from "./paseo-gateway";
import type { ArchivedEvent, GoalLoopHost, HookContext, TurnEndedEvent } from "./plugin-host";
import { configPathFor, readAcpProviders } from "./providers";
import { LoopStore, newLoopRecord, paseoHome, type LoopRecord, type PersistedState } from "./store";
import { runVerify } from "./verify";

export const PLUGIN_ID = "paseo-acp-goal";
/**
 * The version this bundle reports when a goal tool handshakes.
 *
 * `package.json` carries the same fact, and it is the one a release is cut from. A
 * comment cannot keep two copies equal and the daemon gives the bundle no way to read
 * the other one — it is evaluated with `globalThis.eval`, with no `import.meta.url` and
 * no path to its own directory, which is the same constraint that forces the goal tool
 * onto loopback HTTP. So `tests/version.test.ts` pins the two together instead, and a
 * bump that reaches one file and not the other fails the gate rather than shipping.
 */
export const PLUGIN_VERSION = "0.1.2";
/** Carries the goal tool's token into the session so calls can be attributed. */
export const GOAL_ENV_TOKEN = "PASEO_ACP_GOAL_TOKEN";

/**
 * Stops that leave the loop resumable.
 *
 * A question and a pending permission are both "a human is needed", not "the goal
 * is abandoned". Keeping the record means the answer to that question continues the
 * same loop, with its round count and token spend intact, instead of resetting the
 * ceiling whenever somebody replies.
 */
const RESUMABLE_STOPS: ReadonlySet<StopReason> = new Set<StopReason>([
  "question",
  "permission-pending",
]);

/** Stops that mean the goal was met, which the transcript shows differently. */
const COMPLETION_STOPS: ReadonlySet<StopReason> = new Set<StopReason>([
  "tool-complete",
  "verify-passed",
  "sentinel",
]);

const DEFAULT_TIMINGS: GoalLoopTimings = {
  recordTtlMs: 24 * 60 * 60 * 1000,
  pendingCreateTtlMs: 60 * 60 * 1000,
  pruneIntervalMs: 15 * 60 * 1000,
};

/**
 * How long the loop's own accounting lives, and how often it is swept.
 *
 * Exposed because these are operational knobs, not constants: an operator running
 * very long goals may want a slower sweep or a longer record life, and a test needs
 * to observe expiry without sleeping for a day.
 */
export interface GoalLoopTimings {
  /** How long a loop's accounting survives without activity. */
  recordTtlMs: number;
  /** How long an unclaimed goal-tool token stays pending. */
  pendingCreateTtlMs: number;
  /** How often the sweep runs. A TTL without a sweep is not a TTL. */
  pruneIntervalMs: number;
}

interface PendingCreate {
  cwd: string;
  at: number;
}

interface Runtime {
  loops: Map<string, LoopRecord>;
  /** MCP token to agent, learned at `agent.session_open` or on the cwd fallback. */
  agentToToken: Map<string, string>;
  /** Latest tool call per token, consumed when the turn that made it ends. */
  signals: Map<string, ToolCallEvent>;
  /** Tokens minted at creation, awaiting the session that will claim them. */
  pendingCreates: Map<string, PendingCreate>;
  /** Goals a human set from the ACP goal screen. Outrank the workspace file. */
  uiGoals: Map<string, Goal>;
  /**
   * The last disposition of a goal whose loop is no longer running.
   *
   * Kept separately from `loops` because those two collections answer different
   * questions: `loops` is "what is spending right now", this is "what happened to the
   * goal I set". Folding them together would make a finished goal look live, and live
   * accounting outlive its loop.
   */
  completedLoops: Map<string, LoopRecord>;
  /** Agents whose turn has started and whose end has not been handled yet. */
  awaitingEnd: Set<string>;
  /** Agents we have seen a turn boundary for, which is what makes a duplicate visible. */
  everStarted: Set<string>;
  /** Agents that have actually called the goal tool, as opposed to merely being offered it. */
  toolUsed: Set<string>;
  /** Agents already warned that the offered tool went unused, so the line is said once. */
  toolUnusedWarned: Set<string>;
  /** Diagnostics sink. Injected so nothing has to mutate a global to read the log. */
  log: (message: string) => void;
  /** Turn handling that is still running, so cleanup can wait for it. */
  inFlight: Set<Promise<void>>;
  acpProviders: Set<string>;
  store: LoopStore;
}

function providerIdOf(value: string): string {
  const slash = value.indexOf("/");
  return slash === -1 ? value : value.slice(0, slash);
}

/**
 * Whether this agent is one the plugin should watch.
 *
 * ACP is the default because that is the gap this plugin fills: an ACP agent has no
 * goal mechanism of its own. A goal label opts any other provider in, which keeps
 * the plugin off a busy daemon while leaving a deliberate opt-in available.
 */
function isWatched(runtime: Runtime, provider: string, labels: Record<string, string>): boolean {
  return typeof labels[GOAL_LABEL] === "string" || runtime.acpProviders.has(providerIdOf(provider));
}

async function readGoalFile(cwd: string): Promise<GoalFile | null> {
  const raw = await readFile(path.join(cwd, GOAL_FILE), "utf8").catch(() => null);
  return raw === null ? null : parseGoalFile(raw);
}

function noteTurnStarted(runtime: Runtime, agentId: string): void {
  runtime.awaitingEnd.add(agentId);
  runtime.everStarted.add(agentId);
}

/**
 * Whether this `turn_ended` closes a turn that has not been handled yet.
 *
 * Without this, a duplicate event would send a second nudge and advance the round
 * twice. `turnId` cannot be the key — Paseo documents that it "can repeat after a
 * session reopens" — so the state is a pair of sets instead: `awaitingEnd` is armed
 * by `agent.turn_started`, and `everStarted` records whether turn boundaries are
 * being observed at all.
 *
 * An end with no start is honoured when no boundary has ever been seen for this
 * agent, because an agent may predate the plugin's own load; it is ignored as a
 * duplicate once a boundary has been seen. Failing open on the first event matters:
 * silently dropping a real turn is worse than one redundant nudge.
 */
function takeTurnEnd(runtime: Runtime, agentId: string): boolean {
  if (runtime.awaitingEnd.delete(agentId)) {
    runtime.everStarted.add(agentId);
    return true;
  }
  if (!runtime.everStarted.has(agentId)) {
    runtime.everStarted.add(agentId);
    return true;
  }
  return false;
}

/**
 * The signal a `goal_complete` or `goal_blocked` call left behind, consumed once.
 *
 * The token is normally bound at `agent.session_open`, where the injected env is
 * readable next to the agent id. When that binding is missed the create-time working
 * directory is the fallback, and claiming a token that way **removes it from the
 * pending set**: two agents sharing a directory must not be able to claim the same
 * token, or the second one could consume the first one's signal.
 */
function takeToolSignal(runtime: Runtime, agentId: string, cwd: string): ToolSignal | null {
  let token = runtime.agentToToken.get(agentId);

  if (token === undefined) {
    const matches = [...runtime.pendingCreates.entries()].filter(([, mint]) => mint.cwd === cwd);
    const match = matches.length === 1 ? matches[0] : undefined;
    if (match === undefined) {
      return null;
    }
    token = match[0];
    runtime.pendingCreates.delete(token);
    runtime.agentToToken.set(agentId, token);
  }

  const signal = runtime.signals.get(token) ?? null;
  if (signal === null) {
    return null;
  }
  runtime.signals.delete(token);
  runtime.toolUsed.add(agentId);
  runtime.toolUnusedWarned.delete(agentId);
  return { kind: signal.kind, detail: signal.detail };
}

function toStatus(
  record: LoopRecord,
  state: GoalStatus["state"],
  reason: string,
  detail: string | null,
  output: string | null,
): GoalStatus {
  return {
    goal: record.goal.goal,
    source: record.goal.source,
    round: record.round,
    maxRounds: record.goal.maxRounds,
    state,
    reason,
    detail,
    verify: record.goal.verify,
    output,
  };
}

async function persist(runtime: Runtime): Promise<void> {
  const loops: Record<string, LoopRecord> = {};
  for (const [agentId, record] of runtime.loops) {
    loops[agentId] = record;
  }
  for (const [agentId, record] of runtime.completedLoops) {
    loops[agentId] = record;
  }
  const state: PersistedState = { version: 1, loops, uiGoals: {} };
  for (const [agentId, goal] of runtime.uiGoals) {
    state.uiGoals[agentId] = goal;
  }
  await runtime.store.save(state).catch((error: unknown) => {
    console.error(`[${PLUGIN_ID}] Could not persist loop state:`, error);
  });
}

/**
 * The loop for this agent.
 *
 * A changed goal resets the round count and the stall detection, because a new goal
 * is new work. It does **not** reset the token spend: that ceiling bounds the agent, so
 * the spend follows the agent across goals — including across one that already
 * finished, which is why the completed record is consulted as well. An agent able to
 * start again with a fresh budget because a human set a second goal would have an
 * unbounded allowance and the ceiling would be decorative.
 */
function recordFor(runtime: Runtime, agentId: string, goal: Goal): LoopRecord {
  const existing = runtime.loops.get(agentId) ?? runtime.completedLoops.get(agentId);
  if (existing !== undefined && sameGoal(existing.goal, goal)) {
    return existing;
  }
  return newLoopRecord({ agentId, goal, tokensUsed: existing?.tokensUsed ?? 0 });
}

function forget(runtime: Runtime, agentId: string): void {
  runtime.loops.delete(agentId);
  const token = runtime.agentToToken.get(agentId);
  if (token !== undefined) {
    runtime.signals.delete(token);
    runtime.agentToToken.delete(agentId);
  }
  runtime.awaitingEnd.delete(agentId);
}

/**
 * Say so, once, when an agent finishes without ever calling a tool it was offered.
 *
 * The plugin cannot ask whether a provider exposed the injected MCP server — that is
 * decided inside the agent, and Paseo reports nothing about it. What it *can* observe
 * is the consequence: the tool was offered, the agent never called it, and the loop
 * was ended by something else. That is worth a line in the log, because otherwise the
 * gap is silent and a reader of the README would go looking for a warning that never
 * comes.
 */
function noteToolUnused(runtime: Runtime, agentId: string, reason: StopReason): void {
  if (reason === "tool-complete") {
    return;
  }
  if (!runtime.agentToToken.has(agentId) || runtime.toolUsed.has(agentId)) {
    return;
  }
  if (runtime.toolUnusedWarned.has(agentId)) {
    return;
  }
  runtime.toolUnusedWarned.add(agentId);
  runtime.log(
    `[${PLUGIN_ID}] Agent ${agentId} ended its goal (${reason}) without ever calling the goal tool, ` +
      `which was offered to it. This provider may not expose injected MCP servers over ACP; the ` +
      `sentinel route carried the turn instead.`,
  );
}

function prune(runtime: Runtime, timings: GoalLoopTimings): void {
  // The expiry test is `updatedAt <= now - ttl`, which is the same statement as
  // `now - updatedAt >= ttl` — expiry at exactly the TTL boundary.
  const now = Date.now();
  const loopCutoff = now - timings.recordTtlMs;
  for (const [agentId, record] of runtime.loops) {
    if (Date.parse(record.updatedAt) <= loopCutoff) {
      forget(runtime, agentId);
    }
  }

  // Outcomes are bounded by the same TTL. Without this, a finished goal would be
  // remembered for the life of the daemon and the screen would fill with history it
  // has no way to clear.
  for (const [agentId, record] of runtime.completedLoops) {
    if (Date.parse(record.updatedAt) <= loopCutoff) {
      runtime.completedLoops.delete(agentId);
    }
  }

  const createCutoff = now - timings.pendingCreateTtlMs;
  for (const [token, mint] of runtime.pendingCreates) {
    if (mint.at <= createCutoff) {
      runtime.pendingCreates.delete(token);
    }
  }

  // A tool call whose turn never ended would otherwise sit in memory for the life of
  // the process, so any signal that is neither pending nor bound is dropped.
  const bound = new Set(runtime.agentToToken.values());
  for (const token of runtime.signals.keys()) {
    if (!runtime.pendingCreates.has(token) && !bound.has(token)) {
      runtime.signals.delete(token);
    }
  }

  // The tool-use bookkeeping is per agent and only meaningful while that agent still
  // has a loop or an open goal-tool binding, so it is dropped with them rather than
  // growing for the life of the daemon.
  for (const agentId of runtime.toolUsed) {
    if (!runtime.loops.has(agentId) && !runtime.agentToToken.has(agentId)) {
      runtime.toolUsed.delete(agentId);
    }
  }
  for (const agentId of runtime.toolUnusedWarned) {
    if (!runtime.loops.has(agentId) && !runtime.agentToToken.has(agentId)) {
      runtime.toolUnusedWarned.delete(agentId);
    }
  }
}

/**
 * Record a stop, tell the transcript, and decide what survives it.
 *
 * Extracted from the turn handler so the handler reads as evidence, decision, outcome
 * — and because the survival rules are their own subject: a paused loop is kept so an
 * answer continues it, a finished one is recorded as history, and the diagnostic runs
 * before the binding it reads is forgotten.
 */
async function recordStop(
  runtime: Runtime,
  gateway: GoalAgentGateway,
  agentId: string,
  record: LoopRecord,
  reason: StopReason,
  detail: string,
  verifyOutput: string | null,
): Promise<void> {
  const state: GoalStatus["state"] = COMPLETION_STOPS.has(reason) ? "completed" : "stopped";

  const next: LoopRecord = { ...record, lastOutcome: { state, reason } };

  if (RESUMABLE_STOPS.has(reason)) {
    // A paused loop is kept, and so is a goal a human typed: answering a question must
    // continue the same loop, with its round count and token spend intact.
    runtime.loops.set(agentId, next);
  } else {
    // The diagnostic reads the goal-tool binding, so it runs before `forget` removes
    // it. Ordering matters here and is the reason this is not a one-liner.
    noteToolUnused(runtime, agentId, reason);
    // The live record goes, so the round count and spend are not carried into unrelated
    // work and the next goal starts its own budget.
    forget(runtime, agentId);
  }

  // The outcome survives the loop for every goal, because "why did this stop" is worth
  // answering for a labelled goal as much as for one a human typed. The TTL bounds it.
  runtime.completedLoops.set(agentId, next);

  runtime.log(
    `[${PLUGIN_ID}] Agent ${agentId} ${state} (${reason}) after ${next.round} round(s): ${detail}`,
  );
  await gateway.writeStatus(agentId, toStatus(next, state, reason, detail, verifyOutput));
}

interface TurnContext {
  runtime: Runtime;
  gateway: GoalAgentGateway;
  event: TurnEndedEvent;
  ready: Promise<void>;
}

/**
 * One turn, judged.
 *
 * This runs detached from the lifecycle hook: `agent.turn_ended` has a thirty second
 * budget while a configured verification command may legitimately run for fifteen
 * minutes, so the hook returns immediately and the loop finishes on its own. `ready`
 * is awaited here for the same reason it is awaited at creation — a turn that ends
 * before the ACP set has loaded must not be judged against an empty set and silently
 * dropped.
 *
 * The goal is resolved before the duplicate check, and the order is deliberate: without
 * it, every watched agent that has no goal would log "ignoring a duplicate" for a loop
 * it is not running. A diagnostic that fires for agents the plugin is not driving is
 * worse than no diagnostic, because it teaches a reader to ignore the line.
 */
async function handleTurnEnded({ runtime, gateway, event, ready }: TurnContext): Promise<void> {
  const { agent, outcome, timeline } = event;
  await ready;

  const snapshot = await gateway.snapshot(agent.id);
  if (snapshot === null || !isWatched(runtime, agent.provider, snapshot.labels)) {
    return;
  }

  const file = await readGoalFile(snapshot.cwd);
  const goal = resolveGoal(snapshot.labels, runtime.uiGoals.get(agent.id) ?? null, file);
  if (goal === null) {
    return;
  }

  if (!takeTurnEnd(runtime, agent.id)) {
    runtime.log(`[${PLUGIN_ID}] Ignoring a duplicate turn-ended event for agent ${agent.id}`);
    return;
  }

  const record = recordFor(runtime, agent.id, goal);
  const tail = turnTail(timeline);
  const progressing = madeProgress(tail, record.lastTextDigest);
  const noProgressStreak = progressing ? 0 : record.noProgressStreak + 1;
  const producedOutput = tail.toolCalls > 0 || tail.text.trim().length > 0;

  const cancelReason = outcome.kind === "canceled" ? outcome.reason : null;
  const toolSignal = takeToolSignal(runtime, agent.id, snapshot.cwd);

  // The rules above a measurement are decided first, so a verification command is not
  // run for a turn that is already over — an archived agent must not trigger a test
  // suite. The ordering itself lives in `guard.ts`; nothing is re-stated here.
  const early = decideBeforeVerification({
    archived: snapshot.archived,
    outcome: outcome.kind,
    cancelReason,
    toolSignal,
  });

  let verifyPassed: boolean | null = null;
  let verifyOutput: string | null = null;
  if (early === null && goal.verify !== null) {
    const result = await runVerify(goal.verify, snapshot.cwd);
    verifyPassed = result.passed;
    verifyOutput = result.output;
  }

  const signals: GuardSignals = {
    archived: snapshot.archived,
    outcome: outcome.kind,
    cancelReason,
    toolSignal,
    failureMessage: outcome.kind === "failed" ? outcome.error.message : null,
    permissionPending: snapshot.pendingPermissions > 0,
    verifyPassed,
    goalDeclaredMet: containsLine(tail.text, goal.sentinel) || fileDeclaresDone(file),
    endsWithQuestion: endsWithQuestion(tail.text),
    producedOutput,
  };

  const tokensUsed = record.tokensUsed + snapshot.inputTokens + snapshot.outputTokens;
  const decision =
    early ??
    decide({
      round: record.round,
      noProgressStreak,
      tokensUsed,
      signals,
      limits: {
        maxRounds: goal.maxRounds,
        maxTokens: goal.maxTokens,
        maxNoProgressRounds: DEFAULT_MAX_NO_PROGRESS_ROUNDS,
      },
    });

  const next: LoopRecord = {
    ...record,
    tokensUsed,
    noProgressStreak,
    lastTextDigest: turnDigest(tail) ?? record.lastTextDigest,
    updatedAt: new Date().toISOString(),
  };

  if (decision.action === "stop") {
    const detail = decision.detail ?? describeStop(decision.reason);
    await recordStop(runtime, gateway, agent.id, next, decision.reason, detail, verifyOutput);
    await persist(runtime);
    return;
  }

  next.round = decision.nextRound;
  // The record may be carrying a previous stop — a loop paused on a question keeps
  // its accounting so an answer continues it. Cleared here, because a running loop has
  // no outcome and leaving the old one would describe it as stopped.
  next.lastOutcome = null;
  runtime.loops.set(agent.id, next);
  await gateway.writeStatus(agent.id, toStatus(next, "running", "continue", null, verifyOutput));

  try {
    await gateway.send(
      agent.id,
      buildNudge({
        goal,
        round: decision.nextRound,
        // Only a failure is worth repeating back; a passing command ends the loop.
        lastFailure: verifyPassed === false ? verifyOutput : null,
      }),
    );
  } catch (error: unknown) {
    console.error(`[${PLUGIN_ID}] Could not send a nudge to agent ${agent.id}:`, error);
  }
  await persist(runtime);
}

/**
 * The end of one agent's loop, recorded once.
 *
 * Extracted from the hook registration so the registration stays a one-liner and the
 * `.then` chain — which oxlint rightly flags for not returning a value on its early
 * exit — is not needed at all.
 */
async function handleArchived(
  runtime: Runtime,
  gatewayFor: (paseo: PaseoApi) => GoalAgentGateway,
  event: ArchivedEvent,
  context: HookContext,
  ready: Promise<void>,
): Promise<void> {
  await ready;
  const record = runtime.loops.get(event.agent.id);
  if (record === undefined) {
    return;
  }
  forget(runtime, event.agent.id);
  await gatewayFor(context.paseo).writeStatus(
    event.agent.id,
    toStatus(record, "stopped", "agent-archived", describeStop("agent-archived"), null),
  );
  await persist(runtime);
}

export interface GoalLoopOptions {
  version?: string;
  /** The daemon's config file, which is where the ACP provider set lives. */
  configPath?: string;
  /** Where loop accounting is kept. Defaults to the daemon's plugin-data directory. */
  stateDirectory?: string;
  /** How the loop reaches agents. Defaults to the real daemon client. */
  gateway?: (paseo: PaseoApi) => GoalAgentGateway;
  /** Lifetimes and sweep cadence. Defaults are in `DEFAULT_TIMINGS`. */
  timings?: Partial<GoalLoopTimings>;
  /**
   * Where diagnostics go. Defaults to `console.log`, which is what the daemon
   * captures. Injected so a caller can observe the loop's own output without
   * replacing a global — mutating `console` to read a log is the kind of manoeuvre
   * that works in one environment and quietly breaks in another.
   */
  log?: (message: string) => void;
}

export interface GoalLoop {
  /**
   * Paseo's cleanup. Waits for in-flight turn handling before it returns.
   *
   * A turn handler outlives its hook by design, so a plugin that stops while one is
   * mid-write would leave a half-written state file. Waiting is not a test
   * convenience; it is the difference between stopping cleanly and stopping between
   * two writes.
   */
  cleanup: () => Promise<void>;
  /**
   * Resolves once no turn handling is in flight.
   *
   * Exposed because "the hook returned immediately" and "the turn is finished being
   * judged" are different facts, and a supervisor — or a test — legitimately needs
   * the second one. Without it the only way to wait is to guess at a number of event
   * loop turns, which is how a suite becomes flaky on a machine it was never run on.
   */
  idle: () => Promise<void>;
  /** The data behind the ACP goals screen. Read-only; the screen mutates via RPC. */
  admin: GoalLoopAdmin;
}

/** What the ACP goals screen reads and writes, independent of any RPC transport. */
export interface GoalLoopAdmin {
  /**
   * Every agent worth showing, with whatever goal it currently has.
   *
   * Takes the API rather than holding one, because a plugin's server code only ever
   * receives a Paseo client inside a hook or handler context; there is no ambient
   * client to capture at registration time.
   */
  rows(paseo: PaseoApi): Promise<GoalRow[]>;
  /**
   * Set a human-owned goal. Outranks the workspace file, never a launch label.
   *
   * Needs the client because it must read the agent's labels to know whether a label
   * already owns the goal, and answering that from anything else would be a guess.
   */
  set(paseo: PaseoApi, agentId: string, input: UiGoalInput): Promise<{ ok: boolean }>;
  /**
   * Remove a human-owned goal. A launch label is not clearable from here.
   *
   * Needs no client: it only touches the plugin's own state, and a goal that is not in
   * it was never the screen's to remove.
   */
  clear(agentId: string): Promise<{ ok: boolean }>;
}

export function registerGoalLoop(host: GoalLoopHost, options: GoalLoopOptions = {}): GoalLoop {
  const buildGateway = options.gateway ?? paseoGateway;
  const timings: GoalLoopTimings = { ...DEFAULT_TIMINGS, ...options.timings };
  const runtime: Runtime = {
    loops: new Map(),
    agentToToken: new Map(),
    signals: new Map(),
    pendingCreates: new Map(),
    uiGoals: new Map(),
    completedLoops: new Map(),
    awaitingEnd: new Set(),
    everStarted: new Set(),
    toolUsed: new Set(),
    toolUnusedWarned: new Set(),
    log: options.log ?? ((message: string) => console.log(message)),
    inFlight: new Set(),
    acpProviders: new Set(),
    store:
      options.stateDirectory === undefined
        ? LoopStore.forPlugin(PLUGIN_ID)
        : new LoopStore(options.stateDirectory),
  };

  const configPath = options.configPath ?? configPathFor(paseoHome());

  const refreshAcpProviders = async (): Promise<void> => {
    runtime.acpProviders = await readAcpProviders(configPath);
  };

  // Registration is synchronous; reading state is not. Every hook awaits this, so an
  // agent is never judged against an empty ACP set — and a failure here degrades to
  // label-only rather than to nothing.
  const ready: Promise<void> = (async () => {
    const persisted = await runtime.store.load();
    for (const [agentId, record] of Object.entries(persisted.loops)) {
      // A record whose outcome is already decided is history, not live accounting.
      if (record.lastOutcome === null) {
        runtime.loops.set(agentId, record);
      } else {
        runtime.completedLoops.set(agentId, record);
      }
    }
    for (const [agentId, goal] of Object.entries(persisted.uiGoals)) {
      runtime.uiGoals.set(agentId, goal);
    }
    prune(runtime, timings);
    await refreshAcpProviders();
  })().catch((error: unknown) => {
    console.error(
      `[${PLUGIN_ID}] Start-up state could not be read; continuing with labels only:`,
      error,
    );
  });

  const mcpReady: Promise<GoalMcp | null> = startGoalMcp({
    version: options.version ?? PLUGIN_VERSION,
    onSignal: (event) => {
      runtime.signals.set(event.token, event);
    },
  }).catch((error: unknown) => {
    console.error(
      `[${PLUGIN_ID}] The goal tool listener could not start; the sentinel still decides turns:`,
      error,
    );
    return null;
  });

  const pruneTimer = setInterval(() => prune(runtime, timings), timings.pruneIntervalMs);
  pruneTimer.unref();

  const removers: Array<() => void> = [];

  removers.push(
    host.onCreate(async (request) => {
      await ready;
      const provider = providerIdOf(request.config.provider);
      if (!runtime.acpProviders.has(provider)) {
        // The plugin may have started before this provider was configured, so the set
        // is re-read here rather than only once at load.
        await refreshAcpProviders();
        if (!runtime.acpProviders.has(provider)) {
          return undefined;
        }
      }

      const mcp = await mcpReady;
      if (mcp === null) {
        return undefined;
      }

      prune(runtime, timings);
      const token = mintToken();
      runtime.pendingCreates.set(token, { cwd: request.config.cwd, at: Date.now() });
      console.log(
        `[${PLUGIN_ID}] Offering the goal tool to a ${provider} agent in ${request.config.cwd}`,
      );

      return {
        ...request,
        config: {
          ...request.config,
          mcpServers: {
            ...request.config.mcpServers,
            [MCP_SERVER_NAME]: { type: "http", url: mcp.urlFor(token) },
          },
        },
        env: { ...request.env, [GOAL_ENV_TOKEN]: token },
      };
    }),
  );

  removers.push(
    host.onSessionOpen((request) => {
      const token = request.env[GOAL_ENV_TOKEN];
      if (token !== undefined && token.length > 0) {
        runtime.agentToToken.set(request.agentId, token);
        runtime.pendingCreates.delete(token);
      }
    }),
  );

  removers.push(host.onTurnStarted((event) => noteTurnStarted(runtime, event.agent.id)));

  removers.push(
    host.onTurnEnded((event, context) => {
      const work = handleTurnEnded({
        runtime,
        gateway: buildGateway(context.paseo),
        event,
        ready,
      });
      // Tracked so cleanup can wait for it. A turn handler outlives its hook by
      // design, and a plugin that stops while one is mid-write would leave a state
      // file half-written and a directory that is not empty when it should be gone.
      runtime.inFlight.add(work);
      void work.finally(() => runtime.inFlight.delete(work));
    }),
  );

  removers.push(
    host.onArchived((event, context) => {
      const work = handleArchived(runtime, buildGateway, event, context, ready);
      runtime.inFlight.add(work);
      void work.finally(() => runtime.inFlight.delete(work));
    }),
  );

  const admin: GoalLoopAdmin = {
    async rows(paseo): Promise<GoalRow[]> {
      await ready;
      return buildGoalRows({
        agents: await listAdminAgents(paseo),
        loops: runtime.loops,
        completedLoops: runtime.completedLoops,
        uiGoals: runtime.uiGoals,
        isEligible: (provider, labels) => isWatched(runtime, provider, labels),
      });
    },

    async set(paseo, agentId, input): Promise<{ ok: boolean }> {
      await ready;
      const goal = goalFromUiInput(input);
      if (goal === null) {
        return { ok: false };
      }

      // Refuse when a launch label owns the goal. The screen hides those rows' controls,
      // but this RPC is reachable without the screen, and storing a goal the label will
      // always outrank would be a silent no-op.
      const owner = await buildGateway(paseo).snapshot(agentId);
      if (owner !== null && goalFromLabels(owner.labels) !== null) {
        runtime.log(
          `[${PLUGIN_ID}] Refused a goal for agent ${agentId}: a launch label already owns it`,
        );
        return { ok: false };
      }

      // A human's instruction replaces whatever the agent declared for itself, and resets
      // the round count so the new goal gets its own budget. The token spend is not reset:
      // it bounds the agent, and `recordFor` reads it back from the record dropped here.
      // Any recorded outcome goes with it — this goal has not run yet, and showing the
      // previous goal's ending would describe work that has not happened.
      runtime.uiGoals.set(agentId, goal);
      runtime.completedLoops.delete(agentId);
      await persist(runtime);
      runtime.log(`[${PLUGIN_ID}] A goal was set from the ACP goals screen for agent ${agentId}`);
      return { ok: true };
    },

    async clear(agentId): Promise<{ ok: boolean }> {
      await ready;
      if (!runtime.uiGoals.has(agentId)) {
        return { ok: false };
      }
      runtime.uiGoals.delete(agentId);
      runtime.completedLoops.delete(agentId);
      // Clearing a goal means no longer driving that agent, so a loop in flight goes
      // with it. Leaving the loop running would keep nudging toward a goal a human had
      // just removed, which is the one thing this screen must never do.
      forget(runtime, agentId);
      await persist(runtime);
      runtime.log(
        `[${PLUGIN_ID}] A goal was cleared from the ACP goals screen for agent ${agentId}`,
      );
      return { ok: true };
    },
  };

  const settle = async (): Promise<void> => {
    // `allSettled` iterates its input synchronously, so the live set is safe to pass
    // directly; the loop re-reads its size in case more work was started meanwhile.
    while (runtime.inFlight.size > 0) {
      await Promise.allSettled(runtime.inFlight);
    }
  };

  const cleanup = async (): Promise<void> => {
    clearInterval(pruneTimer);
    for (const remove of removers) {
      remove();
    }

    // Wait for turn handling that is still running before tearing anything down.
    await settle();

    runtime.loops.clear();
    runtime.signals.clear();
    runtime.pendingCreates.clear();
    runtime.awaitingEnd.clear();
    runtime.everStarted.clear();
    runtime.toolUsed.clear();
    runtime.toolUnusedWarned.clear();
    const mcp = await mcpReady;
    await mcp?.close();
  };

  return { cleanup, idle: settle, admin };
}
