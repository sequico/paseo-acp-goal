import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildGoalRows, type AdminAgent } from "../server/goal-admin";
import type { Goal } from "../server/goal-source";
import type { LoopRecord } from "../server/store";

/**
 * The ACP goals screen's view, tested as a pure function.
 *
 * Every question the screen asks — what to show, what is editable, what order to show
 * it in — is answered here from data, so the answers are checkable without a daemon,
 * an app, or a React renderer. The screen is the part that cannot be tested this way;
 * this is everything it depends on.
 */

function agent(overrides: Partial<AdminAgent> & { agentId: string }): AdminAgent {
  return {
    title: `Agent ${overrides.agentId}`,
    provider: "codewhale",
    status: "idle",
    labels: {},
    archived: false,
    ...overrides,
  };
}

function uiGoal(text: string): Goal {
  return {
    goal: text,
    verify: null,
    maxRounds: 8,
    sentinel: "GOAL_COMPLETE",
    maxTokens: null,
    source: "ui",
  };
}

function record(overrides: Partial<LoopRecord> & { agentId: string }): LoopRecord {
  return {
    goal: uiGoal("a goal"),
    round: 0,
    noProgressStreak: 0,
    lastTextDigest: null,
    tokensUsed: 0,
    lastOutcome: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const eligibleEverywhere = () => true;
const eligibleNowhere = () => false;

function rows(
  agents: AdminAgent[],
  options: {
    loops?: Map<string, LoopRecord>;
    completed?: Map<string, LoopRecord>;
    uiGoals?: Map<string, Goal>;
    isEligible?: (provider: string, labels: Record<string, string>) => boolean;
  } = {},
) {
  return buildGoalRows({
    agents,
    loops: options.loops ?? new Map(),
    completedLoops: options.completed ?? new Map(),
    uiGoals: options.uiGoals ?? new Map(),
    isEligible: options.isEligible ?? eligibleEverywhere,
  });
}

describe("buildGoalRows", () => {
  it("hides an agent that is neither eligible nor carrying a goal", () => {
    // On a busy daemon, listing every agent would bury the ones this screen exists for.
    const result = rows([agent({ agentId: "a" }), agent({ agentId: "b" })], {
      isEligible: eligibleNowhere,
    });
    assert.deepEqual(result, []);
  });

  it("shows an eligible agent before it has a goal, so one can be set", () => {
    const result = rows([agent({ agentId: "a", title: "Fresh" })]);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.goal, null);
    assert.equal(result[0]?.eligible, true);
    assert.equal(result[0]?.editable, true);
    assert.equal(result[0]?.state, null);
  });

  it("shows an ineligible agent that already carries a goal", () => {
    // A labelled non-ACP agent is watched on purpose, so the screen must not hide it.
    const result = rows([agent({ agentId: "a", provider: "claude" })], {
      uiGoals: new Map([["a", uiGoal("labelled work")]]),
      isEligible: eligibleNowhere,
    });
    assert.equal(result.length, 1);
    assert.equal(result[0]?.goal, "labelled work");
    assert.equal(result[0]?.eligible, false);
  });

  it("prefers a freshly set UI goal over the live loop's older goal", () => {
    // Transient and deliberate: a human who has just replaced the goal should see the
    // goal they typed, not the one still running. The record catches up on the next
    // turn, when `recordFor` sees a changed goal and rebuilds it.
    const result = rows([agent({ agentId: "a" })], {
      loops: new Map([["a", record({ agentId: "a", goal: uiGoal("previous goal"), round: 3 })]]),
      uiGoals: new Map([["a", uiGoal("just typed")]]),
    });
    assert.equal(result[0]?.goal, "just typed");
  });

  it("falls back to the live loop's goal when no human goal is set", () => {
    const result = rows([agent({ agentId: "a" })], {
      loops: new Map([
        [
          "a",
          record({ agentId: "a", goal: { ...uiGoal("running goal"), source: "file" }, round: 3 }),
        ],
      ]),
    });
    assert.equal(result[0]?.goal, "running goal");
    assert.equal(result[0]?.round, 3);
    assert.equal(result[0]?.state, "running");
  });

  it("reports how a finished loop ended, from the record rather than the transcript", () => {
    const result = rows([agent({ agentId: "a" })], {
      completed: new Map([
        [
          "a",
          record({
            agentId: "a",
            goal: { ...uiGoal("finished goal"), source: "ui" },
            lastOutcome: { state: "completed", reason: "verify-passed" },
          }),
        ],
      ]),
      uiGoals: new Map([["a", uiGoal("finished goal")]]),
    });
    assert.equal(result[0]?.state, "completed");
    assert.equal(result[0]?.reason, "verify-passed");
  });

  it("marks a labelled goal read-only, because a label is not the screen's to clear", () => {
    // The label lives on the agent, so the screen knows who owns the goal without any
    // loop having acted yet — while a live loop is running.
    const result = rows([agent({ agentId: "a", labels: { "paseo-acp-goal": "from a label" } })], {
      loops: new Map([
        ["a", record({ agentId: "a", goal: { ...uiGoal("from a label"), source: "label" } })],
      ]),
    });
    assert.equal(result[0]?.goal, "from a label");
    assert.equal(result[0]?.source, "label");
    assert.equal(result[0]?.editable, false);
  });

  it("still knows a label owns the goal after its loop has ended", () => {
    // The record is gone by then, so the label is the only thing left that says who
    // owns this goal — and the screen must not offer to clear it.
    const result = rows([agent({ agentId: "a", labels: { "paseo-acp-goal": "from a label" } })], {
      completed: new Map([
        [
          "a",
          record({
            agentId: "a",
            goal: { ...uiGoal("from a label"), source: "label" },
            lastOutcome: { state: "stopped", reason: "max-rounds" },
          }),
        ],
      ]),
    });
    assert.equal(result[0]?.source, "label");
    assert.equal(result[0]?.editable, false);
    assert.equal(result[0]?.state, "stopped");
    assert.equal(result[0]?.reason, "max-rounds");
  });

  it("marks a self-declared and a UI goal editable", () => {
    const result = rows([agent({ agentId: "file" }), agent({ agentId: "ui" })], {
      loops: new Map([
        ["file", record({ agentId: "file", goal: { ...uiGoal("mine"), source: "file" } })],
        ["ui", record({ agentId: "ui", goal: uiGoal("theirs") })],
      ]),
    });
    assert.deepEqual(
      result.map((row) => row.editable),
      [true, true],
    );
  });

  it("puts rows with a goal first, then orders by title", () => {
    const result = rows(
      [
        agent({ agentId: "z", title: "Zeta" }),
        agent({ agentId: "m", title: "Mu" }),
        agent({ agentId: "a", title: "Alpha" }),
      ],
      { uiGoals: new Map([["m", uiGoal("has work")]]) },
    );
    assert.deepEqual(
      result.map((row) => row.title),
      ["Mu", "Alpha", "Zeta"],
      "the actionable row leads, then the rest read in order",
    );
  });

  it("falls back to the agent id when a title is missing", () => {
    const result = rows([
      agent({ agentId: "b", title: null }),
      agent({ agentId: "a", title: null }),
    ]);
    assert.deepEqual(
      result.map((row) => row.agentId),
      ["a", "b"],
    );
  });

  it("carries the verification command through from whichever goal owns it", () => {
    const result = rows([agent({ agentId: "a" })], {
      uiGoals: new Map([["a", { ...uiGoal("with a command"), verify: "npm test" }]]),
    });
    assert.equal(result[0]?.verify, "npm test");
  });
});
