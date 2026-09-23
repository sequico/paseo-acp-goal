import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_MAX_ROUNDS,
  DEFAULT_SENTINEL,
  MAX_ROUNDS_CEILING,
  fileDeclaresDone,
  goalFromLabels,
  goalFromUiInput,
  parseGoalFile,
  resolveGoal,
} from "../server/goal-source";

describe("goalFromLabels", () => {
  it("reads a goal, a verification command, a ceiling, and a sentinel", () => {
    const goal = goalFromLabels({
      "paseo-acp-goal": "  make the failing test pass  ",
      "paseo-acp-goal-verify": "npm test",
      "paseo-acp-goal-max": "3",
      "paseo-acp-goal-done": "DONE",
    });
    assert.deepEqual(goal, {
      goal: "make the failing test pass",
      verify: "npm test",
      maxRounds: 3,
      sentinel: "DONE",
      maxTokens: null,
      source: "label",
    });
  });

  it("returns null when there is no goal label", () => {
    assert.equal(goalFromLabels({}), null);
    assert.equal(goalFromLabels(null), null);
    assert.equal(goalFromLabels({ "paseo-acp-goal": "   " }), null);
  });

  it("falls back to the default round ceiling and sentinel", () => {
    const goal = goalFromLabels({ "paseo-acp-goal": "ship it" });
    assert.equal(goal?.maxRounds, DEFAULT_MAX_ROUNDS);
    assert.equal(goal?.sentinel, DEFAULT_SENTINEL);
    assert.equal(goal?.verify, null);
  });

  it("clamps nonsense ceilings instead of trusting them", () => {
    assert.equal(
      goalFromLabels({ "paseo-acp-goal": "x", "paseo-acp-goal-max": "0" })?.maxRounds,
      DEFAULT_MAX_ROUNDS,
    );
    assert.equal(
      goalFromLabels({ "paseo-acp-goal": "x", "paseo-acp-goal-max": "abc" })?.maxRounds,
      DEFAULT_MAX_ROUNDS,
    );
    assert.equal(
      goalFromLabels({ "paseo-acp-goal": "x", "paseo-acp-goal-max": "-4" })?.maxRounds,
      DEFAULT_MAX_ROUNDS,
    );
    assert.equal(
      goalFromLabels({ "paseo-acp-goal": "x", "paseo-acp-goal-max": "9999" })?.maxRounds,
      MAX_ROUNDS_CEILING,
    );
  });
});

describe("parseGoalFile", () => {
  it("reads the fields an agent may write", () => {
    const parsed = parseGoalFile(
      JSON.stringify({
        goal: "fix the flaky test",
        verify: "npm test",
        maxRounds: 4,
        maxTokens: 5000,
        done: true,
        note: "one assertion left",
      }),
    );
    assert.deepEqual(parsed, {
      goal: "fix the flaky test",
      verify: "npm test",
      maxRounds: 4,
      maxTokens: 5000,
      done: true,
      note: "one assertion left",
    });
  });

  it("ignores a malformed file rather than failing the turn", () => {
    assert.equal(parseGoalFile("{ not json"), null);
    assert.equal(parseGoalFile("[]"), null);
    assert.equal(parseGoalFile("null"), null);
    assert.equal(parseGoalFile('"a string"'), null);
  });

  it("drops fields of the wrong type", () => {
    assert.deepEqual(parseGoalFile(JSON.stringify({ goal: 7, verify: 7, done: "yes" })), {});
  });
});

describe("resolveGoal", () => {
  const noUi = null;

  it("lets a label define the goal", () => {
    const goal = resolveGoal({ "paseo-acp-goal": "from the label" }, noUi, null);
    assert.equal(goal?.goal, "from the label");
    assert.equal(goal?.source, "label");
  });

  it("lets an agent declare its own goal when nobody set one", () => {
    const goal = resolveGoal(null, noUi, { goal: "from the file", verify: "npm test" });
    assert.equal(goal?.goal, "from the file");
    assert.equal(goal?.verify, "npm test");
    assert.equal(goal?.source, "file");
  });

  it("returns null when no channel has a goal", () => {
    assert.equal(resolveGoal({}, noUi, null), null);
    assert.equal(resolveGoal({}, noUi, {}), null);
    assert.equal(resolveGoal(null, noUi, null), null);
  });

  it("refuses to let the file rewrite a labelled goal, the command, or the ceiling", () => {
    // An agent that could narrow its own goal or drop its own verification would be
    // able to declare victory by editing a file. The label is the fence.
    const goal = resolveGoal(
      {
        "paseo-acp-goal": "the real goal",
        "paseo-acp-goal-verify": "npm test",
        "paseo-acp-goal-max": "10",
      },
      noUi,
      { goal: "something trivial", verify: "true", maxRounds: 1, done: true },
    );
    assert.equal(goal?.goal, "the real goal");
    assert.equal(goal?.verify, "npm test");
    assert.equal(goal?.maxRounds, 10);
    assert.equal(goal?.source, "label");
  });

  it("lets a UI goal beat the agent's own file", () => {
    // A human's instruction is not the agent's to override, for the same reason a
    // label is not.
    const goal = resolveGoal(
      null,
      {
        goal: "what the human asked for",
        verify: "npm test",
        maxRounds: 5,
        sentinel: "GOAL_COMPLETE",
        maxTokens: null,
        source: "ui",
      },
      { goal: "something the agent preferred", verify: "true", maxRounds: 1 },
    );
    assert.equal(goal?.goal, "what the human asked for");
    assert.equal(goal?.verify, "npm test");
    assert.equal(goal?.maxRounds, 5);
    assert.equal(goal?.source, "ui");
  });

  it("lets a launch label beat a UI goal, because the label is the orchestration", () => {
    const goal = resolveGoal(
      { "paseo-acp-goal": "from the orchestrator" },
      {
        goal: "from the screen",
        verify: null,
        maxRounds: 3,
        sentinel: "GOAL_COMPLETE",
        maxTokens: null,
        source: "ui",
      },
      null,
    );
    assert.equal(goal?.goal, "from the orchestrator");
    assert.equal(goal?.source, "label");
  });

  it("still lets the file report completion under a labelled goal", () => {
    const file = parseGoalFile(JSON.stringify({ done: true, note: "finished" }));
    assert.equal(fileDeclaresDone(file), true);
    assert.equal(fileDeclaresDone(null), false);
    assert.equal(fileDeclaresDone({ goal: "x" }), false);
  });
});

describe("goalFromUiInput", () => {
  it("builds a UI goal with the defaults filled in", () => {
    const goal = goalFromUiInput({ goal: "  ship the migration  " });
    assert.equal(goal?.goal, "ship the migration");
    assert.equal(goal?.source, "ui");
    assert.equal(goal?.verify, null);
    assert.equal(goal?.maxRounds, DEFAULT_MAX_ROUNDS);
    assert.equal(goal?.maxTokens, null);
    assert.equal(goal?.sentinel, DEFAULT_SENTINEL);
  });

  it("carries what the screen asked for", () => {
    const goal = goalFromUiInput({
      goal: "make the suite pass",
      verify: "npm test",
      maxRounds: 4,
      maxTokens: 50_000,
    });
    assert.equal(goal?.verify, "npm test");
    assert.equal(goal?.maxRounds, 4);
    assert.equal(goal?.maxTokens, 50_000);
  });

  it("treats an empty verification field as no command", () => {
    // A form sends what it has; clearing the field must clear the command rather than
    // install one that runs the empty string.
    assert.equal(goalFromUiInput({ goal: "x", verify: "   " })?.verify, null);
  });

  it("refuses a goal with no text", () => {
    assert.equal(goalFromUiInput({ goal: "   " }), null);
  });

  it("clamps a ceiling the form could have typed wrong", () => {
    assert.equal(goalFromUiInput({ goal: "x", maxRounds: 0 })?.maxRounds, 1);
    assert.equal(goalFromUiInput({ goal: "x", maxRounds: 9_999 })?.maxRounds, MAX_ROUNDS_CEILING);
    assert.equal(goalFromUiInput({ goal: "x", maxRounds: 3.7 })?.maxRounds, 3);
  });

  it("drops a token ceiling that is not a positive number", () => {
    assert.equal(goalFromUiInput({ goal: "x", maxTokens: 0 })?.maxTokens, null);
    assert.equal(goalFromUiInput({ goal: "x", maxTokens: -5 })?.maxTokens, null);
  });
});
