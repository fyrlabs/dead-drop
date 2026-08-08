# ADR 0003: the control plane is a Unix socket, not localhost TCP

**Status:** accepted

## Context

The design sketch (§21) lists possible mechanisms for the local runtime API: localhost HTTP, a Unix domain socket, a named pipe, platform IPC.

## Decision

A Unix domain socket with mode `0600`, and a named pipe on Windows. Never a TCP port, not even on `127.0.0.1`.

## Rationale

Anything that can reach the control plane can publish to any channel, call any peer, read runtime status and add exposures. It is the door to every workspace secret the runtime holds.

A localhost TCP port is reachable by every process running as any user on the machine, by every container sharing the network namespace, and — with a misconfigured Docker port publish or a `0.0.0.0` bind — from outside. There is no authentication step that would fix this without inventing a token scheme, storing that token somewhere, and having every client find it.

A socket file is governed by filesystem permissions, which the operating system already enforces and operators already understand. `0600` in the runtime's data directory means the owner and nobody else.

## Consequences

**Good.** No token scheme to design, distribute or leak. Permissions are visible with `ls -l`. Nothing is exposed to the network by accident.

**Cost.** A client in a different container cannot reach the runtime without mounting the socket, which is deliberate. Windows uses named pipes, so the path handling has a platform branch.

If a networked control plane is ever genuinely needed, it should be a separate opt-in listener with real authentication, not a relaxation of this one.
