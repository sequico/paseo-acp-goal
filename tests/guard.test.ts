import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decide,
  decideBeforeVerification,
  describeStop,
  type GuardInput,
  type GuardSignals,
  type PreVerificationSignals,
  type StopReason,
} from "../server/guard";

/**
 * The guard is where a runaway loop is prevented, so it is tested as a decision
 * table rather than sampled. Every branch that stops a loop has a case, plus the
 * orderings that keep a correct stop from being reported as a budget stop.
 */

const quiet: GuardSignals = {
  outcome: "completed",
  cancelReason: null,
  failureMessage: null,
  archived: false,
  permissionPending: false,
  verifyPassed: null,
  goalDeclaredMet: false,
  toolSignal: null,
  endsWithQuestion: false,
  producedOutput: true,
};

interface Case {
  round?: number;
  noProgressStreak?: number;
  tokensUsed?: number;
  signals?: Partial<GuardSignals>;
  maxRounds?: number;
  maxTokens?: number | null;
  maxNoProgressRounds?: number;
}

function input(overrides: Case = {}): GuardInput {
  return {
    round: overrides.round ?? 0,
    noProgressStreak: overrides.noProgressStreak ?? 0,
    tokensUsed: overrides.tokensUsed ?? 0,
    signals: { ...quiet, ...overrides.signals },
    limits: {
      maxRounds: overrides.maxRounds ?? 8,
      maxTokens: overrides.maxTokens ?? null,
      maxNoProgressRounds: overrides.maxNoProgressRounds ?? 2,
    },
  };
}

/** The reason of a decision that must have stopped, or a failure with its shape. */
function stopReason(decision: ReturnType<typeof decide>): StopReason {
  assert.equal(decision.action, "stop", `expected a stop, got ${JSON.stringify(decision)}`);
  return decision.action === "stop" ? decision.reason : "empty-turn";
}

describe("decide", () => {
  it("continues a healthy turn and advances the round", () => {
    assert.deepEqual(decide(input()), { action: "continue", nextRound: 1 });
  });

  it("counts the first nudge as round 1 and stops past the ceiling", () => {
    assert.deepEqual(decide(input({ round: 6, maxRounds: 8 })), {
      action: "continue",
      nextRound: 7,
    });
    assert.equal(stopReason(decide(input({ round: 8, maxRounds: 8 }))), "max-rounds");
  });

  it("never argues with a human who took the wheel", () => {
    const canceled = decide(
      input({ signals: { outcome: "canceled", cancelReason: "Interrupted by user" } }),
    );
    assert.deepEqual(canceled, {
      action: "stop",
      reason: "canceled",
      detail: "Interrupted by user",
    });
    assert.equal(stopReason(decide(input({ signals: { archived: true } }))), "agent-archived");
  });

  it("puts cancellation above a completion signal, because the human moved first", () => {
    const decision = decide(
      input({ signals: { outcome: "canceled", cancelReason: "stop", goalDeclaredMet: true } }),
    );
    assert.equal(stopReason(decision), "canceled");
  });

  it("treats every completion route as success, in priority order", () => {
    const viaTool = decide(
      input({ signals: { toolSignal: { kind: "complete", detail: "tests pass" } } }),
    );
    assert.deepEqual(viaTool, { action: "stop", reason: "tool-complete", detail: "tests pass" });

    assert.equal(
      stopReason(decide(input({ signals: { verifyPassed: true, goalDeclaredMet: true } }))),
      "verify-passed",
    );
    assert.equal(stopReason(decide(input({ signals: { goalDeclaredMet: true } }))), "sentinel");
  });

  it("lets an objective criterion beat a claim in both directions", () => {
    // No verification configured: the claim decides.
    assert.equal(
      stopReason(decide(input({ signals: { toolSignal: { kind: "complete", detail: null } } }))),
      "tool-complete",
    );
    assert.equal(stopReason(decide(input({ signals: { goalDeclaredMet: true } }))), "sentinel");

    // Verification configured and failing: neither a claim nor a sentinel ends it.
    assert.equal(
      decide(
        input({
          signals: {
            verifyPassed: false,
            toolSignal: { kind: "complete", detail: null },
            goalDeclaredMet: true,
          },
        }),
      ).action,
      "continue",
    );

    // Verification configured and passing: the measurement ends it, claim or not.
    assert.equal(stopReason(decide(input({ signals: { verifyPassed: true } }))), "verify-passed");
  });

  it("still honours a blockage under a failing verification, because that needs a human", () => {
    assert.equal(
      stopReason(
        decide(
          input({
            signals: { verifyPassed: false, toolSignal: { kind: "blocked", detail: "need a key" } },
          }),
        ),
      ),
      "tool-blocked",
    );
  });

  it("reports a blockage before a completion when both are declared", () => {
    const decision = decide(
      input({ signals: { toolSignal: { kind: "blocked", detail: "need an API key" } } }),
    );
    assert.deepEqual(decision, {
      action: "stop",
      reason: "tool-blocked",
      detail: "need an API key",
    });
  });

  it("ignores the ceilings when the goal was met on the last permitted round", () => {
    const decision = decide(
      input({ round: 8, maxRounds: 8, noProgressStreak: 5, signals: { goalDeclaredMet: true } }),
    );
    assert.equal(stopReason(decision), "sentinel");
  });

  it("does not retry a provider failure", () => {
    const decision = decide(
      input({ signals: { outcome: "failed", failureMessage: "rate limited" } }),
    );
    assert.deepEqual(decision, { action: "stop", reason: "failed", detail: "rate limited" });
  });

  it("pauses on a pending request instead of nudging past a human", () => {
    assert.equal(
      stopReason(decide(input({ signals: { permissionPending: true } }))),
      "permission-pending",
    );
  });

  it("stops on a question, which wants an answer rather than another push", () => {
    assert.equal(stopReason(decide(input({ signals: { endsWithQuestion: true } }))), "question");
  });

  it("treats a turn with no text and no tool call as a hiccup, not work", () => {
    assert.equal(stopReason(decide(input({ signals: { producedOutput: false } }))), "empty-turn");
  });

  it("stops after the configured run of turns that moved nothing", () => {
    assert.equal(decide(input({ noProgressStreak: 1 })).action, "continue");
    assert.equal(stopReason(decide(input({ noProgressStreak: 2 }))), "no-progress");
  });

  it("reports the ceiling when a ceiling and a stall coincide", () => {
    // Both are true. The round ceiling is checked first, and that ordering is
    // stated in the guard rather than left to chance.
    const decision = decide(input({ round: 8, maxRounds: 8, noProgressStreak: 2 }));
    assert.equal(stopReason(decision), "max-rounds");
  });

  it("enforces a token ceiling when one is configured", () => {
    assert.equal(stopReason(decide(input({ tokensUsed: 1000, maxTokens: 1000 }))), "token-budget");
    assert.equal(decide(input({ tokensUsed: 999, maxTokens: 1000 })).action, "continue");
    assert.equal(decide(input({ tokensUsed: 10 ** 9, maxTokens: null })).action, "continue");
  });

  it("treats a failed verification as a reason to keep going", () => {
    assert.deepEqual(decide(input({ signals: { verifyPassed: false } })), {
      action: "continue",
      nextRound: 1,
    });
  });

  it("describes every stop reason in words", () => {
    const reasons: StopReason[] = [
      "agent-archived",
      "canceled",
      "tool-blocked",
      "tool-complete",
      "verify-passed",
      "sentinel",
      "failed",
      "permission-pending",
      "empty-turn",
      "question",
      "max-rounds",
      "token-budget",
      "no-progress",
    ];
    for (const reason of reasons) {
      assert.ok(describeStop(reason).length > 10, `${reason} needs a real sentence`);
    }
  });
});

describe("decideBeforeVerification", () => {
  /** The four signals the pre-verification rules read. */
  function pre(overrides: Partial<PreVerificationSignals> = {}): PreVerificationSignals {
    return {
      archived: false,
      outcome: "completed",
      cancelReason: null,
      toolSignal: null,
      ...overrides,
    };
  }

  it("answers null when a measurement could still matter", () => {
    // Most of the time it does: a passing command beats a failed turn, a claim, and a
    // question, so the caller has to go and measure.
    assert.equal(decideBeforeVerification(pre()), null);
    assert.equal(decideBeforeVerification(pre({ outcome: "failed" })), null);
    assert.equal(
      decideBeforeVerification(pre({ toolSignal: { kind: "complete", detail: null } })),
      null,
    );
  });

  it("stops on the three reasons that outrank a measurement", () => {
    assert.deepEqual(decideBeforeVerification(pre({ archived: true })), {
      action: "stop",
      reason: "agent-archived",
      detail: null,
    });
    assert.deepEqual(decideBeforeVerification(pre({ outcome: "canceled", cancelReason: "X" })), {
      action: "stop",
      reason: "canceled",
      detail: "X",
    });
    assert.deepEqual(
      decideBeforeVerification(pre({ toolSignal: { kind: "blocked", detail: "need a key" } })),
      { action: "stop", reason: "tool-blocked", detail: "need a key" },
    );
  });

  it("agrees with decide on every pre-verification case", () => {
    // The two functions share one implementation, and this is what keeps them from
    // drifting: whatever the pre-check decides, `decide` must reach the same verdict.
    const cases: Array<Partial<PreVerificationSignals>> = [
      {},
      { archived: true },
      { outcome: "canceled", cancelReason: "X" },
      { outcome: "failed" },
      { toolSignal: { kind: "blocked", detail: "d" } },
      { toolSignal: { kind: "complete", detail: "d" } },
    ];
    for (const overrides of cases) {
      const signals = pre(overrides);
      const early = decideBeforeVerification(signals);
      if (early === null) {
        continue;
      }
      assert.deepEqual(
        early,
        decide(input({ signals: { ...quiet, ...signals } })),
        `disagreement for ${JSON.stringify(overrides)}`,
      );
    }
  });
});
