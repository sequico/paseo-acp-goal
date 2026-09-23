# Changelog

Notable changes, newest first. A version is a Git tag and a GitHub Release, and the
section below for it is that release's notes. The plugin is installed from Git rather
than npm, so a released tag is both the unit of "a revision known to be good" and the
unit a daemon pins itself to with `--ref`.

Nothing below this line is in the tree except `0.1.2`, `0.1.1`, and `0.1.0`. There is no
released `0.2.0`, and the section under that heading describes work that has **not**
been written — it is here so that nobody reads this repository and concludes the
unimplemented parts already shipped.

## 0.1.2

- **The goal field on the ACP goals screen is sized for a goal.** It was a single line,
  as every other settings field is, which is right for a filename and wrong for a
  sentence: what a human typed scrolled sideways instead of wrapping. It is now four
  lines, held against the row's right edge like every other control in the card.
- **A goal set on the screen is no longer reported as a launch label.** The transcript
  card asked whether the goal came from the agent's own file and called everything else
  a label, so a goal a human had typed on the screen was shown as one an orchestrator
  had set. Each source has a word of its own, from one mapping over the vocabulary.
- **Selecting another agent gives you that agent's goal, not your last edits.** The form
  kept whatever had been typed across a selection change, because the fields were never
  re-initialised, and "Set the goal" would have written the previous agent's text to the
  newly selected one.
- The plugin version is pinned between `package.json` and the constant the shipped
  bundle reports, because the daemon gives server code no way to read the first one: a
  release that bumped one and not the other would report the old version on every
  handshake, silently. A bump that misses a file now fails the gate.

## 0.2.0 (planned — not implemented)

Reserved for the work this repository does not do yet. None of it is in the source.

- **Make the goal tool reach the agent.** Today, a provider that does not expose
  injected MCP servers never sees `goal_complete` or `goal_blocked`, and the plugin can
  only observe the consequence and log it. Investigating and fixing that is the whole of
  0.2.0.

## 0.1.1

- **An ACP goals screen**, in the sidebar under History, Search, and Schedules. It
  lists every agent that is eligible for a goal or already carrying one, shows what
  each loop is doing and why it last stopped, and sets, replaces, or clears a goal
  from the app. Until now the only inputs were a launch label and a file the agent
  wrote itself, which is a plugin most people would never turn on.
- **A third goal source, `ui`**, for a goal a human set on that screen. It outranks a
  goal the agent declared for itself and yields to a launch label, because a human's
  explicit instruction is not the agent's to override and an orchestrator's label is
  not the screen's to remove. Those rows are shown read-only, and setting one is refused
  rather than silently stored.
- **A UI goal is persisted**, and is not cleared by a daemon restart: an instruction
  typed by a person is not a cache.
- **A goal is remembered as history after it ends** — state and reason — so the screen
  can say how a loop finished rather than losing it the moment the loop is dropped.
  The same 24-hour accounting lifetime bounds it.
- **`paseo-acp-goal-max-tokens`**, so a label-driven setup can bound spend as well as
  rounds. It could not before: a label goal had no token ceiling at all.
- The ACP provider's stop reason is reported upstream as
  [getpaseo/paseo#5283](https://github.com/getpaseo/paseo/issues/5283), so a finished
  turn and a truncated one stop being indistinguishable to a plugin.

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

Known limits in this release, stated in the README: the goal tool is offered but may not
reach the agent, and the token ceiling counts only the usage a provider reports.
