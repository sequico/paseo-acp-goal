import { readFile } from "node:fs/promises";
import path from "node:path";
import { type GoalStatus } from "../shared/goal-status";
import type { GoalAgentGateway } from "./gateway";
import {
  DEFAULT_MAX_NO_PROGRESS_ROUNDS,
  GOAL_FILE,
  GOAL_LABEL,
  fileDeclaresDone,
  parseGoalFile,
  resolveGoal,
  sameGoal,
  type Goal,
  type GoalFile,
} from "./goal-source";
import type { PaseoApi } from "./host-types";
import { decide, describeStop, type GuardSignals, type StopReason, type ToolSignal } from "./guard";
import { containsLine, endsWithQuestion, madeProgress, turnDigest, turnTail } from "./inspect";
import { MCP_SERVER_NAME, mintToken, startGoalMcp, type GoalMcp, type ToolCallEvent } from "./mcp";
import { buildNudge } from "./nudge";
import { paseoGateway } from "./paseo-gateway";
import type { ArchivedEvent, GoalLoopHost, HookContext, TurnEndedEvent } from "./plugin-host";
import { configPathFor, readAcpProviders } from "./providers";
import { LoopStore, newLoopRecord, paseoHome, type LoopRecord, type PersistedState } from "./store";
import { runVerify } from "./verify";

export const PLUGIN_ID = "paseo-acp-goal";
export const PLUGIN_VERSION = "0.1.0";
/** Carries the goal tool's token into the session so calls can be attributed. */
export const GOAL_ENV_TOKEN = "PASEO_ACP_GOAL_TOKEN";

/**
 * Stops that leave the loop resumable.
 *
 * A question and a pending permission are both "a human is needed", not "the goal
 * is abandoned". Keeping the record means the answer to that question continues
 * the same loop, with its round count and token spend intact, instead of resetting
 * the ceiling whenever somebody replies.
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

const LOOP_RECORD_TTL_MS = 24 * 60 * 60 * 1000;
const PENDING_CREATE_TTL_MS = 60 * 60 * 1000;

interface PendingCreate {
  cwd: string;
  at: number;
}

interface Runtime {
  loops: Map<string, LoopRecord>;
  /** Token to agent, learned at `agent.session_open` or on the cwd fallback. */
  tokenToAgent: Map<string, string>;
  agentToToken: Map<string, string>;
  /** Latest tool call per token, consumed when the turn that made it ends. */
  signals: Map<string, ToolCallEvent>;
  /** Tokens minted at creation, awaiting the session that will claim them. */
  pendingCreates: Map<string, PendingCreate>;
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
 * ACP is the default because that is the gap this plugin fills: an ACP agent has
 * no goal mechanism of its own. A goal label opts any other provider in, which
 * keeps the plugin off a busy daemon while leaving a deliberate opt-in available.
 */
function isWatched(runtime: Runtime, provider: string, labels: Record<string, string>): boolean {
  return typeof labels[GOAL_LABEL] === "string" || runtime.acpProviders.has(providerIdOf(provider));
}

async function readGoalFile(cwd: string): Promise<GoalFile | null> {
  const raw = await readFile(path.join(cwd, GOAL_FILE), "utf8").catch(() => null);
  return raw === null ? null : parseGoalFile(raw);
}

/**
 * The signal a `goal_complete` or `goal_blocked` call left behind, consumed once.
 *
 * The token is normally bound at `agent.session_open`, where the injected env is
 * readable next to the agent id. When that binding is missed the create-time
 * working directory is the fallback; an ambiguous match resolves to nothing, which
 * leaves the sentinel and verification to carry the turn.
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
    runtime.agentToToken.set(agentId, token);
    runtime.tokenToAgent.set(token, agentId);
  }

  const signal = runtime.signals.get(token) ?? null;
  runtime.signals.delete(token);
  return signal === null ? null : { kind: signal.kind, detail: signal.detail };
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
  const state: PersistedState = { version: 1, loops: {} };
  for (const [agentId, record] of runtime.loops) {
    state.loops[agentId] = record;
  }
  await runtime.store.save(state).catch((error: unknown) => {
    console.error(`[${PLUGIN_ID}] Could not persist loop state:`, error);
  });
}

/** The loop for this agent, reset when the goal itself changed. */
function recordFor(runtime: Runtime, agentId: string, goal: Goal): LoopRecord {
  const existing = runtime.loops.get(agentId);
  if (existing !== undefined && sameGoal(existing.goal, goal)) {
    return existing;
  }
  return newLoopRecord({ agentId, goal, tokensUsed: 0 });
}

function forget(runtime: Runtime, agentId: string): void {
  runtime.loops.delete(agentId);
  const token = runtime.agentToToken.get(agentId);
  if (token !== undefined) {
    runtime.signals.delete(token);
    runtime.tokenToAgent.delete(token);
    runtime.agentToToken.delete(agentId);
  }
}

function prune(runtime: Runtime): void {
  const loopCutoff = Date.now() - LOOP_RECORD_TTL_MS;
  for (const [agentId, record] of runtime.loops) {
    if (Date.parse(record.updatedAt) < loopCutoff) {
      forget(runtime, agentId);
    }
  }

  const createCutoff = Date.now() - PENDING_CREATE_TTL_MS;
  for (const [token, mint] of runtime.pendingCreates) {
    if (mint.at < createCutoff) {
      runtime.pendingCreates.delete(token);
    }
  }
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
 * This runs detached from the lifecycle hook: `agent.turn_ended` has a thirty
 * second budget while a configured verification command may legitimately run for
 * fifteen minutes, so the hook returns immediately and the loop finishes on its
 * own. `ready` is awaited here for the same reason it is awaited at creation — a
 * turn that ends before the ACP set has loaded must not be judged against an
 * empty set and silently dropped.
 */
async function handleTurnEnded({ runtime, gateway, event, ready }: TurnContext): Promise<void> {
  const { agent, outcome, timeline } = event;
  await ready;
  const snapshot = await gateway.snapshot(agent.id);
  if (snapshot === null || !isWatched(runtime, agent.provider, snapshot.labels)) {
    return;
  }

  const file = await readGoalFile(snapshot.cwd);
  const goal = resolveGoal(snapshot.labels, file);
  if (goal === null) {
    return;
  }

  const record = recordFor(runtime, agent.id, goal);
  const tail = turnTail(timeline);
  const progressing = madeProgress(tail, record.lastTextDigest);
  const noProgressStreak = progressing ? 0 : record.noProgressStreak + 1;

  let verifyPassed: boolean | null = null;
  let verifyOutput: string | null = null;
  if (goal.verify !== null) {
    const result = await runVerify(goal.verify, snapshot.cwd);
    verifyPassed = result.passed;
    verifyOutput = result.output;
  }

  const producedOutput = tail.toolCalls > 0 || tail.text.trim().length > 0;
  const signals: GuardSignals = {
    outcome: outcome.kind,
    cancelReason: outcome.kind === "canceled" ? outcome.reason : null,
    failureMessage: outcome.kind === "failed" ? outcome.error.message : null,
    archived: snapshot.archived,
    permissionPending: snapshot.pendingPermissions > 0,
    verifyPassed,
    goalDeclaredMet: containsLine(tail.text, goal.sentinel) || fileDeclaresDone(file),
    toolSignal: takeToolSignal(runtime, agent.id, snapshot.cwd),
    endsWithQuestion: endsWithQuestion(tail.text),
    producedOutput,
  };

  const tokensUsed = record.tokensUsed + snapshot.inputTokens + snapshot.outputTokens;
  const decision = decide({
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
    const state: GoalStatus["state"] = COMPLETION_STOPS.has(decision.reason)
      ? "completed"
      : "stopped";

    if (RESUMABLE_STOPS.has(decision.reason)) {
      runtime.loops.set(agent.id, next);
    } else {
      forget(runtime, agent.id);
    }

    console.log(
      `[${PLUGIN_ID}] Agent ${agent.id} ${state} (${decision.reason}) after ${next.round} round(s): ${detail}`,
    );
    await gateway.writeStatus(
      agent.id,
      toStatus(next, state, decision.reason, detail, verifyOutput),
    );
    await persist(runtime);
    return;
  }

  next.round = decision.nextRound;
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
}

export function registerGoalLoop(
  host: GoalLoopHost,
  options: GoalLoopOptions = {},
): () => Promise<void> {
  const buildGateway = options.gateway ?? paseoGateway;
  const runtime: Runtime = {
    loops: new Map(),
    tokenToAgent: new Map(),
    agentToToken: new Map(),
    signals: new Map(),
    pendingCreates: new Map(),
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

  // Registration is synchronous; reading state is not. Every hook awaits this, so
  // an agent is never judged against an empty ACP set — and a failure here
  // degrades to label-only rather than to nothing.
  const ready: Promise<void> = (async () => {
    const persisted = await runtime.store.load();
    for (const [agentId, record] of Object.entries(persisted.loops)) {
      runtime.loops.set(agentId, record);
    }
    prune(runtime);
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

  const removers: Array<() => void> = [];

  removers.push(
    host.onCreate(async (request) => {
      await ready;
      const provider = providerIdOf(request.config.provider);
      if (!runtime.acpProviders.has(provider)) {
        // The plugin may have started before this provider was configured, so the
        // set is re-read here rather than only once at load.
        await refreshAcpProviders();
        if (!runtime.acpProviders.has(provider)) {
          return undefined;
        }
      }

      const mcp = await mcpReady;
      if (mcp === null) {
        return undefined;
      }

      prune(runtime);
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
        runtime.tokenToAgent.set(token, request.agentId);
        runtime.pendingCreates.delete(token);
      }
    }),
  );

  removers.push(
    host.onTurnEnded((event, context) => {
      void handleTurnEnded({
        runtime,
        gateway: buildGateway(context.paseo),
        event,
        ready,
      });
    }),
  );

  removers.push(
    host.onArchived((event, context) => {
      void handleArchived(runtime, buildGateway, event, context, ready);
    }),
  );

  return async () => {
    for (const remove of removers) {
      remove();
    }
    runtime.loops.clear();
    runtime.signals.clear();
    runtime.pendingCreates.clear();
    const mcp = await mcpReady;
    await mcp?.close();
  };
}
