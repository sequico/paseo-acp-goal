import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_MAX_ROUNDS,
  DEFAULT_SENTINEL,
  MAX_ROUNDS_CEILING,
  fileDeclaresDone,
  goalFromLabels,
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
  it("lets a label define the goal", () => {
    const goal = resolveGoal({ "paseo-acp-goal": "from the label" }, null);
    assert.equal(goal?.goal, "from the label");
    assert.equal(goal?.source, "label");
  });

  it("lets an agent declare its own goal when nobody set one", () => {
    const goal = resolveGoal(null, { goal: "from the file", verify: "npm test" });
    assert.equal(goal?.goal, "from the file");
    assert.equal(goal?.verify, "npm test");
    assert.equal(goal?.source, "file");
  });

  it("returns null when neither channel has a goal", () => {
    assert.equal(resolveGoal({}, null), null);
    assert.equal(resolveGoal({}, {}), null);
    assert.equal(resolveGoal(null, null), null);
  });

  it("refuses to let the file rewrite a labelled goal, the command, or the ceiling", () => {
    // An agent that could narrow its own goal or drop its own verification would
    // be able to declare victory by editing a file. The label is the fence.
    const goal = resolveGoal(
      {
        "paseo-acp-goal": "the real goal",
        "paseo-acp-goal-verify": "npm test",
        "paseo-acp-goal-max": "10",
      },
      { goal: "something trivial", verify: "true", maxRounds: 1, done: true },
    );
    assert.equal(goal?.goal, "the real goal");
    assert.equal(goal?.verify, "npm test");
    assert.equal(goal?.maxRounds, 10);
    assert.equal(goal?.source, "label");
  });

  it("still lets the file report completion under a labelled goal", () => {
    const file = parseGoalFile(JSON.stringify({ done: true, note: "finished" }));
    assert.equal(fileDeclaresDone(file), true);
    assert.equal(fileDeclaresDone(null), false);
    assert.equal(fileDeclaresDone({ goal: "x" }), false);
  });
});
