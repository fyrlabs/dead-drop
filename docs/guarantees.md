# Delivery guarantees

Short version: **at-least-once delivery, best-effort ordering per recipient, deduplication that makes it behave like effectively-once for most handlers**.

## At-least-once

A message is deleted from the transport only after its handler returns successfully. Delete *is* the acknowledgement. If the process dies between "handler succeeded" and "message deleted", the message is delivered again on restart.

Bridge does not claim exactly-once, because the underlying transports cannot provide it. A store that can be written and deleted, with a consumer that can crash at any point, gives at-least-once and nothing stronger.

## Deduplication

Every message carries an id, or an explicit `idempotencyKey` if the sender set one. Consumed keys are recorded in a store bounded by both count (10 000) and age (1 hour), persisted to disk so it survives a restart.

The practical effect: a redelivered message is dropped rather than handed to the handler twice. Handlers that are cheap to re-run do not need to care. Handlers that charge a credit card should still be idempotent, because:

- a redelivery after the dedupe TTL expires will not be caught;
- a handler that succeeds but *then* fails to delete will be replayed;
- two runtimes sharing one peer id will both consume.

## Ordering

Messages for one recipient are stored under keys prefixed with a time-sortable id and processed in key order, so under normal conditions delivery is FIFO per recipient.

It is **best-effort**, not guaranteed, and there is one specific reason. When a handler fails, the message is scheduled for redelivery with backoff and the poller moves on to the next message. That is deliberate: blocking the queue head until a poisoned message succeeds turns one bad message into a total outage for that peer. The cost is that a retried message arrives out of order.

If you need strict ordering, put a sequence number in your payload and reorder in the handler. Bridge will not silently pretend to do it for you.

There is no ordering guarantee at all across different recipients, across transports, or for broadcast topics.

## Redelivery and dead letters

A failing handler is retried with exponential backoff (default: 5 attempts starting at 1s, capped at 60s). After the final attempt the message is copied to `ws/<workspace>/dead/<peer>/` and removed from the inbox.

Dead letters are never deleted automatically. They are evidence, and something has to look at them.

Broadcast messages are different: a subscriber's cursor has already moved past a failed event, so there is no retry. The failure is counted and logged. Treat subscribers as best-effort and use a request when you need to know it landed.

## Expiry

A message with a TTL is dropped, unacknowledged, once `ts + ttlMs` has passed. Requests set a TTL equal to their timeout, so a request nobody answered in time does not sit on the transport forever.

Clocks are not synchronised between peers. A peer whose clock is badly wrong will expire messages early or late. Bridge does not attempt to correct for this.

## Failover

An operation that fails on one transport is retried on that transport, then moved to the next one. Failover is skipped for caller-side failures — bad request, unauthorised, payload too large, unsupported — because those fail identically on every backend and retrying them elsewhere only multiplies the damage.

With `mode: "parallel"`, a message is written through every healthy transport. The receiver's deduplication is what makes that safe, and it is why parallel mode costs bandwidth rather than correctness.

## What is not guaranteed

- No exactly-once delivery.
- No global ordering.
- No transactional writes across multiple messages.
- No delivery receipt unless you use a request and wait for the response.
- No guarantee a peer that is offline will ever come back to collect its mail. Messages accumulate in its inbox until they expire; set a TTL.
