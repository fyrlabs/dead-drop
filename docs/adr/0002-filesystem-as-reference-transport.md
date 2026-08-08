# ADR 0002: filesystem is the reference transport, not GitHub

**Status:** accepted

## Context

The design sketch names GitHub as the Phase 2 transport, to be built first and used to validate the abstraction.

## Problem

GitHub cannot be tested. Exercising it needs a token, a repository, network access and an account, so:

- CI cannot run it.
- A contributor cannot run it.
- The abstraction it is supposed to validate would be validated by a suite that nobody can execute.

"Build one complete transport to validate the abstraction" only works if the validation is repeatable.

## Decision

The **filesystem** transport is the reference implementation and the one the end-to-end suite runs against. Two runtimes pointed at one directory exercise the entire stack — encryption, chunking, acknowledgement, discovery, proxying — with no credentials and no network.

**git** is the second transport, tested against a local bare repository. That is a real git remote, so clone, commit, push, fetch, reset and the push-race path are genuinely exercised, still with no network and no credentials.

**GitHub** is a thin layer over git that adds only what is GitHub-specific: `gh`-based authentication, repository resolution and creation, and rate-limit reporting. Its logic is tested against a scripted fake `gh` and a local bare repo. What remains unproven is the interaction with the live service, and that is recorded as a manual checklist in `docs/testing.md` rather than pretended away.

## Consequences

**Good.** The full stack is verified on every commit by anyone, in seconds. The filesystem transport is independently useful: a shared mount, an SMB share, a Dropbox or OneDrive folder, or two runtimes on one machine.

**Cost.** Live GitHub behaviour — real rate limits, real auth failures, real large-repo latency — is only covered by a human running the checklist. That is honest about where the remaining risk is instead of hiding it behind a green tick.
