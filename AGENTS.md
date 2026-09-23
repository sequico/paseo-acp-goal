# AGENTS.md — engineering law for paseo-acp-goal

This repository is a Paseo plugin. Everything here is read by a daemon that runs
it as trusted, unsandboxed code, and by an agent loop that spends real tokens on
its own. Both of those make sloppy code expensive rather than merely untidy.

## The three rules

These are review-blocking, not aspirational. A change that breaks one is sent
back rather than patched up.

### 1. Single source of truth

Every fact has exactly one home. A constant is defined where it is authoritative
and imported everywhere else; it is never retyped. A value that two modules both
need lives in the module that owns the concept, and the other imports it.

The vocabulary of the domain — the stop reasons, the tool signal kinds, the goal
source, the status row fields — is defined once, in the module that owns it, and
derived everywhere else (`z.infer`, `typeof`, a shared type). If a shape has to
change, there is exactly one place to change it.

### 2. No duplication

No copy-pasted logic, no near-identical branches, no second implementation of a
decision that already exists. Extract on the second use, not the third.

State is never mirrored. If the daemon already knows something — whether an agent
is archived, whether a request is pending, what the working directory is — read it
from the snapshot. Do not keep a local copy updated by events; that is a second
source of truth with a synchronisation bug built in.

### 3. No workarounds

A workaround is any code that exists to get around a problem instead of solving
it: a cast that defeats the type system, a retry that hides a real error, a flag
that exists only to satisfy a linter, a seam nothing uses, a `void` to silence an
unused variable, an extra hook to paper over state that should be derived.

When the underlying problem is real, say so and solve it — or document the
constraint in a comment that names it. A constraint explained is engineering; a
constraint hidden is a bug waiting for its turn.

Unused code is deleted, not exported. Speculative generality is deleted, not
commented out. Dead configuration is deleted, not ignored.

## How the rules are enforced

- `npm run verify` is the gate: `typecheck`, `lint`, `format:check`, `test`.
  It must come back clean, and **clean means zero**: zero errors and zero
  warnings from every tool. There is no tolerated warning count, no "known
  warnings" list, and no baseline of accepted noise. A warning is a defect that
  has not been prioritised yet, so it is either fixed or the rule that produced
  it is turned off deliberately, in the config, with the reason in a comment.
- The formatter runs in check mode, so a formatting difference fails the gate
  instead of being rewritten silently.
- The `client/` ↔ `server/` split is enforced by esbuild at load time: a client
  import of `server/`, a server import of `client/`, or a `node:` import reachable
  from client code fails the build. That boundary is a mechanism, not a habit.
- The three rules above are enforced in review. There is no linter for "this is a
  workaround", so the review is where it happens.

## Verification is the standard, not the gesture

Nothing is done until it is checked, and the check is real:

- `npm run verify` must pass, and **0 errors / 0 warnings** is what passing
  means. Read the output rather than the exit code alone: a summary line saying
  "0 errors" while a warning scrolled past is not clean.
- A decision belongs in a pure function tested as a table of cases. `server/guard.ts`
  is the pattern: all the safety logic, no I/O, one test per branch.
- I/O boundaries — the MCP listener, the verification command, the state file —
  are exercised for real, not mocked into agreement.
- Claiming a behaviour that no test or run demonstrates is not allowed. Say what
  was verified and what was not.

## Native constraints, wrapped in comprehension, not in code

Two real constraints shape this plugin. They are honoured, not worked around:

- An ACP agent cannot receive a system prompt, because Paseo's ACP adapter builds
  `session/new` from `cwd` and `mcpServers` alone. So the plugin speaks to the
  agent through a tool and through the nudge text, and the docs say so.
- A plugin's server bundle is evaluated with `globalThis.eval`, so it has no
  `import.meta.url` and no path to its own directory. So the goal tool is served
  over loopback HTTP rather than spawned from a bundled script.

Comments explain these. Code does not pretend they are not there.

## Provenance

Ideas borrowed from other plugins are credited where they are used, in the
comment or in the README, naming the plugin and what was taken. This repository
does not claim novelty it does not have.

## Commits

Never commit or push unless the owner asks for it in the same turn, using the
word "commit" or "push".

## Shell

Fail fast. Every command carries an explicit timeout, anything expected to
outlast a few seconds is backgrounded and polled, and no search walks a
FUSE-synced mount.
