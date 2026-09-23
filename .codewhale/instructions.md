# Codewhale project instructions

> This file mirrors the owner-global operating rules for sessions started inside
> this repository. It is **not** a second source of truth: the canonical copy is
> `~/.codewhale/memory/global/MEMORY.md`, and this file is a convenience mirror so
> that a sub-agent or a fresh session inherits the rules when the global memory is
> not loaded.
>
> The engineering law for this repository is `AGENTS.md` at the root. This file
> does not restate it, because restating rules is how two copies drift apart.

## Budgets live in the machine, once

Turn, stream, and sub-agent caps are set in `~/.codewhale/config.toml` and apply
to every workspace. Read them with `codewhale config list`. When a cap fires,
report which cap fired and what work already landed; never silently retry past it.

## Progress, not elapsed time

Never wait passively. Poll a running worker and judge it by steps, tool calls, and
files written rather than by elapsed time. Two consecutive polls without progress
means the worker is stale: interrupt it and resume from its checkpoint.

## Shell commands must fail fast

Give every command an explicit timeout. Anything that may outlast a few seconds is
backgrounded and polled rather than awaited. Never traverse a FUSE-synced mount
(`pCloudDrive/`, `Insync/`): a `stat` inside a hung mount blocks uninterruptibly,
where no timeout and no signal can help. Prefer `git grep` and `git ls-files`
inside the repository.

## Work inside a repository, not in the home directory

Start sessions with `cwr`, which resolves the repository containing the current
directory and refuses to open a non-repository. The home directory contains
network mounts and is not a safe workspace.
