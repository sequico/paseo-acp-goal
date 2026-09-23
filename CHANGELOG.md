# Changelog

Notable changes, newest first. Versions are Git tags; the plugin is installed from
Git rather than npm, so a tag is the unit of "a revision known to be good".

## 0.1.0

First release.

- A loop that keeps a watched agent working until its goal is met, driven by
  `server.on("agent.turn_ended")` and `context.paseo.agents.ref(id).send(...)`.
- Thirteen explicit stopping rules in one pure function (`server/guard.ts`), tested
  as a decision table: human interrupt, archive, declared blockage, passing
  verification, completion claim, failed turn, pending request, empty turn, trailing
  question, round ceiling, token ceiling, and no-progress stall.
- Two ways to declare a goal: a launch label (authoritative) or a `.acp-goal.json`
  file the agent writes for itself. A label goal cannot be redefined by the file.
- Completion by sentinel, by the optional goal tool (MCP over loopback HTTP), or by a
  verification command whose exit code is authoritative in both directions.
- Anti-runaway accounting: rounds bound one goal, tokens bound one agent and survive
  a goal change, a resumed pause, and a daemon restart.
- Two tests for failures nothing else can see: the daemon's own load path reproduced
  (esbuild, its CommonJS wrapper, its `eval` sandbox), and an import-graph walk that
  proves every specifier is injectable by the host without devDependencies.

Known limits in this release, stated in the README: the goal tool is offered but may
not reach the agent, the status row is written but not visually confirmed, and the
token ceiling is unit-tested but not exercised end to end.
