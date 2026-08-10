# ADR 0006: any member may reap an orphaned inbox, on age plus absence

**Status:** proposed

## Context

Nothing ever deletes a message from a peer's inbox except that peer. Verified in the code as it stands:

- `core/mailbox.ts:434` polls `inboxPrefix(workspace, this.peerId)`, the peer's own inbox and nothing else.
- TTL expiry (`mailbox.ts:548`, `messagesDropped{reason:'expired'}`) fires inside that peer's own delivery loop, so it never runs for a peer that is gone.
- `reapTopics` (`mailbox.ts:700`) covers broadcast topics only.
- `inboxRoot`, the all-peers prefix, is listed by exactly one caller: the read-only `queues()` diagnostic at `runtime/workspace.ts:575`, which deletes nothing.

So a message addressed to a peer that never comes back is unreachable garbage that no process will ever remove. This is not theoretical. After compacting `sathvikc/dead-drop-trial-2` from 3,075 commits and 433 MB down to a single commit, **60 MB survived for a live tree of 17 files**, almost entirely two abandoned 30 MiB payloads in the inboxes of dead ephemeral peers (`peer-b-c2192`, `peer-b-c14c9e`) plus stale presence beacons.

It bites because of how the product is normally used. Every `ddrop connect` runs its own runtime under an ephemeral `<configured>-c<pid-hex>` identity, so each invocation can strand whatever was in flight when it exited. Compaction does not help, and that is deliberate: [ADR 0005](0005-compacting-the-data-branch.md) preserves the live tree by design, so an orphaned object is carried into the compacted commit intact.

## Decision

Two reapers, running after `reapTopics()` on the same poll cycle and the same throttle, deliberately asymmetric in how aggressive they are.

**Stale presence beacons, reaped aggressively.** Any peer deletes a beacon at `ws/<workspace>/peers/<peer>.ddf` whose `announcedAt` is older than a small multiple of `presenceTtlMs`.

**Orphaned inbox objects, reaped conservatively.** Any peer deletes `ws/<workspace>/inbox/<peer>/<id>.ddf` only when all three hold:

1. `<peer>` is not this peer, which already reaps its own inbox by delivering from it;
2. the object is older than `inboxOrphanMs` (default 7 days, `0` disables), taken from `idTime` on the message id in the key;
3. the owning peer has no beacon at all, or a beacon older than `inboxOrphanMs`.

Age is read from the key. Nothing is downloaded and nothing is decrypted to make the decision.

## Rationale

### Who may delete, and why "any member" grants nothing new

This is the security question, and it has a clean answer: **reaping is not a new privilege.**

Every member already holds the workspace secret, so every member can already fetch and decode any object in any inbox. Every member already has unrestricted `delete` on the store, because authorisation lives in the transport's own access control and not in dead-drop. `allowPeers` is documented in [docs/security-model.md](../security-model.md) as a guardrail rather than a boundary, and it cannot be used with `ddrop connect` at all. A hostile member can wipe every inbox in the workspace today, with no code from this ADR.

What does change is that **correct** peers now delete data they did not author and cannot confirm is unwanted. So the risk worth designing against here is accidental loss, not privilege escalation, and that is what sets the two horizons below.

### Why beacons and messages get different aggressiveness

A beacon is self-healing. A live peer rewrites it every `presenceIntervalMs` (30s by default), so deleting one wrongly costs at most one interval of that peer being invisible to `discover`, and the next beacon repairs it with no intervention.

A message is not self-healing. Deleting one wrongly is unrecoverable, and surviving the recipient's absence is the entire job of a mailbox. The two cases deserve different levels of caution, and collapsing them into one horizon would either leak beacons for a week or destroy mail in minutes.

### Age comes from the key, never from the payload

`parseInboxKey` already returns the message id, and `idTime` already decodes a creation timestamp out of it. Two reasons this is the right source:

**Cost.** The objects worth reaping are the large ones: the measured leak is two 30 MiB payloads. Deciding by download would mean fetching every object in every inbox on every cycle, which is reading the entire leak in order to decide to delete it.

**Availability.** `modifiedAt` is optional in the store contract and is whatever the backend felt like reporting, while the id is the sender's own clock and is always present. This is the same reasoning `reapTopics` already applies at `mailbox.ts:716`, and the "age unknown is not old enough to delete" lesson that produced it.

**This is not TTL and must not be described as one.** `isExpired` reads `ttlMs` and `ts` from the envelope header, and that header is encrypted. Honouring a message's real TTL from outside its recipient would require decrypting every candidate. `inboxOrphanMs` is therefore a separate and much longer horizon: a backstop against abandonment, not an expiry mechanism. A message with no TTL at all is still subject to it.

### Why absence of a beacon is the liveness signal

`stop()` calls `withdraw()` (`workspace.ts:290` and `:844`), which deletes the peer's own beacon. So a cleanly exited peer leaves **no beacon** behind and, if anything was in flight, a populated inbox. That is exactly the measured case. A peer that crashed instead leaves a beacon that simply stops being refreshed and goes stale. The condition "no beacon, or one older than the horizon" covers both, and `discoverPeers({ includeStale: true })` already returns announce times for every beacon it can read.

Age on its own would be wrong. A peer offline over a holiday, or one with a slow handler, has old messages in its inbox and is not orphaned. Requiring both conditions is what separates "gone" from "not looking right now".

### What was rejected

**Reaping by peer-id shape**, matching the `<configured>-c<pid-hex>` pattern that `ddrop connect` generates. It identifies the measured culprit precisely, and it is the wrong mechanism: it hard-codes a naming convention into a destructive operation, and it misses every orphan that did not come from `connect`.

**An owner, or an elected reaper.** No election exists, and ADR 0005 already set the precedent that any peer may perform maintenance when the operation itself is safe. A single designated reaper is also a single point of failure for a leak that only matters over months.

**Honouring the real per-message TTL by decrypting candidates.** Correct, and it costs a full download of everything under consideration on every cycle. See above.

**Sender-side expiry**, where the sender cleans up what it sent. By the time a message is orphaned the sender is usually gone too, since the common case is an ephemeral `connect` peer on both ends.

**Doing nothing, on the grounds that compaction bounds the repository.** Measured to be false: 60 MB survived compaction, and it survives every future compaction too, because preserving the live tree is what compaction is for.

## Consequences

- A workspace's steady-state size stops depending on how many `ddrop connect` invocations it has ever seen. That is the point.
- **A peer offline for longer than `inboxOrphanMs` can lose mail.** This is the real cost and it must be stated at the config field and in the security model, not buried. The 7 day default sits far beyond a closed laptop and far below "forever"; `0` disables reaping and restores today's behaviour exactly.
- Reaping logs at warn, naming the peer, the object count and the bytes. A destructive maintenance action that runs unattended has to be visible in `ddrop logs`, for the same reason ADR 0005's refused compaction is.
- Invariant 9 is untouched. The reaper reads object keys, which already carry workspace and peer names by documented design, and it decrypts nothing.
- A failed or refused delete must not be retried every cycle. This is the trap ADR 0005 hit: a maintenance condition that stays true after a failure turns into a wasted network call on every single poll, forever.
- Clock skew between peers shifts the effective horizon by the skew. At a 7 day horizon the skew would have to be extraordinary to matter, which is another reason not to reuse this mechanism for short windows.

## Open question for whoever implements it

**Where the reaper lives.** `reapTopics` sits in `MailboxEngine` (core), which owns the poll loop and the throttle, but the liveness signal comes from beacons, which `Workspace` (runtime) owns. Core must not depend on runtime, so the choice is either to pass a liveness callback down into the engine, or to put the reaper in `Workspace` beside `queues()`.

**Recommend `Workspace`.** `queues()` already lists `inboxRoot` and already parses the keys, so the listing half is proven code, and it keeps a destructive policy decision out of the layer that is meant to be pure mechanism.

**The test that has to discriminate**, in the style this repo already requires: a peer that is merely offline, with a fresh beacon and old messages, must keep every message. Write that one before the happy path, because the happy path passes just as well against a reaper that deletes indiscriminately.
