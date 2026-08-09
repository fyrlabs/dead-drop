# ADR 0004: `ddrop dashboard` binds a TCP port, and is a control-socket client

**Status:** accepted

## Context

Everything a read-only dashboard would show already exists as structured control-plane data: peers and their exposures (`/peers`), transports and health (`/transports`), runtime and mailbox state (`/status`), queued depth per peer (`/queues`), logs, traces and Prometheus metrics.

A browser cannot open a Unix socket. So a dashboard needs an HTTP listener on a TCP port, and [ADR 0003](0003-unix-socket-control-plane.md) and invariant 3 say the control plane is a socket or a named pipe, never TCP. At a glance the two are in direct conflict, which is why this record exists.

## Decision

`ddrop dashboard` binds an HTTP server on `127.0.0.1` and serves a static page plus a read-only JSON API. It reaches the runtime the same way `ddrop status` does: as a client of the control socket. It constructs no `DeadDropRuntime`.

Three properties make that not a relaxation of ADR 0003:

1. **The control plane is unchanged.** It is still a socket at mode `0600`. The dashboard is another local consumer of it, in the same category as `ddrop status`, `ddrop discover` and `ddrop logs`. Nothing about the runtime's listener moves.
2. **The dashboard is read-only.** It exposes no route that publishes, calls, exposes, cancels or retries. The socket's write routes (`/publish`, `/call`, `/expose`) are not proxied.
3. **It binds `127.0.0.1` explicitly, never `0.0.0.0`.** The port is a view of data the operator can already read from their own terminal, held open by a process they started in the foreground and which exits when they stop it.

Only `ddrop start` and `ddrop connect` construct a runtime. The dashboard does not join that list.

## Rationale

ADR 0003 rejects TCP because *the control plane* is the door to every workspace secret: it can publish to any channel, call any peer and add exposures, so a port reachable by every process and every container sharing the network namespace is the wrong door. The threat is the capability behind the listener, not the transport of the listener.

A read-only view carries a much smaller capability, and it is a capability the browser's user already holds by virtue of being able to run `ddrop status`. Keeping the dashboard read-only is what preserves that argument, so it is a constraint of this decision and not a first-release simplification.

**The decisive reason is narrower than "TCP is riskier than a socket", and it is specific to browsers.** A localhost HTTP server is reachable not only by every local process, which is ADR 0003's argument, but by any web page the user visits: a page can issue requests at `127.0.0.1` from the user's own browser. Defending state-changing endpoints against that needs Origin validation, CSRF tokens and DNS-rebinding-resistant Host checks, three things that are each easy and are collectively easy to get subtly wrong. When every endpoint only reads, the worst outcome degrades from an action taken to information disclosed.

**A dashboard that could cancel or retry a job would be a control surface reachable from a browser, and it would need this ADR reopened, not extended.** Note also what such a button would have to be built on: nothing in the runtime cancels a queued message today, and redelivery is already automatic, so "make the dashboard writable" is two decisions stacked — whether to build a job-control primitive at all, and whether to put it on a browser-reachable port. Request-level retry in particular is already deferred elsewhere for a reason that does not go away here: delivery is at-least-once and `idempotencyKey` dedupes per runtime only, so retrying onto a second worker runs the job twice with neither side able to notice, and no backend offers the compare-and-swap needed to fix that. Keep the two decisions apart.

The second half of the decision matters more than the TCP question, because the tempting implementation is the wrong one. `ddrop connect` builds a `DeadDropRuntime` from the user's config, and copying it would give the dashboard all three of `connect`'s collisions with whatever the user is actually sharing:

- **`workDir` ownership.** A git working tree has one writer. The ownership lock added in 0.2.5 catches the second runtime and forces it into `<workDir>.peers/`, so every dashboard session would clone the whole data branch.
- **Phantom peers.** A runtime publishes presence beacons under an ephemeral `<configured>-c<pid-hex>` identity, so every dashboard session would appear in every peer's `ddrop discover` as a peer that answers nothing.
- **Unbounded commits.** On the git and github transports each beacon is a commit and a push. A dashboard left open all day would write commits all day, into a history that already grows without bound.

A dashboard that only reads needs no runtime, no `workDir`, no peer id and no beacons. That is the general rule the `workDir` bugs already taught: dead-drop's own machinery must not entangle itself with the thing the user is sharing.

## Consequences

**Good.** No new capability is reachable from the browser that was not already reachable from the operator's shell. The control plane keeps its single socket and its single set of routes. The dashboard adds no writer to any transport, so it costs nothing on the data branch and does not appear in discovery.

**Cost, and the constraints that follow from it.**

- The port is a genuine listener on the machine, so it takes an explicit `--port`, defaults to a port `ddrop connect` does not hand out, and fails loudly on `EADDRINUSE` rather than hunting for a free one. A dashboard that silently moves is a dashboard nobody can bookmark.
- Anything with local access can read workspace metadata (peer names, channel names, queue depths, and through logs and traces rather more than that) from the port for as long as it is open. The names themselves are already in the clear in the store's object keys (invariant 9), but that is not the same disclosure: the store is readable by workspace members, whereas this port is readable by any process on the machine and by content the user's browser loads. It is a smaller audience shift than a write capability would be, and it is still a real one, so the port is bound to `127.0.0.1`, is opened only for as long as the foreground command runs, and is documented as carrying workspace metadata.
- Opening a browser is a convenience, not a step the command depends on: the URL is printed *before* the open is attempted, `--no-open` skips it, and a failed open never fails the command. dead-drop runs on headless machines as an ordinary deployment, where `open` fails or hangs.
- The dashboard can only show what the control plane already returns. "Completed jobs and who requested them" is not among it, because delivery is delete-as-acknowledgement and no record of a finished job survives. That needs a retention store, which changes what the runtime keeps and therefore touches the security model. It is a separate decision, not an extension of this one.

## Alternatives rejected

**Serve the dashboard from the runtime itself, on the control plane.** This is the shortest path and the worst one: it puts a TCP listener on the process holding the secrets, which is exactly what ADR 0003 forbids, and it makes every `ddrop start` a web server whether or not anyone wants one.

**A terminal UI instead (`ddrop top`).** Genuinely appealing, needs no port at all, and it remains worth building on its own merits. It is not a substitute: the ask was something to leave open on a second monitor and hand to someone who does not use the CLI.

**Load the frontend library from a CDN.** Rejected on principle. The product exists to work through infrastructure you already have, sometimes offline, so a dashboard that needs the internet to render contradicts it. The library is vendored into the CLI package's static assets, which also keeps it out of the dependency tree and leaves the zero-runtime-dependency claim intact.
