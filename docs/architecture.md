# Architecture

```text
     Application (Express, Next.js, a CLI, a script)
                          │
              local socket │ or nothing at all in proxy mode
                          ▼
  ┌──────────────────────────────────────────────────┐
  │                  Bridge Runtime                  │
  │                                                  │
  │  Workspace ──── request/response, pub/sub, RPC   │
  │      │                                           │
  │  Mailbox engine ── framing, chunking, ack,       │
  │      │             dedupe, redelivery, polling   │
  │      │                                           │
  │  Transport manager ── scoring, retry, breaker,   │
  │      │                failover, health           │
  └──────┼───────────────────────────────────────────┘
         ▼
   filesystem │ git │ github │ memory │ your adapter
         ▼
   ── the same, on another machine ──
```

## Layers, and what each one is not allowed to know

**`@dead-drop/protocol`** decides what a message *is*: envelope shape, framing, encryption, chunking, the error model. Zero dependencies, zero policy. It knows nothing about transports, workspaces or applications.

**`@dead-drop/transport-sdk`** is the contract third-party adapters compile against. Deliberately tiny and deliberately stable: it is the only thing outside this repository that has to keep working across releases.

**`@dead-drop/core`** is all policy. Which transport carries a message, when to retry, when to give up, what to record. The mailbox engine and the transport manager live here.

**`@dead-drop/runtime`** turns that into a product: workspaces, exposures, discovery, the control plane, plugin loading.

**`@dead-drop/sdk` / `@dead-drop/cli`** are the two front doors.

The rule that keeps this honest: nothing above the transport manager ever names a transport. Application code cannot ask for "the GitHub one". If it could, transport independence would be a slogan rather than a property.

## Two kinds of transport

The original design sketch had every adapter implement `send`, `receive` and acknowledgement. That is the wrong shape for the transports it listed, and [ADR 0001](adr/0001-store-and-native-transports.md) records why it was changed.

Nearly everything people want to use — GitHub, GitLab, OneDrive, SharePoint, S3, Dropbox, a synced folder — is an object store with no delivery semantics of its own. Under the original design, every adapter author would have had to reimplement polling, acknowledgement, deduplication and at-least-once delivery. Most would get it subtly wrong, and each bug would be in someone else's package.

So there are two kinds:

- **`store`** — put, get, list, delete, optionally watch. Around 50 lines for a typical backend. The mailbox engine supplies the messaging semantics.
- **`native`** — the backend already is a message system. It sends and subscribes directly.

## The mailbox

Keys are readable, and time-sortable ids give rough FIFO for free:

```text
ws/<workspace>/inbox/<peer>/<messageId>.ddf     direct messages
ws/<workspace>/topic/<channel>/<messageId>.ddf  broadcast, retained then reaped
ws/<workspace>/peers/<peer>.ddf                 presence beacon
ws/<workspace>/dead/<peer>/<messageId>.ddf      dead letters
```

Sending is a write. Receiving is: list the inbox, fetch, decode, hand to a handler, delete. **Delete is the acknowledgement** — that single choice is what gives at-least-once delivery over a store that has no concept of a message.

Broadcast is different because a message belongs to every subscriber, so nobody may delete it. Subscribers keep a local cursor and ask for keys after it, and a retention reaper removes messages once they are older than the window. The reaper takes a message's age from its id rather than the store's modification time, because plenty of backends do not report one and treating "age unknown" as "old enough to delete" would destroy messages other subscribers had not read yet.

Polling adapts: it speeds up to the minimum interval while traffic flows and backs off to the maximum when idle, and a transport that supports `watch` interrupts the wait instead of polling at all. Polling a rate-limited API every 250ms forever is how a transport gets throttled.

## Transport selection

Every transport is scored 0..1 on health (45%), recent reliability (25%), latency (20%) and rate-limit headroom (10%). An open circuit breaker scores zero, so it is chosen only when nothing else exists.

An operation is retried on its chosen transport with exponential backoff and full jitter, then moved to the next. Failover is skipped for caller-side errors — those fail identically everywhere.

Policy modes: `score` (default, healthiest wins), `failover` (the operator's declared order is respected even when it is objectively slower), `parallel` (write through everything; receiver deduplication makes it safe).

## Request/response

The runtime owns correlation. A request registers a pending promise keyed by its message id, sets a TTL equal to its timeout so it cannot outlive the caller's patience, and sends. The remote peer's handler produces a `response` envelope carrying `correlationId`, which resolves the promise. A late response to a timed-out request is logged at debug and dropped, because that is normal, not an error.

Handler failures are marshalled into the response as a structured error, so `NOT_FOUND` for a missing channel and `SERVICE_ERROR` for a handler that threw arrive as distinguishable `BridgeError`s rather than strings to match on.

## Proxy mode

`bridge expose --target http://localhost:3000 --name my-api` registers a handler on the channel `http/my-api`. `bridge connect peer/my-api` starts a local HTTP server that packs each request into an envelope, waits for the response, and unpacks it.

HTTP bodies travel as raw bytes after a length-prefixed JSON head rather than base64 inside it, so proxying a 10 MB response costs 10 MB, not 13 MB.

## Observability

Structured JSON logs with credential redaction by field name and by value pattern. Counters, gauges and histograms with Prometheus text output and no client-library dependency. Spans in a bounded ring buffer so `bridge` can answer "which hop was slow" without an external collector.

All of it is at the runtime/transport boundary, so an application gets transport latency, retries, failovers and payload sizes without instrumenting anything.

## Why one runtime per machine

Polling is the scarce resource. A process per project multiplies requests against the same rate limits for no benefit. One runtime hosts many workspaces, each with its own keys, transports, mailbox and peer identity, sharing only the process and the log.
