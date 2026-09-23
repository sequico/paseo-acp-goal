import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GOAL_SOURCE_LABEL, goalSourceSchema } from "../shared/goal-status";

/**
 * The transcript's word for each goal source.
 *
 * This is a table of cases rather than a rendered component because the bug it guards
 * was not a rendering bug: the badge used to test for `file` and call everything else a
 * launch label, so a goal a human set on the ACP goals screen was reported in a
 * transcript as one an orchestrator had set. A source the plugin can produce needs a
 * word, and it needs its own.
 */

describe("GOAL_SOURCE_LABEL", () => {
  it("names every source the vocabulary defines, and nothing the vocabulary does not", () => {
    assert.deepEqual(
      Object.keys(GOAL_SOURCE_LABEL).sort(),
      [...goalSourceSchema.options].sort(),
      "a source with no word renders as `undefined` in the badge",
    );
  });

  it("gives every source a word of its own", () => {
    const labels = Object.values(GOAL_SOURCE_LABEL);

    assert.equal(
      new Set(labels).size,
      labels.length,
      "two sources sharing a word is how a UI goal came to be shown as a label",
    );
    for (const label of labels) {
      assert.ok(label.trim().length > 0, "an empty label leaves the badge with a bare separator");
    }
  });
});
