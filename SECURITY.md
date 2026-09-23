# Security policy

## What this plugin is, from a trust standpoint

A Paseo plugin is trusted, unsandboxed code. The daemon evaluates it in-process, so
this plugin can read and write files, spawn processes, and reach the network with the
daemon user's own access. That is not a caveat bolted onto the security section — it is
the trust model, and it should shape what a report here is worth.

Two capabilities this plugin asks for are worth naming before anything else, because
they are the ones a reader would want to review first. Both are described in full in
the README:

- **A verification command** configured for a goal runs with the daemon user's own
  access — `/bin/sh -c` on POSIX, `cmd.exe /c` on Windows — in the agent's working
  directory, and times out after fifteen minutes. It is a command the operator
  configures, so a goal that could set it is already code execution by construction;
  this plugin does not widen that, and does not sandbox it either.
- **The goal tool listens on loopback**, on an ephemeral port, with one unguessable
  path segment per session. It holds no credentials, exposes no goal text, and answers
  only `initialize`, `ping`, `tools/list`, and `tools/call`. A call on a token that is
  not bound to an agent is recorded and ignored.

## Reporting a vulnerability

Report privately through GitHub's
[security advisories](https://github.com/sequico/paseo-acp-goal/security/advisories/new)
for this repository. Please do not open a public issue for anything exploitable.

What helps a report land quickly:

- the version you are running, from `package.json` or `paseo plugin ls`;
- your Paseo version, since some behaviour is the daemon's rather than the plugin's;
- the provider involved, if the issue touches the goal tool — whether a provider
  exposes injected MCP servers is decided inside that provider and differs between
  them;
- the smallest reproduction you can manage, ideally a test case in the shape
  `tests/` already uses, or the exact goal and labels that trigger it.

## What is in scope

- The loopback MCP listener: token handling, path secrecy, and whether a request can
  reach a signal it should not.
- The goal-tool token's binding to an agent, and whether one agent can act on
  another's loop.
- Goal precedence: whether a narrower source can override a wider one, in particular
  whether an agent's own `.acp-goal.json` can redefine or clear a goal a human or an
  orchestrator set.
- The guard: whether any path nudges an agent past a stop the rules say should hold,
  including the round and token ceilings.
- Escaping through a goal's text into the status row or the nudge.
- The state file at `$PASEO_HOME/plugin-data/paseo-acp-goal/state.json`.

## What is not this plugin's to fix

- **Anything in Paseo itself.** A plugin runs with the daemon's full access by design,
  so "a plugin can read my files" is the documented trust model rather than a defect
  in this repository. Report daemon issues to
  [getpaseo/paseo](https://github.com/getpaseo/paseo).
- **A provider not exposing injected MCP servers.** The goal tool is inert there. That
  is a stated, documented limitation, not a vulnerability, and the sentinel route
  carries the loop instead.
- **A verification command doing what it says.** It is arbitrary shell by design, with
  the operator's own access. Configure one you would run yourself.

## Supported versions

The latest released tag. Fixes land on `main` and are released as a new tag rather than
backported, because the whole plugin is one small bundle and every release is a single
commit range.
