import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentTimelineItem } from "../server/host-types";
import {
  containsLine,
  endsWithQuestion,
  madeProgress,
  turnDigest,
  turnTail,
} from "../server/inspect";

function turn(items: AgentTimelineItem[]): AgentTimelineItem[] {
  return items;
}

describe("turnTail", () => {
  it("counts only what happened after the last user message", () => {
    const timeline = turn([
      { type: "user_message", text: "first prompt" },
      { type: "assistant_message", text: "old answer" },
      {
        type: "tool_call",
        callId: "1",
        name: "read",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "ls" },
      },
      { type: "user_message", text: "second prompt" },
      { type: "assistant_message", text: "new answer" },
    ]);

    const tail = turnTail(timeline);
    assert.equal(tail.text.includes("new answer"), true);
    assert.equal(tail.text.includes("old answer"), false, "a previous turn must not leak in");
    assert.equal(tail.toolCalls, 0, "a tool call from a previous turn is not this turn's progress");
  });

  it("reads the whole conversation when no user message is present", () => {
    const tail = turnTail([{ type: "assistant_message", text: "only output" }]);
    assert.equal(tail.text.trim(), "only output");
  });

  it("counts tool calls as progress", () => {
    const tail = turnTail([
      { type: "user_message", text: "go" },
      {
        type: "tool_call",
        callId: "1",
        name: "read",
        status: "running",
        error: null,
        detail: { type: "shell", command: "ls" },
      },
      {
        type: "tool_call",
        callId: "2",
        name: "edit",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "true" },
      },
    ]);
    assert.equal(tail.toolCalls, 2);
  });

  it("ignores rows an agent did not author", () => {
    const tail = turnTail([
      { type: "user_message", text: "go" },
      { type: "error", message: "boom" },
      { type: "notification", level: "warning", message: "careful" },
      { type: "compaction", status: "completed" },
      { type: "todo", items: [{ text: "step", completed: false }] },
      { type: "assistant_message", text: "real work" },
    ]);
    assert.equal(tail.text.includes("real work"), true);
    assert.equal(tail.text.includes("boom"), false);
    assert.equal(tail.text.includes("careful"), false);
  });
});

describe("endsWithQuestion", () => {
  it("reads a trailing question as a request for a human", () => {
    assert.equal(endsWithQuestion("Done with step one.\n\nShould I delete the branch?"), true);
    assert.equal(endsWithQuestion("Should I delete the branch?  "), true);
  });

  it("does not fire on prose that merely contains a question mark", () => {
    assert.equal(endsWithQuestion("Why did that fail? I fixed it and continued."), false);
    assert.equal(endsWithQuestion("Finished."), false);
    assert.equal(endsWithQuestion("   "), false);
    assert.equal(endsWithQuestion(""), false);
  });
});

describe("madeProgress", () => {
  it("counts a tool call as progress even with no text", () => {
    assert.equal(
      madeProgress({ text: "", toolCalls: 1 }, turnDigest({ text: "anything", toolCalls: 0 })),
      true,
    );
  });

  it("counts new text as progress", () => {
    assert.equal(
      madeProgress({ text: "new idea", toolCalls: 0 }, turnDigest({ text: "old", toolCalls: 0 })),
      true,
    );
    assert.equal(madeProgress({ text: "new idea", toolCalls: 0 }, null), true);
  });

  it("catches an agent repeating itself with nothing done", () => {
    const repeated = { text: "I cannot proceed without more information.", toolCalls: 0 };
    assert.equal(madeProgress(repeated, turnDigest(repeated)), false);
  });

  it("does not call an empty turn progress", () => {
    assert.equal(madeProgress({ text: "   ", toolCalls: 0 }, null), false);
    assert.equal(
      madeProgress({ text: "", toolCalls: 0 }, turnDigest({ text: "before", toolCalls: 0 })),
      false,
    );
  });

  it("ignores whitespace when deciding whether two turns are the same turn", () => {
    // The digest is taken from the trimmed text on both the producing and the
    // comparing side, so a trailing newline is not mistaken for new work.
    assert.equal(
      madeProgress(
        { text: "same answer\n\n", toolCalls: 0 },
        turnDigest({ text: "same answer", toolCalls: 0 }),
      ),
      false,
    );
  });
});

describe("turnDigest", () => {
  it("is null for a turn with no text, and stable otherwise", () => {
    assert.equal(turnDigest({ text: "  ", toolCalls: 0 }), null);
    assert.equal(
      turnDigest({ text: "same", toolCalls: 0 }),
      turnDigest({ text: "same", toolCalls: 3 }),
    );
    assert.notEqual(
      turnDigest({ text: "one", toolCalls: 0 }),
      turnDigest({ text: "two", toolCalls: 0 }),
    );
  });
});

describe("containsLine", () => {
  it("matches the sentinel only as its own line", () => {
    assert.equal(containsLine("work done\nGOAL_COMPLETE\n", "GOAL_COMPLETE"), true);
    assert.equal(containsLine("  GOAL_COMPLETE  \n", "GOAL_COMPLETE"), true);
    assert.equal(
      containsLine("the sentinel GOAL_COMPLETE means done", "GOAL_COMPLETE"),
      false,
      "prose mentioning the sentinel must not count as declaring it",
    );
  });
});
