import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { PaseoApi } from "../server/host-types";
import type { AgentTimelineItem } from "../server/host-types";
import type { PluginHookAgent } from "@getpaseo/plugin/server";
import type { GoalStatus } from "../shared/goal-status";
import type { GoalAgentGateway, GoalAgentSnapshot } from "../server/gateway";
import { GOAL_ENV_TOKEN, registerGoalLoop } from "../server/loop";
import type {
  ArchivedEvent,
  CreateRequest,
  GoalLoopHost,
  HookContext,
  SessionOpenRequest,
  TurnEndedEvent,
} from "../server/plugin-host";

/**
 * The loop driven end to end, with its two real dependencies supplied as data.
 *
 * The loop declares small interfaces for exactly this: the four host hooks it
 * uses and the three gateway operations it performs. So the whole safety story is
 * exercised without a daemon, an agent, or a fake framework — while the
 * verification command still runs for real, because that boundary is the one
 * worth paying for.
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
  sends: string[];
  statuses: GoalStatus[];
}

interface HarnessOptions {
  labels?: Record<string, string>;
  acpProviders?: string[];
  inputTokens?: number;
  outputTokens?: number;
  pendingPermissions?: number;
  archived?: boolean;
  provider?: string;
  goalFile?: Record<string, unknown>;
}

interface Harness {
  readonly dir: string;
  readonly recorded: Recorded;
  fire: (timeline: AgentTimelineItem[], outcome?: TurnEndedEvent["outcome"]) => Promise<void>;
  archive: () => Promise<void>;
  create: (request: CreateRequest) => Promise<CreateRequest | undefined>;
  sessionOpen: (request: SessionOpenRequest) => void;
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
  const recorded: Recorded = { sends: [], statuses: [] };

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

  if (options.goalFile !== undefined) {
    await writeFile(path.join(dir, ".acp-goal.json"), JSON.stringify(options.goalFile));
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
    send: async (_agentId, text) => {
      recorded.sends.push(text);
    },
    writeStatus: async (_agentId, status) => {
      recorded.statuses.push(status);
    },
  };

  let turnEnded: ((event: TurnEndedEvent, context: HookContext) => void) | null = null;
  let archived: ((event: ArchivedEvent, context: HookContext) => void) | null = null;
  let create: ((request: CreateRequest) => Promise<CreateRequest | undefined>) | null = null;
  let sessionOpen: ((request: SessionOpenRequest) => void) | null = null;

  const host: GoalLoopHost = {
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

  const dispose = registerGoalLoop(host, {
    version: "0.0.0-test",
    configPath,
    stateDirectory: path.join(dir, "state"),
    gateway: () => gateway,
  });

  // Every hook detaches, because a verification command may run for minutes. The
  // events used here are trivial, so draining the microtask and immediate queues is
  // enough; the alternative is an arbitrary sleep, which is a flaky test.
  const drain = async (): Promise<void> => {
    for (let step = 0; step < 50; step += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  // The loop never dereferences this handle: the injected gateway factory replaces
  // the daemon entirely, which is what the factory option exists for.
  const unusedPaseo = {} as PaseoApi;
  const context: HookContext = { paseo: unusedPaseo };

  return {
    dir,
    recorded,
    async fire(timeline, outcome = { kind: "completed" }) {
      assert.ok(turnEnded, "the loop must register a turn-ended handler");
      turnEnded(
        {
          agent: { ...AGENT, provider: options.provider ?? AGENT.provider, cwd: dir },
          outcome,
          timeline,
        },
        context,
      );
      await drain();
    },
    async archive() {
      assert.ok(archived, "the loop must register an archived handler");
      archived({ agent: { ...AGENT, cwd: dir } }, context);
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
      await dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function createRequest(dir: string, provider = "codewhale"): CreateRequest {
  return { config: { provider, cwd: dir } as CreateRequest["config"] };
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
        await harness.fire(assistantTurn("I made some progress."));

        assert.equal(harness.recorded.sends.length, 1);
        const nudge = harness.recorded.sends[0] ?? "";
        assert.match(nudge, /round 1\//, "the nudge carries its round");
        assert.match(nudge, /automated continuation/, "the nudge must not read as a new task");
        assert.match(nudge, /carry the task through/, "the nudge re-anchors the goal");
        assert.equal(harness.recorded.statuses.at(-1)?.state, "running");
      },
    );
  });

  it("leaves an ACP agent alone until some goal exists", async () => {
    // Being an ACP agent makes an agent eligible; it does not create a goal. With
    // no label and no workspace file there is nothing to pursue, so nothing is
    // spent — the plugin never invents work for itself.
    await withHarness({}, async (harness) => {
      await harness.fire(assistantTurn("Just chatting."));
      assert.deepEqual(harness.recorded.sends, []);
      assert.deepEqual(harness.recorded.statuses, []);
    });
  });

  it("stops on the sentinel and records the goal as met", async () => {
    await withHarness({ labels: { "paseo-acp-goal": "finish the job" } }, async (harness) => {
      await harness.fire(assistantTurn("All done.\nGOAL_COMPLETE"));

      assert.deepEqual(harness.recorded.sends, []);
      const last = harness.recorded.statuses.at(-1);
      assert.equal(last?.state, "completed");
      assert.equal(last?.reason, "sentinel");
    });
  });

  it("feeds a failed verification back, even when the command printed nothing", async () => {
    await withHarness(
      { labels: { "paseo-acp-goal": "make it pass", "paseo-acp-goal-verify": "exit 1" } },
      async (harness) => {
        await harness.fire(assistantTurn("Everything is fine.\nGOAL_COMPLETE"));

        assert.equal(harness.recorded.sends.length, 1, "exit 1 means the loop continues");
        const nudge = harness.recorded.sends[0] ?? "";
        assert.match(nudge, /verification command failed/);
        assert.match(nudge, /\(no output\)/, "an exit code with no stdout is still reported");
      },
    );
  });

  it("stops when the verification command passes, whatever the agent said", async () => {
    await withHarness(
      { labels: { "paseo-acp-goal": "make it pass", "paseo-acp-goal-verify": "exit 0" } },
      async (harness) => {
        await harness.fire(assistantTurn("I gave up."));

        assert.deepEqual(harness.recorded.sends, []);
        const last = harness.recorded.statuses.at(-1);
        assert.equal(last?.state, "completed");
        assert.equal(last?.reason, "verify-passed");
      },
    );
  });

  it("honours the round ceiling", async () => {
    await withHarness(
      { labels: { "paseo-acp-goal": "never finishes", "paseo-acp-goal-max": "2" } },
      async (harness) => {
        await harness.fire(assistantTurn("attempt one"));
        await harness.fire(assistantTurn("attempt two"));
        await harness.fire(assistantTurn("attempt three"));

        assert.equal(harness.recorded.sends.length, 2, "two nudges, then the ceiling");
        const last = harness.recorded.statuses.at(-1);
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
      await harness.fire(repeated);
      await harness.fire(repeated);
      await harness.fire(repeated);

      const last = harness.recorded.statuses.at(-1);
      assert.equal(last?.state, "stopped");
      assert.equal(last?.reason, "no-progress");
      assert.equal(harness.recorded.sends.length, 2, "two nudges, then the stall was caught");
    });
  });

  it("enforces a token ceiling read from the agent's own usage", async () => {
    await withHarness(
      { inputTokens: 400, outputTokens: 600, goalFile: { goal: "bounded", maxTokens: 900 } },
      async (harness) => {
        await harness.fire(assistantTurn("first"));
        await harness.fire(assistantTurn("second"));

        const last = harness.recorded.statuses.at(-1);
        assert.equal(last?.reason, "token-budget", "1200 tokens in one turn against a 900 ceiling");
      },
    );
  });

  it("lets an agent declare its own goal in the workspace", async () => {
    await withHarness({ goalFile: { goal: "write the migration" } }, async (harness) => {
      await harness.fire(assistantTurn("starting"));
      const last = harness.recorded.statuses.at(-1);
      assert.equal(last?.source, "file");
      assert.equal(last?.goal, "write the migration");
    });
  });

  it("leaves a non-ACP agent alone unless a goal label asks for one", async () => {
    await withHarness({ acpProviders: ["other"], provider: "claude" }, async (harness) => {
      await harness.fire(assistantTurn("done thinking"));
      assert.deepEqual(harness.recorded.sends, []);
      assert.deepEqual(harness.recorded.statuses, []);
    });
  });

  it("drives a non-ACP agent that was explicitly labelled", async () => {
    await withHarness(
      { acpProviders: [], provider: "claude", labels: { "paseo-acp-goal": "finite job" } },
      async (harness) => {
        await harness.fire(assistantTurn("still working"));
        assert.equal(harness.recorded.sends.length, 1);
      },
    );
  });

  it("yields when a human interrupts", async () => {
    await withHarness({ labels: { "paseo-acp-goal": "x" } }, async (harness) => {
      await harness.fire(assistantTurn("stopping"), { kind: "canceled", reason: "Interrupted" });
      assert.deepEqual(harness.recorded.sends, []);
      const last = harness.recorded.statuses.at(-1);
      assert.equal(last?.reason, "canceled");
      assert.equal(last?.detail, "Interrupted");
    });
  });

  it("pauses rather than nudging past a pending request", async () => {
    await withHarness(
      { labels: { "paseo-acp-goal": "x" }, pendingPermissions: 1 },
      async (harness) => {
        await harness.fire(assistantTurn("waiting on you"));
        assert.deepEqual(harness.recorded.sends, []);
        assert.equal(harness.recorded.statuses.at(-1)?.reason, "permission-pending");
      },
    );
  });

  it("keeps a paused loop resumable, so answering a question does not reset its ceiling", async () => {
    await withHarness(
      { labels: { "paseo-acp-goal": "x", "paseo-acp-goal-max": "2" } },
      async (harness) => {
        await harness.fire(assistantTurn("work one"));
        await harness.fire(assistantTurn("work two"));
        assert.equal(harness.recorded.sends.length, 2, "two rounds of the two permitted");

        // A question pauses at the ceiling instead of consuming it.
        await harness.fire(assistantTurn("Should I delete the branch?"));
        assert.equal(harness.recorded.statuses.at(-1)?.reason, "question");
        assert.equal(harness.recorded.sends.length, 2, "a question wants an answer, not a nudge");

        // The human answers. The preserved round count means the very next turn is
        // over the ceiling — had the record been dropped, this would have continued.
        await harness.fire(assistantTurn("answered, carrying on"));
        const last = harness.recorded.statuses.at(-1);
        assert.equal(last?.state, "stopped");
        assert.equal(last?.reason, "max-rounds");
        assert.equal(harness.recorded.sends.length, 2, "no nudge past the preserved ceiling");
      },
    );
  });

  it("does not retry a failed turn", async () => {
    await withHarness({ labels: { "paseo-acp-goal": "x" } }, async (harness) => {
      await harness.fire(assistantTurn(""), { kind: "failed", error: { message: "rate limited" } });
      assert.deepEqual(harness.recorded.sends, []);
      const last = harness.recorded.statuses.at(-1);
      assert.equal(last?.reason, "failed");
      assert.equal(last?.detail, "rate limited");
    });
  });

  it("reports an archived agent and forgets its loop", async () => {
    await withHarness({ labels: { "paseo-acp-goal": "x" } }, async (harness) => {
      await harness.fire(assistantTurn("working"));
      await harness.archive();
      assert.equal(harness.recorded.statuses.at(-1)?.reason, "agent-archived");
    });
  });

  it("injects the goal tool and its token when a session is created", async () => {
    await withHarness({}, async (harness) => {
      const result = await harness.create(createRequest(harness.dir));
      assert.ok(result, "an ACP creation must be changed");

      const server = result.config.mcpServers?.["paseo-acp-goal"];
      assert.equal(server?.type, "http");
      const url = server?.type === "http" ? server.url : null;
      assert.match(url ?? "", /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[A-Za-z0-9_-]+$/);

      const token = result.env?.[GOAL_ENV_TOKEN];
      assert.equal(typeof token, "string");
      assert.equal(url?.endsWith(token ?? ""), true, "the URL must carry that token");
    });
  });

  it("carries a completion made through the tool into the next turn's decision", async () => {
    await withHarness({ labels: { "paseo-acp-goal": "finish the migration" } }, async (harness) => {
      const result = await harness.create(createRequest(harness.dir));
      assert.ok(result);
      const server = result.config.mcpServers?.["paseo-acp-goal"];
      const url = server?.type === "http" ? server.url : null;
      const token = result.env?.[GOAL_ENV_TOKEN];
      assert.ok(url && token);

      // The session opens, binding the token to the agent, exactly as the daemon
      // does when it seeds the injected environment.
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

      await harness.fire(assistantTurn("All set."));

      assert.deepEqual(harness.recorded.sends, []);
      const last = harness.recorded.statuses.at(-1);
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
