# Changelog

A version is a Git tag and a GitHub Release, and the section below for it is that
release's notes. The plugin is installed from Git rather than npm, so a released tag is
both the unit of "a revision known to be good" and the unit a daemon pins itself to with
`--ref`.

Nothing below this line is in the tree except `0.1.0`. There is no released `0.2.0`, and
the section under that heading describes work that has **not** been written — it is here
so that nobody reads this repository and concludes the unimplemented parts already
shipped.

## 0.1.0

First release.

**The loop.** A watched agent is kept working until its goal is met, driven by
`server.on("agent.turn_ended")` and `context.paseo.agents.ref(id).send(...)`. After every
turn the loop asks four questions in order: did something end this, is the goal met, is a
human needed, and is it still allowed to continue. If none of them stops it, one nudge is
sent, re-anchoring the goal, the acceptance criterion, and the round number.

- Thirteen explicit stopping rules in one pure function (`server/guard.ts`), tested as a
  decision table: human interrupt, archive, declared blockage, passing verification,
  completion claim, failed turn, pending request, empty turn, trailing question, round
  ceiling, token ceiling, and no-progress stall.
- A turn is nudged at most once. Duplicate `agent.turn_ended` events are detected and
  ignored, and the detection fails open, because dropping a real turn silently is worse
  than one redundant nudge.

**Three ways to declare a goal**, with the precedence between them answered once, in
`server/goal-source.ts`, so the loop and the screen cannot disagree about whose goal is
in force:

- **A launch label**, authoritative. An orchestrator's instruction is not the screen's to
  remove, so those rows are read-only and setting a goal over one is refused rather than
  silently stored.
- **The ACP goals screen**, in the sidebar under History, Search, and Schedules. A human's
  explicit instruction outranks a goal the agent declared for itself and yields to a
  label.
- **A `.acp-goal.json` file** the agent writes in its own workspace. Once a label goal
  exists, the file may no longer redefine the goal, its verification command, or its
  ceiling — it may only report, and declare the goal met.

**The ACP goals screen** lists every agent that is eligible for a goal or already carrying
one, shows what each loop is doing and why it last stopped, and sets, replaces, or clears
a goal from the app. It decides nothing itself: eligibility, precedence, and whether a row
may be cleared are the loop's rules, answered by the daemon, because a second copy in the
view layer would be a second truth. A goal a human set is persisted and is not cleared by
a daemon restart, because an instruction typed by a person is not a cache.

**Completion**, by sentinel, by the optional goal tool, or by a verification command whose
exit code is authoritative in both directions. Finishing a turn with a line containing
only `GOAL_COMPLETE` ends the loop and needs nothing from the provider; the goal tool
(`goal_complete`, `goal_blocked`) is injected as an MCP server over loopback HTTP and is
available only where the provider exposes injected servers. Where it is not, the plugin
writes one line to its log rather than pretending the tool was seen.

**Anti-runaway accounting**, with the two ceilings deliberately scoped differently:
rounds bound one goal, so a new goal starts with a new budget, while tokens bound one
agent and are never reset by changing the goal, a resumed pause, or a daemon restart. An
agent that could zero its own spend by rewriting its goal file would have an unbounded
budget. The outcome of a finished goal is remembered — state and reason — for the same
24-hour accounting lifetime, so the screen can say how a loop finished rather than losing
it the moment the loop is dropped.

**Lifetimes and access.** Label keys: `paseo-acp-goal`, `paseo-acp-goal-verify`,
`paseo-acp-goal-max`, `paseo-acp-goal-max-tokens`, `paseo-acp-goal-done`. Defaults: 8
rounds, 2 consecutive no-progress turns tolerated, no token ceiling, a 15-minute
verification timeout, and verification output capped at 1500 characters in the status row.
Accounting lives in `$PASEO_HOME/plugin-data/paseo-acp-goal/state.json` and does not
re-arm on restart: nothing re-sends by itself.

**Two tests for failures nothing else can see.** The daemon's own load path is reproduced
end to end — esbuild, its CommonJS wrapper, its `globalThis.eval` sandbox — so the
plugin's central architectural decision, serving the goal tool over loopback HTTP because
a bundle cannot locate a helper script beside itself, rests on a checked fact. And an
import-graph walk proves every reachable specifier is injectable by the host without
devDependencies, which is what a daemon install with `--omit=dev` requires and what no
typecheck, test, or `npm pack` would otherwise catch.

**The gate is enforced rather than trusted.** `npm run verify` — typecheck, lint at zero
warnings, format:check, and the suite — is required on `main`, with the owner exempt so a
direct push is not blocked by a check that has not run yet. Force pushes and branch
deletion are refused there, released tags cannot be moved or deleted, every action the
workflow uses is pinned to a commit SHA that Dependabot raises weekly, and secret scanning
and push protection are enabled. [`SECURITY.md`](SECURITY.md) states the trust model.

## 0.2.0 (planned — not implemented)

Reserved for the work this repository does not do yet. None of it is in the source.

- **Make the goal tool reach the agent.** Today, a provider that does not expose
  injected MCP servers never sees `goal_complete` or `goal_blocked`, and the plugin can
  only observe the consequence and log it. Investigating and fixing that is the whole of
  0.2.0.
- **Upstream.** Paseo discards the ACP `stopReason` before a plugin can see it, so a
  finished turn and a truncated one are indistinguishable from here
  ([getpaseo/paseo#5283](https://github.com/getpaseo/paseo/issues/5283)). The plugin
  judges the turn from the transcript instead, which is a workaround for a missing field,
  and it would be a smaller and more precise plugin if the field were exposed.
