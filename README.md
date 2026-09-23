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

## Two ways to declare a goal

**A label**, set by whoever launches the agent. Authoritative:

```bash
paseo run --provider codewhale \
  --label 'paseo-acp-goal=Make the failing test in tests/sum.test.ts pass' \
  --label 'paseo-acp-goal-verify=npm test' \
  --label 'paseo-acp-goal-max=6' \
  "Start by reading the test file."
```

**A file** the agent writes in its own workspace — `.acp-goal.json`:

```json
{
  "goal": "Migrate the config loader to the new schema",
  "verify": "npm test",
  "maxRounds": 10
}
```

The file is the point of the plugin as much as the loop is: an agent that cannot be
told to declare a goal can still choose to. Once a label goal exists, the file may
no longer redefine the goal, the verification command, or the ceiling — it may only
report. Without that fence an agent could narrow its own goal and then "finish".

## The goal tool

When Paseo is about to start an ACP agent, the plugin injects an MCP server into the
session, giving the agent two tools:

- `goal_complete(summary?)` — the goal is met, end the loop.
- `goal_blocked(reason)` — a human decision is needed, pause the loop.

A tool beats a sentinel string, because a string can be emitted by accident while
explaining the protocol, inside a diff, or in a quoted log, whereas a tool call is a
deliberate act. If the tool cannot be offered — an unsupported transport, or the
listener failed to start — the plugin degrades to the sentinel and says so in the
daemon log. Nothing else changes.

## Configuration

Label keys, all optional except the goal itself:

- `paseo-acp-goal` — the goal. Its presence is what watches a non-ACP agent.
- `paseo-acp-goal-verify` — a shell command; exit 0 means done.
- `paseo-acp-goal-max` — round ceiling, 1 to 50. Default 8.
- `paseo-acp-goal-done` — the sentinel line. Default `GOAL_COMPLETE`.

Workspace file keys, `.acp-goal.json` in the agent's working directory:

- `goal`, `verify`, `maxRounds`, `maxTokens` — honoured only when no label goal
  exists.
- `done`, `note` — always honoured; this is how an agent reports.

Defaults: 8 rounds, 2 consecutive no-progress turns tolerated, no token ceiling, 15
minute verification timeout, output capped at 1500 characters in the status row.

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

Nothing is configurable from the app on purpose. The loop is set up by whoever
launches the agent (a label) or by the agent itself (a file), and that keeps the
plugin out of the UI.

## Development

```bash
npm install
npm run verify   # typecheck, lint, format:check, test
```

`npm run verify` must come back at **0 errors and 0 warnings**, and the tests must
pass — that is the gate, and reading the output matters more than the exit code.

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
  `agent.turn_ended`, with a per-agent pending guard so a duplicate event cannot
  double-send.
- **`chat-resume`** (panrafal/paseo-plugins) — reading the turn tail through the
  daemon, which is what makes this work for ACP providers that keep no transcript on
  disk.
- **`paseo-defer`** (tomgrin10) — waiting for a session to be idle before delivering
  a message.
- **`paseo-agent-monitor`** (omercnet) and **`herald`** (gpambrozio) — the
  daemon-fidelity bundle test and the installability import test, both adapted here.

## Limits

Stated so nobody has to discover them:

- A nudge is a new turn, not a resumption of the old one. Attachments and tool
  effects from the previous turn are not replayed.
- The token ceiling reads the tokens the agent's own turns report. If a provider
  reports none, the ceiling has nothing to count and only the round ceiling applies.
- The status row is one per agent and is replaced in place, so a transcript shows the
  current state of the loop rather than its history.
- The plugin watches ACP providers by default and any other provider only when a goal
  label is present. There is no wildcard "every agent" mode, deliberately.

## License

MIT.
