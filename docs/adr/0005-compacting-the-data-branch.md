# ADR 0005: the data branch is compacted by re-orphaning it, under a lease

**Status:** proposed

## Context

The git and github transports commit every mutation. A send is a commit, the response to it is a commit, and the delete that acknowledges delivery is a third. Objects are reaped from the tree as messages are delivered, so the *tree* stays roughly the size of the undelivered backlog, but the *history* keeps every version of every message forever.

Two live GitHub runs produced 195 commits for roughly 100 messages. Nothing here has been noticed in practice because no workspace in this project is more than a few days old.

Two distinct harms follow, and they need separating because one is cosmetic and the other is fatal.

**Joining gets more expensive forever.** `initialise` does `git init` plus `git fetch origin <branch>`, which transfers every object reachable from the branch tip. Since the 0.2.5 working-tree ownership lock, a second runtime on one machine, and every `ddrop connect`, clones separately into `<workDir>.peers/` and pays that cost again on its own.

**The repository grows without bound.** This is the one that ends a workspace. Every host imposes a size limit, and a repository that only ever grows will eventually reach it and start refusing pushes, at which point the workspace stops delivering messages and no client-side setting can rescue it.

## Decision

Periodically replace the data branch with a single parentless commit holding the branch's current tree, and publish it with a compare-and-swap force-push.

The mechanism is three plumbing commands and touches neither the working tree nor the index:

```
C=$(git rev-parse origin/<branch>)              # the exact tip the tree is read from
TREE=$(git rev-parse origin/<branch>^{tree})
NEW=$(git commit-tree "$TREE" -m 'chore: compact ddrop data branch')
git push --force-with-lease=<branch>:$C origin "$NEW:<branch>"
```

`commit-tree` with no `-p` produces a commit with no parents, which is what makes the result an orphan. Reusing the existing tree object means the content is preserved bit for bit rather than rebuilt, so compaction cannot corrupt or drop a message by construction.

Four rules govern how it is invoked.

**The lease takes an explicit expected value, never the bare `--force-with-lease`.** The bare form leases against the remote-tracking ref, and this transport refreshes that ref constantly from `sync()`. A poll landing between the snapshot and the push would silently update `origin/<branch>`, make the lease agree with itself, and turn the compare-and-swap into an unconditional force-push. The `<branch>:<commit>` form is the entire safety argument and must not be simplified away.

**Any peer may compact, and there is no election.** The lease makes concurrent attempts safe: one wins, and the others are rejected against a tip that has already been compacted by somebody else. A rejected compaction is therefore not retried and not an error. It is logged at debug and dropped, because the work it wanted done is done.

**Compaction runs inside the existing flush lock, after a successful flush.** It must not interleave with `applyBatch` in our own process, and the flush lock is the mechanism that already serialises writes.

**The trigger is local history depth, and it must stay rare relative to the push-retry budget.** `git rev-list --count HEAD` is a local read. A proposed `compactAfterCommits` config field, defaulting to 500 with 0 to disable, keeps compaction roughly two orders of magnitude rarer than the `pushRetries` budget of 5 that absorbs its collisions.

## Rationale

Re-orphaning is unusually cheap here, for a reason specific to this transport: **peers need no new code to survive it.** `sync()` is already `git fetch origin <branch>` followed by `git reset --hard origin/<branch>`, and a hard reset adopts an unrelated history as readily as a descendant one. `git remote add` writes the `+refs/heads/*:refs/remotes/origin/*` refspec, whose leading `+` lets the non-fast-forward remote-tracking update through. Every peer therefore picks up a rewritten branch through the code path it already runs every five seconds.

The four safety properties were verified against real git in a two-peer lab rather than reasoned about, because the failure mode of getting this wrong is silent message loss, which is the exact class of defect that has already bitten this project twice.

| Property | Result |
| --- | --- |
| Compaction preserves the tree | depth 31 to 1, tree object identical, 30 of 30 messages present |
| An existing peer recovers unaided | peerB went 31 to 1 through plain `fetch` plus `reset --hard`, no repair code |
| A concurrent writer is protected | lease rejected with `stale info`, the other peer's message survived |
| A peer mid-flush recovers | its push was rejected `fetch first`, and the existing replay loop re-pushed it intact |

The last two matter most. Both rejection messages are already matched by `isNonFastForward`, so `applyBatch` treats a compaction it lost a race to exactly as it treats any other lost race: reset to the remote, replay the batch, push again. That path is tested and shipped. Compaction adds a new *cause* for a code path that already exists, not a new code path.

The benefit was measured on a 201-commit history holding three live messages, using the transport's own `init` plus `fetch` over `file://`, which forces real pack negotiation:

| | Objects transferred | Clone size | Depth |
| --- | --- | --- | --- |
| Uncompacted | 803 | 588K | 201 |
| Compacted | 10 | 160K | 1 |

Critically, that measurement was taken against a remote that had **not** been garbage collected, which is the only case that matters because no client can make GitHub run a gc. A fetch transfers what is reachable from the advertised ref, and after compaction only the live tree is reachable. The join cost therefore drops immediately, before the host reclaims anything.

### What was rejected

**A shallow fetch (`--depth=1`), and this one is not a strawman.** It was tested and it works: a shallow peer joined the 201-commit remote at 124K, pushed a message back successfully (exit 0), and stayed shallow across an ordinary sync. It needs no force-push and destroys nothing, which makes it strictly safer than compaction.

It is rejected as *the* answer because it fixes only the first harm. The repository on the host still grows forever, and a workspace that dies against a size quota in a year is not fixed by making each peer's copy of the problem smaller. Shallow fetching is a good idea on its own merits and should be considered separately; it is complementary to this decision, not an alternative to it. It also has a tail of its own: a shallow peer accumulates every commit made after it joined, so a long-lived one drifts back toward the same problem unless it periodically re-shallows. That tail was not measured.

**Deleting and recreating the branch.** Strictly worse than a leased force-push. There is a window in which the branch does not exist, and any peer calling `initialise` in that window takes the create-orphan path and races to publish a competing branch.

**An epoch scheme, a new branch per generation.** Solves the same problem with more moving parts, and every reader has to discover which epoch is current before it can read anything. The force-push is not avoided so much as renamed into a branch deletion.

**Rewriting history with `filter-branch` or `filter-repo`.** Same force-push, same lease requirement, far slower, and pointless: nothing here needs the intermediate commits rewritten, only discarded.

## Consequences

**Good.** A workspace becomes survivable over months instead of days. Join cost stops being a function of workspace age, which matters more since 0.2.5 than it did before, because every extra runtime and every `ddrop connect` pays it separately. Existing peers need no new code, no migration, and no coordination.

**Cost: this is a force-push, and force-pushes destroy things.** The entire safety of the design rests on one flag holding an explicit expected value. Remove the lease, or let it degrade to the bare form, and this becomes a routine that silently deletes other peers' undelivered messages. That is the single claim to protect with a test that would have caught its absence, not a test that covers its presence.

**Cost: a peer mid-fetch when compaction lands.** It ends up in one of two states, and neither loses data. Either its fetch completes against the tip it was advertised and it simply holds the old history for a few seconds, until the next `sync()` inside `freshnessMs` hard-resets it onto the compacted branch; or its fetch fails because the host stopped serving objects the branch no longer reaches, in which case it surfaces as a retryable transport error, `ensureClone` clears its memoised failure, and the next attempt succeeds against the new tip. The second case is the more likely one on a host that has already gc'd and the less likely one on GitHub, which keeps unreachable objects around well past the seconds this window lasts. Neither branch of that was reproduced against a real host, because racing a live GitHub fetch is not something this lab could do reliably: it is reasoned from the protocol and from the existing retry behaviour, and it should be checked on the next live tier run.

**Cost: nobody's disk shrinks on its own.** An existing peer's clone keeps the old objects until it runs `git gc`; measured, a peer sat at 3.7M and fell to 136K only after `reflog expire --expire=now --all` plus `gc --prune=now`. The host keeps them until its own gc, which we cannot trigger. Compaction fixes what a *new* peer pays, immediately. It does not fix what an *old* peer already holds, and pruning local clones is a separate decision that this ADR does not take.

**Cost: the history is the only record that a message ever existed, and this destroys it.** Delivery is delete-as-acknowledgement, so today the data branch's commit log is the sole place a delivered message survives at all. Nothing reads it and no feature depends on it, so nothing breaks. But it forecloses the accidental audit trail that a "completed jobs" view might otherwise have been tempted to mine, and that is a point in favour of the position already recorded in the backlog: an audit story needs designing deliberately, because commit history is metadata the encryption exists to protect and it should not become a feature by default.

**Cost: `git log` stops being a debugging tool for a workspace.** Anyone inspecting a data branch by hand loses everything before the last compaction.

**Degradation is graceful.** If the branch is protected against force-pushes, or the host refuses the lease for any other reason, compaction fails, the failure is logged, messages keep flowing, and the history keeps growing exactly as it does today. This can never take a workspace down; it can only fail to help.
