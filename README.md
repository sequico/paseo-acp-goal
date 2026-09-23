# paseo-acp-goal

A trusted local [Paseo](https://paseo.sh) plugin that keeps an agent working until a
goal it has been given is actually met — with every way a loop can run away handled
by an explicit guard rather than by hope.

It exists for one reason: an agent speaking ACP through Paseo has no goal mechanism
of its own and no system prompt to be told about one. Claude Code has `/goal`, Codex
has goals behind `--enable goals`, and Paseo exposes both — but for an ACP agent the
turn simply ends, and whether more work was needed is not something the daemon
records. This plugin supplies the goal, the continuation, and the stopping rules.

## What it does

After every turn of a watched agent, the loop asks four questions in order:

1. **Did something end this?** An interrupt, a blockage the agent declared, or an
   archive stops the loop immediately.
2. **Is the goal met?** A verification command that exits 0, a completion declared
   through the goal tool, a sentinel line, or the workspace file's `done` flag.
3. **Is a human needed?** A pending permission request, a failing turn, an empty
   turn, or a turn that ends in a question pauses the loop rather than nudging past
   it.
4. **Is it still allowed to continue?** The round ceiling, a token ceiling, and a
   stall detector, in that order.

If no rule stops it, one nudge is sent. The nudge re-anchors the goal, the
acceptance criterion, and the round number, because a goal that does not survive
context compaction is a closed bug in Paseo (`getpaseo/paseo#3210`) and not a
hypothetical.

A turn is nudged at most once. Duplicate `agent.turn_ended` events are detected and
ignored — `turnId` cannot be the key, since Paseo documents that it "can repeat after
a session reopens" — and the detection fails open, because dropping a real turn
silently is worse than one redundant nudge.

## Three ways to declare a goal

**A label**, set by whoever launches the agent. Authoritative:

```bash
paseo run --provider codewhale \
  --label 'paseo-acp-goal=Make the failing test in tests/sum.test.ts pass' \
  --label 'paseo-acp-goal-verify=npm test' \
  --label 'paseo-acp-goal-max=6' \
  "Start by reading the test file."
```

**The ACP goals screen**, in Paseo's sidebar under History, Search, and Schedules.
Pick an agent, type a goal, and the loop starts on its next turn. It outranks a goal
the agent declared for itself and yields to a launch label:

- a human's explicit instruction is not the agent's to override; and
- a label belongs to whoever launched the agent, so those rows are shown read-only
  rather than offered a Clear button that would fail.

**A file** the agent writes in its own workspace — `.acp-goal.json`:

```json
{
  "goal": "Migrate the config loader to the new schema",
  "verify": "npm test",
  "maxRounds": 10
}
```

The file is the point of the plugin as much as the loop is: an agent that cannot be
told to declare a goal can still choose to. Once a label goal exists, the file may no
longer redefine the goal, the verification command, or the ceiling — it may only
report, and may declare the goal met (`done: true`). Without that fence an agent could
narrow its own goal and then "finish".

## The ACP goals screen

A sidebar item, next to Paseo's own History, Search, and Schedules. It answers the two
questions a command-line-only plugin cannot: _which_ agents are being driven, and
_what can I do about it right now_.

Each row is one agent that is eligible for a goal or already carrying one:

- the agent's title, provider, and status;
- its goal, where that goal came from (`label`, `ui`, or `file`), and how far the loop
  has got — round 3 of 8, met, or stopped with the reason;
- the verification command, when there is one.

From there you can set a goal, replace one, or clear it, with round and token ceilings
as optional fields. Clearing stops the loop: a goal a human removed must not keep being
nudged toward.

Everything the screen shows comes from one RPC (`goal.overview`) and everything it does
is two more (`goal.set`, `goal.clear`). It decides nothing itself — eligibility,
precedence, and whether a row may be cleared are the loop's rules, answered by the
daemon, because a second copy of those rules in the app would be a second truth.

## Completion: the sentinel decides, the tool is an upgrade

A loop ends when the goal is met, and the plugin offers an agent **two** ways to say
so.

**The sentinel always works.** Finishing a turn with a line containing only
`GOAL_COMPLETE` — configurable with `paseo-acp-goal-done` — ends the loop. It needs
nothing from the provider, and it is what the nudge asks for first.

**The goal tool is offered, not guaranteed.** When Paseo is about to start an ACP
agent, the plugin injects an MCP server into the session carrying two tools:

- `goal_complete(summary?)` — the goal is met, end the loop.
- `goal_blocked(reason)` — a human decision is needed, pause the loop.

A tool call is better than a string, because a string can be emitted by accident
while explaining the protocol, inside a diff, or in a quoted log, whereas a tool call
is deliberate. But whether the agent ever _sees_ the injected server is decided
inside that agent, and Paseo reports nothing about it. An ACP agent that does not
expose injected MCP servers will never call the tool, and the plugin cannot ask.

So the two are not equals, and the README says which one is load-bearing:

> **Observed, not theoretical.** Driving a `codewhale` agent through this plugin, the
> tool was injected into the session — `config.mcpServers["paseo-acp-goal"]` is on the
> agent's own record, with a live loopback URL — and the agent never saw it, saying so
> itself: _"`goal_complete` is not among the tools available to me, so I'm using the
> sentinel instead."_ The sentinel carried both live runs. If your provider is in that
> category, this plugin still works; it just works through the sentinel.

When the plugin offers the tool and the agent never calls it, the loop says so once
in the daemon log — `paseo plugin logs paseo-acp-goal` — so the gap is visible
instead of silent. Making the tool reach the agent on every provider that accepts the
injection is the whole of the planned 0.2.0; it is not implemented here.

## Configuration

Label keys, all optional except the goal itself:

- `paseo-acp-goal` — the goal. Its presence is what watches a non-ACP agent.
- `paseo-acp-goal-verify` — a shell command; exit 0 means done.
- `paseo-acp-goal-max` — round ceiling, 1 to 50. Default 8.
- `paseo-acp-goal-max-tokens` — cumulative token ceiling. Unset means no ceiling.
- `paseo-acp-goal-done` — the sentinel line. Default `GOAL_COMPLETE`.

Workspace file keys, `.acp-goal.json` in the agent's working directory:

- `goal`, `verify`, `maxRounds`, `maxTokens` — honoured only when no label or screen
  goal exists.
- `done`, `note` — always honoured; this is how an agent reports.

Screen fields, on the ACP goals surface:

- the goal, an optional verification command, an optional round ceiling, and an
  optional token ceiling.

A verification command does not need to also be the goal's wording, and both
ceilings can be set together. Defaults: 8 rounds, 2 consecutive no-progress turns
tolerated, no token ceiling, 15 minute verification timeout, output capped at 1500
characters in the status row.

## What stops a loop

Every rule below is a case in `tests/guard.test.ts`, and the order matters:

- **A human interrupt or an archive** — the loop never argues with someone who took
  the wheel.
- **A declared blockage** — by definition a human decision.
- **A passing verification** — the one signal nobody can argue with.
- **A completion claim** — the tool, the sentinel, or the file's `done` flag. These
  decide only when no verification command is configured, because a configured
  criterion that fails must not be overridden by a claim, and one that passes must
  not be overridden by a denial.
- **A failed turn** — not retried. A provider failure is a real error, already visible
  in the UI, and retrying it is how one fault becomes a bill.
- **A pending request** — paused, not nudged.
- **An empty turn** — no text and no tool call is a hiccup, not work.
- **A turn ending in a question** — the agent wants an answer, not another push.
- **The round ceiling** — checked before the stall guard, so a loop that hit both
  reports the ceiling; that ordering is deliberate and stated in the code.
- **The token ceiling** — cumulative tokens reported by the agent's own turns.
- **Two consecutive turns that moved nothing** — the same text twice with no tool
  call. This is the rule that catches an agent politely restating its own blockage
  forever.

### The two ceilings do not share a scope

This is deliberate and load-bearing:

- **Rounds bound one goal.** Changing the goal resets the round budget and the stall
  detection, because a new goal is new work.
- **Tokens bound one agent**, and are never reset by changing the goal. An agent that
  could zero its own spend by rewriting its goal file would have an unbounded budget,
  and the ceiling would be decorative. The spend survives a goal change, a paused
  loop resumed by an answer, and a daemon restart.

Accounting is forgotten after 24 hours of no loop activity, which also drops the
spend — a goal left alone for a day is over, and holding an unbounded record set
forever would be worse.

## Security

Plugins are trusted, unsandboxed code, and this one asks for two things worth
knowing before installing it:

- **A verification command runs with the daemon user's access**, in `/bin/sh -c` on
  the agent's working directory. Configure a command you would run yourself. It
  times out after fifteen minutes.
- **The goal tool listens on loopback**, on an ephemeral port, one unguessable path
  segment per session. It holds no credentials, exposes no goal text, and answers
  only `initialize`, `ping`, `tools/list`, and `tools/call`. A call arriving on a
  token that is not bound to an agent is recorded and then ignored.
- The goal file is data, never code. It is read from the agent's own working
  directory and cannot escape the label's terms.

The loop's own accounting lives in `$PASEO_HOME/plugin-data/paseo-acp-goal/state.json`.
It records the round count and token spend so a daemon restart cannot hand an agent a
fresh ceiling. It does **not** re-arm on restart: nothing re-sends by itself, because
a loop that silently resumes spending after an unrelated crash is the kind of surprise
this plugin exists to prevent.

## Install

Paseo 0.9.1 or newer, with plugins enabled on the daemon:

```bash
paseo plugin install /path/to/paseo-acp-goal
paseo plugin ls
paseo plugin logs paseo-acp-goal
```

Nothing else is configurable from the app on purpose: the screen exists to set goals,
and everything a goal can carry is a field on it. The loop's own lifetimes and sweep
cadence are constants in `server/loop.ts`.

## Development

```bash
npm install
npm run verify   # typecheck, lint, format:check, test
```

`npm run verify` must come back at **0 errors and 0 warnings**, and the tests must
pass — that is the gate, and reading the output matters more than the exit code. CI
runs the same command on every push and pull request, so the claim is enforced rather
than trusted.

Two of the tests exist to catch failures that nothing else can see, because Paseo
does not run a plugin the way a developer does:

- `tests/bundle.test.ts` compiles `index.server.ts` with esbuild exactly as the
  daemon does, wraps it in the daemon's own CommonJS wrapper, evaluates it inside the
  daemon's `eval` sandbox, and requires that it registers its hooks. This is what
  makes the plugin's central architectural decision — serving the goal tool over
  HTTP because a bundle cannot locate a helper script beside itself — a checked fact
  rather than a remembered one.
- `tests/host-imports.test.ts` walks the import graph and insists every specifier is
  one the host injects, a Node builtin, or a real runtime dependency. A daemon
  install from npm uses `--omit=dev`, so a devDependency import fails the install
  with "Could not resolve type dependency" — a failure invisible to `tsc`, to the
  tests, and to `npm pack`, all of which run where the devDependencies exist.

The engineering rules — single source of truth, no duplication, no workarounds —
are in [`AGENTS.md`](AGENTS.md) and are review-blocking.

## Two constraints worth stating plainly

These shape the architecture and are honoured rather than worked around:

1. **An ACP agent cannot be given a system prompt.** Paseo's ACP adapter builds
   `session/new` from `cwd` and `mcpServers` alone, and `systemPrompt` is mapped only
   by OMP. So the plugin reaches the agent through the goal tool and through the
   nudge text, and there is no third channel.
2. **A plugin's server bundle is evaluated with `globalThis.eval`.** It has no
   `import.meta.url` and no path to its own directory, so a helper script shipped in
   this repository could not be found at runtime. Hence the loopback listener.

A third is a gap in Paseo rather than in the plugin: `PluginTurnOutcome` reports
`completed | failed | canceled`, and Paseo's ACP adapter maps `end_turn`, `max_tokens`,
`max_turn_requests`, `refusal`, and the default branch all onto `completed`. So the
provider's `stopReason` — the most useful signal an auto-continue could have — never
reaches a plugin. Exposing it would be the clean fix; until then this plugin judges
the turn from the transcript, which is a workaround for a missing field and is
described as one in the source.

## Provenance

Ideas taken from other plugins are credited where they are used:

- **`loop-verify`** (HiepPP/hiep-paseo-plugin) — the label-driven loop with an
  optional verification command, and pausing on a question instead of pushing on.
- **`paseo-minimax-resumer`** (ilteoood) — sending a follow-up from
  `agent.turn_ended`, and keeping a per-agent pending record so a scheduled resume is
  not queued twice.
- **`chat-resume`** (panrafal/paseo-plugins) — reading the turn tail through the
  daemon, which is what makes this work for ACP providers that keep no transcript on
  disk.
- **`paseo-defer`** (tomgrin10) — waiting for a session to be idle before delivering
  a message.
- **`paseo-agent-monitor`** (omercnet) and **`herald`** (gpambrozio) — the
  daemon-fidelity bundle test and the installability import test, both adapted here.

## Limits

Stated so nobody has to discover them:

- **The goal tool may not reach the agent.** Whether a provider exposes injected MCP
  servers is decided inside that provider, and Paseo reports nothing about it. The
  sentinel is the route that always works, and the plugin logs a line when an offered
  tool went unused. This is the largest known gap and the whole of the planned 0.2.0.
- **Nothing in the app has been seen rendered yet.** The daemon registers the screen's
  three RPCs and reports them at load, the status row's `timeline.append` is exercised
  against a real daemon and emits no error, and the whole view layer is a pure function
  under test — but no one has yet watched the sidebar item, the card, or the screen in
  Paseo. The CLI cannot show any of them. Treat the visual layer as unconfirmed until
  somebody opens a session and the screen.
- **The token ceiling is unit-tested but not exercised end to end.** Three live runs
  finished by sentinel in one round, before approaching a ceiling. One of them also
  confirmed the documented gap from the other side: `codewhale` reported no token usage
  at all, so a token ceiling had nothing to count on that provider.
- **A launch label cannot be cleared from the screen.** It belongs to whoever launched
  the agent, so the row is read-only. Clearing it means relaunching without the label.
- A nudge is a new turn, not a resumption of the old one. Attachments and tool
  effects from the previous turn are not replayed.
- The token ceiling reads the tokens the agent's own turns report. If a provider
  reports none, the ceiling has nothing to count and only the round ceiling applies.
- The status row is one per agent and is replaced in place, so a transcript shows the
  current state of the loop rather than its history.
- A goal's outcome is remembered for 24 hours of inactivity, the same lifetime as the
  loop accounting. After that the screen shows the agent as having no goal.
- The plugin watches ACP providers by default and any other provider only when a goal
  label is present. There is no wildcard "every agent" mode, deliberately.

## Roadmap

Nothing below is implemented in this tree. It is stated here so the repository does not
read as more finished than it is.

- **0.2.0** — make the goal tool reach the agent on providers that currently decline
  the injection. The tool is the safer completion route, and it is inert on at least
  one provider today. Also: exercise the token ceiling end to end, which has never been
  approached by a live loop.
- **No version yet** — see the sidebar item, the status card, and the screen rendered in
  the app, and fix whatever that shows.
- **Upstream** — Paseo discards the ACP `stopReason` before a plugin can see it, so a
  finished turn and a truncated one are indistinguishable from here
  ([getpaseo/paseo#5283](https://github.com/getpaseo/paseo/issues/5283)). The plugin
  judges the turn from the transcript instead, which is a workaround for a missing
  field.

## License

MIT.
