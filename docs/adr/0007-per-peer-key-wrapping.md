# ADR 0007: the shared secret becomes an enrollment token, and a per-era key is wrapped per peer

**Status:** proposed, not implemented

## Context

One 32-byte secret is the whole security model. `protocol/crypto.ts:5` states it plainly: possession of the secret *is* membership, there is no PKI and no per-peer identity. `deriveWorkspaceKey` (`crypto.ts:68`) HKDFs that secret straight into the AES-256-GCM key every frame is sealed under.

Three consequences follow, and the third is the one that blocks adoption.

Adding a machine means handing over the key that decrypts everyone's traffic, forever, including everything already written. Removing a machine means every remaining peer takes a new secret, because the only way to stop the leaver reading is to stop using the key it holds. And there is no way to say "this peer may read from now on" without also saying "this peer may read everything from before", because there is only one key and it has no notion of who it was for.

What already exists, and is the reason this is a smaller change than it sounds:

- Frames carry a key id. `frame.ts:8-9` puts `keyIdLen` and `keyId` in the clear header, outside the ciphertext and inside the AAD (`frame.ts:95`).
- `KeyRing` (`crypto.ts:116`) already holds an active key plus every key still accepted during a rotation, and `crypto.ts:144` already reports an unknown key id with the list it does know.
- `crypto.ts:12` already declares that a departing peer triggers a rotation and that the key id is what makes an overlap possible.
- Object keys already carry peer names in the clear, on purpose, and [invariant 9](../../AGENTS.md) documents that as the deliberate exception rather than a leak to be fixed.

So the protocol was built expecting more than one key to be in play. Nothing has ever put a second one there.

The user's constraint, stated 2026-08-11: anyone may join at any time, no owner approves and no ordering is implied, and onboarding must stay very easy, with stronger verification available to those who want it rather than mandatory for everyone.

## Decision

The secret stops being a data key and becomes an enrollment token. Data moves under per-era symmetric keys that are wrapped to each peer individually.

**Identity.** Each peer generates an X25519 keypair on first start and keeps the private half in `.deaddrop/identity`, mode 0600, beside the secret. X25519 because the wrap is a Diffie-Hellman, and Ed25519 cannot do DH; Node v26.7.0 provides both natively so no dependency is added, which keeps [invariant 6](../../AGENTS.md) satisfied without argument.

**Enrollment.** A peer publishes its public key at `ws/<workspace>/ids/<peer>.ddi`, carrying the key plus a proof:

```text
proofKey = HKDF(secret, info = "dead-drop/v1/enrollment")
proof    = HMAC-SHA256(proofKey, workspace || peerId || publicKey)
```

A peer accepts an identity only if the proof verifies. Whoever holds the secret can enroll at any moment, with no existing peer online and no approval step, which is the property the user asked for. Whoever controls the transport but not the secret cannot forge a proof, which is the property the threat model requires, since `crypto.ts:7` treats the store as hostile.

**Era keys.** An era key is 32 random bytes, and its id is the existing scheme: the first 8 hex chars of SHA-256 over the derived key. Frames do not change in any way. `keyId` already means "which key sealed this", and that is exactly what it goes on meaning.

**Wrapping.** For each recipient, the era key is sealed to that recipient's public key by X25519 ECDH into HKDF into AES-256-GCM, and published at:

```text
ws/<workspace>/keys/<eraId>/<peer>.ddw
```

A peer reads the objects under its own name, unwraps each with its private key, and loads the results into the `KeyRing` that already exists. Several eras being live at once is not a special case; it is what `KeyRing` was written for, and its asymmetry is exactly what this needs: sealing always uses the primary, opening tries whichever key id the frame names (`crypto.ts:117`). So a peer seals under one era of its own and reads any era it has been given.

**Joining, concretely.** A joiner starts, publishes its identity with a proof, mints its own era key, and wraps that era for every identity it can verify. It can send immediately. It becomes readable-to itself the moment any existing peer notices the new identity and publishes a wrapped copy of that peer's era, which happens on an ordinary poll with no human involved.

**Removing a peer.** Mint a new era, wrap it for everyone except the leaver, and stop sealing under the old one. Nobody redistributes a secret and nobody else re-keys. The leaver keeps whatever it already had, which is unavoidable and true of every scheme.

**The opt-in strict tier.** `"enrollment": { "requireApproval": true }` withholds wrapping from a newly seen identity until a human runs `ddrop peer approve <peer> <fingerprint>` with a fingerprint compared outside the transport. Off by default. This is the knob for operators who do not trust their transport at the moment of enrollment, and it is the only part of this that costs a step.

**Encryption itself never becomes optional.** Not as a flag, not as a default, not as a "just for testing" path.

## Rationale

### Why frames are left alone

The alternative is to carry wrapped keys inside each message, which is how a lot of encrypted-mail tooling does it. It is worse here on three counts that are easy to check. Every frame grows by one wrapped key per recipient. The recipient count becomes visible on every object, which is a new class of metadata leak rather than an extension of the documented one. And a broadcast to a topic has no recipient list at write time, because subscribers are discovered by polling, so there is nothing to enumerate when the frame is sealed.

Putting the wrapped keys in their own objects keeps the frame format byte-identical, moves the metadata cost into the key layout that already leaks peer names by design, and lets a topic frame be sealed once for an era rather than once per subscriber.

### Why the secret survives rather than being replaced

Because the alternative hands membership to the transport. If a peer enrolls by publishing a public key with no proof, then whoever can write to the store can enroll themselves, and for a private GitHub repository that is GitHub. Today GitHub cannot read a workspace's traffic under any circumstances, because the secret never goes near it. That property is the difference between dead-drop and a shared private repository, and trust-on-first-use would trade it away for the removal of a flag that the join command already fills in from stdin.

Keeping the secret as a proof key costs nothing at the surface: `ddrop init --github <owner>/<repo> --secret -` is unchanged, one command, exactly as it ships in 0.12.0.

### What the metadata cost actually is

`ids/` and `keys/<era>/` expose peer names and a peer count to anyone who can read the store. Peer names are already exposed by `peers/<peer>.ddf` and `inbox/<peer>/`, and invariant 9 covers that explicitly. The genuinely new fact is the count of peers per era, which is a coarse membership-size signal. It is small, it is stated here rather than discovered later, and it does not touch frame contents, so invariant 9 holds as written.

### What was rejected

**Trust on first use, no secret at all.** Simplest possible onboarding and it dissolves the threat model, as above. Rejected on the grounds that it removes the reason the project encrypts anything.

**Mandatory out-of-band fingerprint approval.** Strongest option, and the only one that survives a transport compromised at the moment of enrollment. It adds a manual step to every new machine, against the stated direction that usability must not mean long steps, so it ships as `requireApproval` for those who want it instead of as the default for everyone.

**Per-pair keys with no shared era key.** Removes the era concept and with it any efficient broadcast: a topic message would have to be sealed once per subscriber, by a writer that does not know who the subscribers are. Rejected on the same reasoning that keeps wrapped keys out of frames.

**Optional encryption, or a plaintext mode for easy onboarding.** Rejected outright. A user who believes traffic is protected and is wrong is worse off than one who knows it is not, and the frame format already supports `keyIdLen = 0` for unencrypted frames, which is a foot-gun that should not gain a config surface pointing at it.

## Consequences

**Migration has a clean shape and it must be built deliberately.** The secret-derived key of today is deterministic, so a 0.12.0 workspace's key id is computable by a new build. New peers keep deriving that key, keep accepting it as an era, and publish an identity alongside it, so a partially upgraded workspace keeps working in both directions. The old era stops being used only when an operator runs an explicit rotate. Without this, upgrading one machine silently partitions the workspace, which is the failure mode most worth a scenario test.

**A peer can be enrolled but deaf, and that state needs to be visible.** An identity published with nobody yet having wrapped an era for it decodes nothing and looks exactly like a wrong secret. `ddrop peers` and `ddrop status` have to name that state, or the first support question is unanswerable. `crypto.ts:144` already reports the key ids it holds, which is the right raw material.

**The reapers need teaching about two new prefixes.** [ADR 0006](0006-reaping-orphaned-inboxes.md) deletes objects it judges orphaned, keyed on age plus absence of a beacon. An identity object and a wrapped era key are long-lived by nature and belong to a peer that may be offline for weeks. If they fall under the reaper's judgement they will be collected and the workspace will quietly lose the ability to admit or address that peer. They must be excluded explicitly, and a test should assert the exclusion rather than the code merely happening to skip them.

**Compaction is already correct here.** [ADR 0005](0005-compacting-the-data-branch.md) preserves the live tree, so wrapped keys and identities survive a compaction without special handling.

**Losing `.deaddrop/identity` is now a real loss.** A peer that loses its private key cannot read anything wrapped for it, and recovery is re-enrolling under a new identity with the secret. That is a new backup consideration that did not exist when the secret was the only material.

## How it should be settled

Every claim in this record that starts "already" was read in the code at the commit that adds this file, not remembered. The design is unimplemented, so nothing here is verified behaviour yet, and the two places most likely to be wrong are the migration path and the reaper interaction. Both deserve mutation-verified tests rather than reasoning, on the standard set by ADR 0006: remove the guard, watch a named test fail.
