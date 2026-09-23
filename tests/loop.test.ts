import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { GoalStatus } from "../shared/goal-status";
import type { GoalAgentGateway, GoalAgentSnapshot } from "../server/gateway";
import { GOAL_ENV_TOKEN, registerGoalLoop } from "../server/loop";
import type { PaseoApi } from "../server/host-types";
import type {
  ArchivedEvent,
  CreateRequest,
  GoalLoopHost,
  HookContext,
  SessionOpenRequest,
  TurnEndedEvent,
} from "../server/plugin-host";
import type { PluginHookAgent } from "@getpaseo/plugin/server";
import type { AgentTimelineItem } from "../server/host-types";

/**
 * The loop driven end to end, with its two real dependencies supplied as data.
 *
 * The loop declares small interfaces for exactly this: the five host hooks it uses
 * and the three gateway operations it performs. So the whole safety story is
 * exercised without a daemon, an agent, or a fake framework — while the verification
 * command still runs for real, because that boundary is the one worth paying for.
 *
 * `turn()` fires `turn_started` then `turn_ended`, which is the order the daemon
 * produces and which the loop's duplicate detection depends on. `fire()` sends a bare
 * end, for the cases that test what happens without one.
 */

const AGENT: PluginHookAgent = {
  id: "agent-1",
  provider: "codewhale",
  cwd: "/workspace",
  workspaceId: "ws-1",
  parentAgentId: null,
  title: null,
};

interface Recorded {
  sends: Array<{ agentId: string; text: string }>;
  byAgent: Map<string, GoalStatus[]>;
  /** Everything the loop wrote to stdout, so its diagnostics are testable. */
  logs: string[];
}

interface HarnessOptions {
  labels?: Record<string, string>;
  acpProviders?: string[];
  inputTokens?: number;
  outputTokens?: number;
  pendingPermissions?: number;
  archived?: boolean;
  goalFile?: Record<string, unknown>;
  recordTtlMs?: number;
}

interface Harness {
  readonly dir: string;
  readonly recorded: Recorded;
  /** A real turn: `turn_started`, then `turn_ended`. */
  turn: (
    timeline: AgentTimelineItem[],
    options?: { outcome?: TurnEndedEvent["outcome"]; agentId?: string },
  ) => Promise<void>;
  /** A bare end, with no start — the shape a duplicate event has. */
  fire: (
    timeline: AgentTimelineItem[],
    options?: { outcome?: TurnEndedEvent["outcome"]; agentId?: string },
  ) => Promise<void>;
  turnStarted: (agentId?: string) => void;
  archive: (agentId?: string) => Promise<void>;
  create: (request: CreateRequest) => Promise<CreateRequest | undefined>;
  sessionOpen: (request: SessionOpenRequest) => void;
  writeGoalFile: (contents: Record<string, unknown>) => Promise<void>;
  /** The last status written for an agent, or undefined. */
  lastStatus: (agentId?: string) => GoalStatus | undefined;
  dispose: () => Promise<void>;
}

function assistantTurn(text: string): AgentTimelineItem[] {
  return [
    { type: "user_message", text: "carry on with the work" },
    { type: "assistant_message", text },
  ];
}

async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), "acp-goal-"));
  const recorded: Recorded = { sends: [], byAgent: new Map(), logs: [] };

  const configPath = path.join(dir, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      agents: {
        providers: Object.fromEntries(
          (options.acpProviders ?? ["codewhale"]).map((provider) => [provider, { extends: "acp" }]),
        ),
      },
    }),
  );

  const writeGoalFile = async (contents: Record<string, unknown>): Promise<void> => {
    await writeFile(path.join(dir, ".acp-goal.json"), JSON.stringify(contents));
  };
  if (options.goalFile !== undefined) {
    await writeGoalFile(options.goalFile);
  }

  const snapshot: GoalAgentSnapshot = {
    labels: options.labels ?? {},
    cwd: dir,
    inputTokens: options.inputTokens ?? 0,
    outputTokens: options.outputTokens ?? 0,
    archived: options.archived ?? false,
    pendingPermissions: options.pendingPermissions ?? 0,
  };

  const gateway: GoalAgentGateway = {
    snapshot: async () => snapshot,
    send: async (agentId, text) => {
      recorded.sends.push({ agentId, text });
    },
    writeStatus: async (agentId, status) => {
      const existing = recorded.byAgent.get(agentId) ?? [];
      existing.push(status);
      recorded.byAgent.set(agentId, existing);
    },
  };

  let turnStarted: ((event: { agent: PluginHookAgent }) => void) | null = null;
  let turnEnded: ((event: TurnEndedEvent, context: HookContext) => void) | null = null;
  let archived: ((event: ArchivedEvent, context: HookContext) => void) | null = null;
  let create: ((request: CreateRequest) => Promise<CreateRequest | undefined>) | null = null;
  let sessionOpen: ((request: SessionOpenRequest) => void) | null = null;

  const host: GoalLoopHost = {
    onTurnStarted: (handler) => {
      turnStarted = handler;
      return () => {
        turnStarted = null;
      };
    },
    onTurnEnded: (handler) => {
      turnEnded = handler;
      return () => {
        turnEnded = null;
      };
    },
    onArchived: (handler) => {
      archived = handler;
      return () => {
        archived = null;
      };
    },
    onCreate: (handler) => {
      create = handler;
      return () => {
        create = null;
      };
    },
    onSessionOpen: (handler) => {
      sessionOpen = handler;
      return () => {
        sessionOpen = null;
      };
    },
  };

  const loop = registerGoalLoop(host, {
    version: "0.0.0-test",
    configPath,
    stateDirectory: path.join(dir, "state"),
    gateway: () => gateway,
    // An injected sink rather than a replaced global: two harnesses cannot clobber
    // each other's output, and a failure cannot leave `console` patched behind it.
    log: (message) => recorded.logs.push(message),
    ...(options.recordTtlMs === undefined ? {} : { timings: { recordTtlMs: options.recordTtlMs } }),
  });

  // Every hook detaches its work, because a verification command may run for minutes.
  // Waiting on a fixed number of event loop turns would make this suite depend on how
  // fast a subprocess exits on the machine running it, so the wait is on the loop's
  // own statement that it is quiescent.
  const drain = (): Promise<void> => loop.idle();

  const agentFor = (agentId: string | undefined): PluginHookAgent => ({
    ...AGENT,
    id: agentId ?? AGENT.id,
    cwd: dir,
  });

  // The loop never dereferences this handle: the injected gateway factory replaces
  // the daemon entirely, which is what the factory option exists for.
  const context: HookContext = { paseo: {} as PaseoApi };

  const noteStarted = (agentId?: string): void => {
    assert.ok(turnStarted, "the loop must register a turn-started handler");
    turnStarted({ agent: agentFor(agentId) });
  };

  const endTurn = async (
    timeline: AgentTimelineItem[],
    opts?: { outcome?: TurnEndedEvent["outcome"]; agentId?: string },
  ): Promise<void> => {
    assert.ok(turnEnded, "the loop must register a turn-ended handler");
    turnEnded(
      { agent: agentFor(opts?.agentId), outcome: opts?.outcome ?? { kind: "completed" }, timeline },
      context,
    );
    await drain();
  };

  return {
    dir,
    recorded,
    turnStarted: noteStarted,
    async turn(timeline, opts) {
      noteStarted(opts?.agentId);
      await endTurn(timeline, opts);
    },
    fire: endTurn,
    lastStatus(agentId) {
      return recorded.byAgent.get(agentId ?? AGENT.id)?.at(-1);
    },
    writeGoalFile,
    async archive(agentId) {
      assert.ok(archived, "the loop must register an archived handler");
      archived({ agent: agentFor(agentId) }, context);
      await drain();
    },
    async create(request) {
      assert.ok(create, "the loop must register a create handler");
      const result = await create(request);
      await drain();
      return result;
    },
    sessionOpen(request) {
      assert.ok(sessionOpen, "the loop must register a session-open handler");
      sessionOpen(request);
    },
    async dispose() {
      await loop.cleanup();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function createRequest(dir: string, provider = "codewhale"): CreateRequest {
  return { config: { provider, cwd: dir } as CreateRequest["config"] };
}

function sendsFor(harness: Harness, agentId = AGENT.id): string[] {
  return harness.recorded.sends.filter((send) => send.agentId === agentId).map((send) => send.text);
}

/** The round of every status written for an agent, in order. */
function roundsFor(harness: Harness, agentId = AGENT.id): number[] {
  return (harness.recorded.byAgent.get(agentId) ?? []).map((status) => status.round);
}

/** The lines the loop wrote about an offered goal tool that went unused. */
function toolUnusedWarnings(harness: Harness): string[] {
  return harness.recorded.logs.filter((line) => line.includes("without ever calling"));
}

/** The token and URL the plugin injected for a creation. */
function injected(result: CreateRequest): { url: string; token: string } {
  const server = result.config.mcpServers?.["paseo-acp-goal"];
  const url = server?.type === "http" ? server.url : "";
  const token = result.env?.[GOAL_ENV_TOKEN] ?? "";
  assert.ok(
    url.length > 0 && token.length > 0,
    "a creation must carry the goal tool and its token",
  );
  return { url, token };
}

async function withHarness(
  options: HarnessOptions,
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const harness = await startHarness(options);
  try {
    await run(harness);
  } finally {
    await harness.dispose();
  }
}

describe("the goal loop", () => {
  it("nudges a watched agent whose turn ended without a declared completion", async () => {
    await withHarness(
      { labels: { "paseo-acp-goal": "carry the task through" } },
      async (harness) => {
        await harness.turn(assistantTurn("I made some progress."));

        const sends = sendsFor(harness);
        assert.equal(sends.length, 1);
        const nudge = sends[0] ?? "";
        assert.match(nudge, /round 1\//, "the nudge carries its round");
        assert.match(nudge, /automated continuation/, "the nudge must not read as a new task");
        assert.match(nudge, /carry the task through/, "the nudge re-anchors the goal");
        assert.equal(harness.lastStatus()?.state, "running");
      },
    );
  });

  it("leaves an ACP agent alone until some goal exists", async () => {
    // Being an ACP agent makes an agent eligible; it does not create a goal. With no
    // label and no workspace file there is nothing to pursue, so nothing is spent —
    // the plugin never invents work for itself.
    await withHarness({}, async (harness) => {
      await harness.turn(assistantTurn("Just chatting."));
      assert.deepEqual(harness.recorded.sends, []);
      assert.equal(harness.lastStatus(), undefined);
    });
  });

  it("stops on the sentinel and records the goal as met", async () => {
    await withHarness({ labels: { "paseo-acp-goal": "finish the job" } }, async (harness) => {
      await harness.turn(assistantTurn("All done.\nGOAL_COMPLETE"));

      assert.deepEqual(harness.recorded.sends, []);
      const last = harness.lastStatus();
      assert.equal(last?.state, "completed");
      assert.equal(last?.reason, "sentinel");
    });
  });

  it("does not let a claim override a failing verification", async () => {
    await withHarness(
      { labels: { "paseo-acp-goal": "make it pass", "paseo-acp-goal-verify": "exit 1" } },
      async (harness) => {
        await harness.turn(assistantTurn("Everything is fine.\nGOAL_COMPLETE"));

        const sends = sendsFor(harness);
        assert.equal(sends.length, 1, "exit 1 means the loop continues");
        assert.match(sends[0] ?? "", /verification command failed/);
        assert.match(
          sends[0] ?? "",
          /\(no output\)/,
          "an exit code with no stdout is still reported",
        );
      },
    );
  });

  it("stops when the verification command passes, whatever the agent said", async () => {
    await withHarness(
      { labels: { "paseo-acp-goal": "make it pass", "paseo-acp-goal-verify": "exit 0" } },
      async (harness) => {
        await harness.turn(assistantTurn("I gave up."));

        assert.deepEqual(harness.recorded.sends, []);
        const last = harness.lastStatus();
        assert.equal(last?.state, "completed");
        assert.equal(last?.reason, "verify-passed");
      },
    );
  });

  it("honours the round ceiling", async () => {
    await withHarness(
      { labels: { "paseo-acp-goal": "never finishes", "paseo-acp-goal-max": "2" } },
      async (harness) => {
        await harness.turn(assistantTurn("attempt one"));
        await harness.turn(assistantTurn("attempt two"));
        await harness.turn(assistantTurn("attempt three"));

        assert.equal(sendsFor(harness).length, 2, "two nudges, then the ceiling");
        const last = harness.lastStatus();
        assert.equal(last?.state, "stopped");
        assert.equal(last?.reason, "max-rounds");
      },
    );
  });

  it("stops after two consecutive turns that moved nothing", async () => {
    await withHarness({ labels: { "paseo-acp-goal": "x" } }, async (harness) => {
      const repeated = assistantTurn("I cannot proceed without more information.");
      // The first turn establishes the baseline, so a repeated answer needs a third
      // turn before it is a stall rather than a coincidence.
      await harness.turn(repeated);
      await harness.turn(repeated);
      await harness.turn(repeated);

      const last = harness.lastStatus();
      assert.equal(last?.state, "stopped");
      assert.equal(last?.reason, "no-progress");
      assert.equal(sendsFor(harness).length, 2, "two nudges, then the stall was caught");
    });
  });

  it("enforces a token ceiling taken from the agent's own usage", async () => {
    await withHarness(
      { inputTokens: 400, outputTokens: 600, goalFile: { goal: "bounded", maxTokens: 900 } },
      async (harness) => {
        await harness.turn(assistantTurn("first"));
        assert.equal(
          harness.lastStatus()?.reason,
          "token-budget",
          "1200 tokens against a 900 ceiling",
        );
      },
    );
  });

  it("honours a token ceiling set by a label", async () => {
    // A label-driven setup is the one an operator reaches for first, so it must be
    // able to bound spend as well as rounds.
    await withHarness(
      {
        inputTokens: 300,
        outputTokens: 300,
        labels: { "paseo-acp-goal": "bounded from a label", "paseo-acp-goal-max-tokens": "500" },
      },
      async (harness) => {
        await harness.turn(assistantTurn("first"));
        assert.equal(harness.lastStatus()?.reason, "token-budget");
      },
    );
  });

  it("keeps the token spend across a goal change, so a rewritten goal cannot reset the budget", async () => {
    // The escape this closes: an agent with a self-declared goal rewrites its own goal
    // file and would otherwise be handed a fresh allowance for the same money.
    await withHarness(
      { inputTokens: 400, outputTokens: 200, goalFile: { goal: "first goal", maxTokens: 1000 } },
      async (harness) => {
        await harness.turn(assistantTurn("working on the first goal"));
        assert.equal(harness.lastStatus()?.state, "running", "600 of 1000 tokens spent");

        await harness.writeGoalFile({ goal: "second goal", maxTokens: 1000 });
        await harness.turn(assistantTurn("now a different goal"));

        assert.equal(
          harness.lastStatus()?.reason,
          "token-budget",
          "the spend carried: 1200 against the same 1000 ceiling",
        );
      },
    );
  });

  it("resets the round count when the goal changes, because a new goal is new work", async () => {
    await withHarness(
      { labels: {}, goalFile: { goal: "first", maxRounds: 1 } },
      async (harness) => {
        // One permitted round: the first nudge is round 1, the next turn is over.
        await harness.turn(assistantTurn("attempt one"));
        assert.equal(harness.lastStatus()?.reason, "continue");
        await harness.turn(assistantTurn("attempt two"));
        assert.equal(
          harness.lastStatus()?.reason,
          "max-rounds",
          "the first goal had exactly one round",
        );

        await harness.writeGoalFile({ goal: "second", maxRounds: 3 });
        await harness.turn(assistantTurn("a fresh attempt"));

        const last = harness.lastStatus();
        assert.equal(last?.state, "running", "the second goal has its own round budget");
        assert.equal(last?.reason, "continue");
        assert.equal(last?.round, 1, "counting from the start again");
      },
    );
  });

  it("lets an agent declare its own goal in the workspace", async () => {
    await withHarness({ goalFile: { goal: "write the migration" } }, async (harness) => {
      await harness.turn(assistantTurn("starting"));
      const last = harness.lastStatus();
      assert.equal(last?.source, "file");
      assert.equal(last?.goal, "write the migration");
    });
  });

  it("leaves a non-ACP agent alone unless a goal label asks for one", async () => {
    await withHarness({ acpProviders: ["other"] }, async (harness) => {
      await harness.turn(assistantTurn("done thinking"), { agentId: "agent-claude" });
      assert.deepEqual(harness.recorded.sends, []);
      assert.equal(harness.lastStatus("agent-claude"), undefined);
    });
  });

  it("drives a non-ACP agent that was explicitly labelled", async () => {
    await withHarness(
      { acpProviders: [], labels: { "paseo-acp-goal": "finite job" } },
      async (harness) => {
        await harness.turn(assistantTurn("still working"), { agentId: "agent-claude" });
        assert.equal(sendsFor(harness, "agent-claude").length, 1);
      },
    );
  });

  it("yields when a human interrupts", async () => {
    await withHarness({ labels: { "paseo-acp-goal": "x" } }, async (harness) => {
      await harness.turn(assistantTurn("stopping"), {
        outcome: { kind: "canceled", reason: "Interrupted" },
      });
      assert.deepEqual(harness.recorded.sends, []);
      const last = harness.lastStatus();
      assert.equal(last?.reason, "canceled");
      assert.equal(last?.detail, "Interrupted");
    });
  });

  it("pauses rather than nudging past a pending request", async () => {
    await withHarness(
      { labels: { "paseo-acp-goal": "x" }, pendingPermissions: 1 },
      async (harness) => {
        await harness.turn(assistantTurn("waiting on you"));
        assert.deepEqual(harness.recorded.sends, []);
        assert.equal(harness.lastStatus()?.reason, "permission-pending");
      },
    );
  });

  it("keeps a paused loop resumable, so answering a question does not reset its ceiling", async () => {
    await withHarness(
      { labels: { "paseo-acp-goal": "x", "paseo-acp-goal-max": "2" } },
      async (harness) => {
        await harness.turn(assistantTurn("work one"));
        await harness.turn(assistantTurn("work two"));
        assert.equal(sendsFor(harness).length, 2, "two rounds of the two permitted");

        await harness.turn(assistantTurn("Should I delete the branch?"));
        assert.equal(harness.lastStatus()?.reason, "question");
        assert.equal(sendsFor(harness).length, 2, "a question wants an answer, not a nudge");

        // The human answers. The preserved round count means the very next turn is over
        // the ceiling — had the record been dropped, this would have continued.
        await harness.turn(assistantTurn("answered, carrying on"));
        const last = harness.lastStatus();
        assert.equal(last?.state, "stopped");
        assert.equal(last?.reason, "max-rounds");
        assert.equal(sendsFor(harness).length, 2, "no nudge past the preserved ceiling");
      },
    );
  });

  it("does not retry a failed turn", async () => {
    await withHarness({ labels: { "paseo-acp-goal": "x" } }, async (harness) => {
      await harness.turn(assistantTurn(""), {
        outcome: { kind: "failed", error: { message: "rate limited" } },
      });
      assert.deepEqual(harness.recorded.sends, []);
      const last = harness.lastStatus();
      assert.equal(last?.reason, "failed");
      assert.equal(last?.detail, "rate limited");
    });
  });

  it("reports an archived agent and forgets its loop", async () => {
    await withHarness({ labels: { "paseo-acp-goal": "x" } }, async (harness) => {
      await harness.turn(assistantTurn("working"));
      await harness.archive();
      assert.equal(harness.lastStatus()?.reason, "agent-archived");
    });
  });
});

describe("duplicate and orphan events", () => {
  it("ignores a second turn_ended for a turn it already handled", async () => {
    await withHarness({ labels: { "paseo-acp-goal": "x" } }, async (harness) => {
      await harness.turn(assistantTurn("first attempt"));
      assert.equal(sendsFor(harness).length, 1);

      // The same turn's end, delivered twice, with no start in between.
      await harness.fire(assistantTurn("first attempt"));

      assert.equal(sendsFor(harness).length, 1, "a duplicate must not send a second nudge");
      assert.deepEqual(roundsFor(harness), [1], "and must not write a second status row either");
    });
  });

  it("honours a turn_ended for an agent whose start happened before the plugin loaded", async () => {
    // Failing open here is deliberate: silently dropping a real turn is worse than
    // one redundant nudge, and an agent may predate the plugin.
    await withHarness({ labels: { "paseo-acp-goal": "x" } }, async (harness) => {
      await harness.fire(assistantTurn("a turn nobody saw start"));
      assert.equal(sendsFor(harness).length, 1);

      // Once a boundary has been seen, an unsolicited end is a duplicate again.
      await harness.fire(assistantTurn("a turn nobody saw start"));
      assert.equal(sendsFor(harness).length, 1);
    });
  });

  it("lets a token be claimed once, so two agents in one directory cannot share a signal", async () => {
    await withHarness({ labels: { "paseo-acp-goal": "x" } }, async (harness) => {
      const created = await harness.create(createRequest(harness.dir));
      assert.ok(created);
      const { url } = injected(created);

      // Agent one claims the token through the working-directory fallback, because no
      // session ever bound it.
      await harness.turn(assistantTurn("agent one working"));
      assert.equal(harness.lastStatus(AGENT.id)?.state, "running");

      // A tool call arrives on that token afterwards.
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: 1,
          method: "tools/call",
          params: { name: "goal_complete", arguments: { summary: "not agent two's call" } },
        }),
      });

      // A second agent in the same directory must not be able to claim the same token
      // and consume a signal that was never addressed to it.
      await harness.turn(assistantTurn("agent two working"), { agentId: "agent-2" });
      assert.notEqual(
        harness.lastStatus("agent-2")?.reason,
        "tool-complete",
        "agent two must not inherit agent one's tool call",
      );
    });
  });
});

describe("verification is not run when it cannot change the outcome", () => {
  it("skips the command for an archived agent", async () => {
    await withHarness(
      {
        labels: { "paseo-acp-goal": "x", "paseo-acp-goal-verify": "echo ran > ran.txt" },
        archived: true,
      },
      async (harness) => {
        await harness.turn(assistantTurn("work"));
        assert.equal(harness.lastStatus()?.reason, "agent-archived");
        assert.equal(
          existsSync(path.join(harness.dir, "ran.txt")),
          false,
          "an archived agent must not trigger a verification command",
        );
      },
    );
  });

  it("runs the command for a live agent, so the skip is not a silent blanket", async () => {
    await withHarness(
      { labels: { "paseo-acp-goal": "x", "paseo-acp-goal-verify": "echo ran > ran.txt" } },
      async (harness) => {
        await harness.turn(assistantTurn("work"));
        assert.equal(
          existsSync(path.join(harness.dir, "ran.txt")),
          true,
          "a live turn must actually be measured",
        );
      },
    );
  });
});

describe("the goal tool round trip", () => {
  it("injects the goal tool and its token when a session is created", async () => {
    await withHarness({}, async (harness) => {
      const result = await harness.create(createRequest(harness.dir));
      assert.ok(result, "an ACP creation must be changed");

      const { url, token } = injected(result);
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[A-Za-z0-9_-]+$/);
      assert.equal(url.endsWith(token), true, "the URL must carry that token");
    });
  });

  it("carries a completion made through the tool into the next turn's decision", async () => {
    await withHarness({ labels: { "paseo-acp-goal": "finish the migration" } }, async (harness) => {
      const result = await harness.create(createRequest(harness.dir));
      assert.ok(result);
      const { url, token } = injected(result);

      // A session opens, binding the token to the agent, exactly as the daemon does
      // when it seeds the injected environment.
      harness.sessionOpen({
        agentId: AGENT.id,
        workspaceId: "ws-1",
        provider: "codewhale",
        cwd: harness.dir,
        reason: "create",
        purpose: "interactive",
        env: { [GOAL_ENV_TOKEN]: token },
      });

      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: 1,
          method: "tools/call",
          params: { name: "goal_complete", arguments: { summary: "finished the migration" } },
        }),
      });

      await harness.turn(assistantTurn("All set."));

      assert.deepEqual(harness.recorded.sends, []);
      const last = harness.lastStatus();
      assert.equal(last?.state, "completed");
      assert.equal(last?.reason, "tool-complete");
      assert.equal(last?.detail, "finished the migration");
    });
  });

  it("leaves a non-ACP creation untouched", async () => {
    await withHarness({ acpProviders: ["someone-else"] }, async (harness) => {
      const result = await harness.create(createRequest(harness.dir, "claude"));
      assert.equal(result, undefined);
    });
  });
});

describe("the goal-tool diagnostic", () => {
  it("says so once when an offered tool was never called", async () => {
    // This is the observed reality on an ACP provider that does not expose injected MCP
    // servers: the tool is offered, the agent never calls it, and the loop ends by
    // sentinel. The README points a reader at this line, so it has to exist.
    await withHarness({ labels: { "paseo-acp-goal": "x" } }, async (harness) => {
      await harness.create(createRequest(harness.dir));
      await harness.turn(assistantTurn("done\nGOAL_COMPLETE"));
      await harness.turn(assistantTurn("done again\nGOAL_COMPLETE"));

      const warnings = toolUnusedWarnings(harness);
      assert.equal(warnings.length, 1, "the diagnostic is said once, not on every turn");
      assert.match(warnings[0] ?? "", /may not expose injected MCP servers/);
    });
  });

  it("stays quiet when the agent did use the tool", async () => {
    await withHarness({ labels: { "paseo-acp-goal": "x" } }, async (harness) => {
      const created = await harness.create(createRequest(harness.dir));
      assert.ok(created);
      const { url, token } = injected(created);
      harness.sessionOpen({
        agentId: AGENT.id,
        workspaceId: "ws-1",
        provider: "codewhale",
        cwd: harness.dir,
        reason: "create",
        purpose: "interactive",
        env: { [GOAL_ENV_TOKEN]: token },
      });
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: 1,
          method: "tools/call",
          params: { name: "goal_complete", arguments: {} },
        }),
      });
      await harness.turn(assistantTurn("all done"));

      assert.equal(toolUnusedWarnings(harness).length, 0, "a tool that worked needs no diagnostic");
    });
  });

  it("stays quiet for an agent that never had the tool injected", async () => {
    await withHarness({ acpProviders: [], labels: { "paseo-acp-goal": "x" } }, async (harness) => {
      await harness.turn(assistantTurn("done\nGOAL_COMPLETE"));
      assert.equal(
        toolUnusedWarnings(harness).length,
        0,
        "an agent that was never offered the tool has nothing to warn about",
      );
    });
  });
});

describe("accounting expiry", () => {
  it("forgets a loop whose accounting has expired, so the next turn starts fresh", async () => {
    // The sweep is the same code the interval calls; this exercises it through the
    // sweep that runs at creation, which is deterministic and needs no sleeping.
    await withHarness(
      { labels: { "paseo-acp-goal": "x", "paseo-acp-goal-max": "5" }, recordTtlMs: 0 },
      async (harness) => {
        await harness.turn(assistantTurn("one"));
        await harness.turn(assistantTurn("two"));
        assert.equal(harness.lastStatus()?.round, 2);

        // A creation triggers the sweep, which expires the idle record.
        await harness.create(createRequest(harness.dir));
        await harness.turn(assistantTurn("three"));

        assert.equal(harness.lastStatus()?.round, 1, "the expired accounting was forgotten");
      },
    );
  });
});
