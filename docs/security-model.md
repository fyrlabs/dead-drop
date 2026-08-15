# Security model

Read this before deciding dead-drop fits your situation. It states what is protected, what is not, and where the sharp edges are.

## The secret admits you; a key era is what you read with

A workspace has one 32-byte secret, and every peer holds it. Possession of the secret is what lets a machine *join*: it publishes an X25519 public key with a proof only a secret holder can compute, and from then on it is a peer with a key of its own ([ADR 0007](adr/0007-per-peer-key-wrapping.md)).

What frames are actually sealed with is a **key era**. Until somebody runs `ddrop rotate`, the era is derived from the secret, so every holder of the secret computes it and the paragraph above is the whole story. A rotation mints 32 random bytes instead and wraps them to each enrolled peer's public key, so from that point on reading depends on having been wrapped for, not on holding the secret.

That is what makes removal possible. Everything else follows from what the era does not change:

- Any peer holding the current era can impersonate any other peer. `from` in an envelope is a claim; there are no signatures.
- Any peer holding the current era can read every message sealed under it, including ones addressed to other peers.
- Any peer can delete every message in the workspace. Authorisation over the store belongs to the transport, not to dead-drop.
- **Removing a peer is a rotation that leaves it out.** It cannot read anything written afterwards. It can still read everything written before, because those frames were sealed under an era it holds and nothing re-encrypts history. Read the next section for who a rotation actually leaves out: by default, nobody.

If you need peers that can send but not read, or an audit trail that survives a malicious member, dead-drop is the wrong tool. That would need signed envelopes, which is a protocol change rather than a configuration change.

## Enrolling, rotating, and approving

**Enrolling costs nothing and needs nobody.** A peer writes `ws/<ws>/ids/<peer>.ddi` holding its public key and `HMAC(HKDF(secret, "dead-drop/v1/enrollment"), workspace‖peer‖publicKey)`. Anyone with the secret can mint that proof with nobody else online, which is what keeps joining a single command. Identity objects are not encrypted: a public key is public, and what it needs is authentication.

**Who a rotation leaves out, exactly.** By default, nobody: it wraps for every identity carrying a valid enrollment proof, so it changes the key without removing anyone. That is the right default for a workspace where everybody belongs, and it is the wrong one if you are trying to remove somebody. Removal is `requireApproval` below, where `ddrop peer revoke <peer>` followed by `ddrop rotate` leaves that peer out of every era from then on. Deleting a peer's identity object from the store also works and is not durable: the peer republishes it the next time it starts.

**Rotating hands out a new era.** `ddrop rotate` mints a random era key, wraps it to every verified identity at `ws/<ws>/keys/<peer>/<era>.ddw`, publishes an authenticated pointer at `ws/<ws>/era.dde`, and starts sealing under it. Old eras stay in the ring, so a message written a second before a rotation still opens. A rotation refuses outright if any store failed to list identities, because a peer that is merely unreachable through one transport looks exactly like a peer that does not exist, and wrapping only for the visible ones would deafen the rest.

**Every object in that path carries a proof under a secret-derived key, and each stops a different attack:**

| Object | Proof | Without it |
| --- | --- | --- |
| Identity | `dead-drop/v1/enrollment` | Anyone who can write to the store enrols themselves and is wrapped for on the next rotation. |
| Wrapped key | `dead-drop/v1/key-wrap-proof` | Anyone who can write to the store mints an era, wraps it to a peer, and then forges a request from any peer they like: a frame names its key id in the clear, and the sender is only a field. |
| Era pointer | `dead-drop/v1/era-pointer`, plus a counter that must advance | The store chooses what every peer seals under, or replays the pointer from before a rotation to walk the workspace back onto an era the removed peer still holds. |

**The approval tier, off by default.** All three proofs are computed from the workspace secret, so they answer "does this come from a secret holder" and nothing more. A transport operator who has somehow obtained the secret passes every one of them. `"enrollment": { "requireApproval": true }` is the answer to that: a rotation then wraps only for peers whose fingerprint a human approved with `ddrop peer approve <peer> <fingerprint>`, compared over a channel the transport cannot see. `ddrop peer list` prints the fingerprints. The approval records the fingerprint rather than a bare yes, so a peer that later republishes a different key under the same name stops being approved instead of inheriting the decision, and the listing says the key changed rather than merely that it is unapproved.

`ddrop peer revoke <peer>` takes an approval back. It changes nothing on its own, and the command says so: the revoked peer holds the era everybody is currently sealing under, and only the next rotation replaces it. Approvals are per machine and gate the rotations that machine performs, so in practice one peer does the rotating.

It is off by default because it is the only part of this that costs a step, and switching it on changes nothing for peers that already read: it governs who the *next* rotation wraps for.

**What a peer sees when it has been left out.** It keeps announcing and keeps writing, and can no longer read anybody. From outside that is indistinguishable from a wrong secret, so `ddrop peer list` reports the era it is waiting for, and the runtime logs a warning naming it.

## What the transport sees

The transport is treated as hostile storage. A GitHub repository, a synced folder or an S3 bucket may be readable by people who are not in the workspace, so:

**Encrypted.** The entire envelope: payload, channel, `from`, `to`, headers, correlation ids, content type. All of it is inside AES-256-GCM ciphertext.

**Not encrypted, but authenticated.** The frame magic, the flags byte and the key id. Tampering with them fails decryption.

**Not protected at all.** These are visible to anyone who can read the store:

- Object keys: `ws/<workspace>/inbox/<peer>/<messageId>.ddf`. Workspace names, peer names and channel names for broadcast topics appear here in clear text.
- Message sizes, counts and timing.
- Which peers exist and roughly when they are active.

Keys are readable on purpose. When the transport is a git repository or a folder someone has to operate, being able to look at it and understand what is there is worth more than the metadata it costs. If that trade is wrong for you, use a transport whose backing store is private.

## Cryptography

- Secret: 32 random bytes from `crypto.randomBytes`, printed as `ddk1_<base64url>`.
- Key derivation: HKDF-SHA256, salt = workspace name, info = `dead-drop/v1/workspace-aead`. Salting by name means the same secret in two differently-named workspaces yields unrelated keys, so a frame cannot be replayed across them. Every proof in ADR 0007 derives its HMAC key the same way, with its own info string.
- Encryption: AES-256-GCM with a fresh random 96-bit IV per frame. The frame preamble is the additional authenticated data.
- Key id: first 8 hex characters of SHA-256 over the key. Not secret; it exists so a receiver can pick the right key, and it is what a frame names in the clear.
- Peer identity: X25519, generated on first start, kept at `<dataDir>/<workspace>.identity`.
- Era key: 32 random bytes, wrapped per recipient with X25519 ECDH from an **ephemeral** sender keypair into HKDF-SHA256 (`dead-drop/v1/key-wrap`) and AES-256-GCM. Ephemeral, so a wrapped object does not say which peer wrote it and a stolen identity key cannot retroactively open wraps it never received.
- Fingerprint: first 16 hex characters of SHA-256 over the public key, in groups of four. Non-secret, and what `ddrop peer approve` compares.

## Rotating the secret

This is a different operation from `ddrop rotate`, which changes the era. Rotate the era to remove a peer; rotate the secret when the secret itself may have leaked. Frames name the key they were sealed with, so old and new keys can be accepted at once.

1. `ddrop keygen` produces the new secret.
2. Add it to **every** peer's config as the *second* entry: `"secrets": ["<old>", "<new>"]`. Restart. Peers now accept both, still encrypt with the old.
3. Once every peer is updated, swap the order: `"secrets": ["<new>", "<old>"]`. Restart. Peers now encrypt with the new and still accept the old.
4. After the longest plausible in-flight message TTL, drop the old secret entirely.

Skipping step 2 breaks every peer that has not been updated yet.

## Where secrets live

- **Not in the config file.** `ddrop init` writes `"${file:.deaddrop/secret}"` and puts the generated secret in that file. The parser also expands `${env:NAME}`, so a secret manager or the environment works instead.
- **Beside the workspace state, at mode 0600.** `<dataDir>/<workspace>.identity` holds this peer's X25519 private key and `<workspace>.era` the era it last sealed under. Anything that can read the first can obtain every era ever wrapped for this peer, so they are the same exposure rather than two. `<workspace>.approvals.json` is not secret: knowing a fingerprint grants nothing. Neither the identity nor the era has a config field naming its path, deliberately, and neither is ever logged or sent over the control socket.
- **Not in application processes.** Applications talk to the runtime over a local socket. Transport credentials and workspace secrets stay in the runtime.
- **Not in logs.** The logger redacts values by field name (`token`, `secret`, `authorization`, …) and by pattern (`ddk1_…`, `ghp_…`, `glpat-…`, AWS key ids, Slack tokens), including inside the message text and nested objects.
- **Not in git remote urls we print.** Inline credentials in a remote url are stripped before any error reaches a log.

## The control plane

The runtime listens on a Unix domain socket with mode `0600`, never on localhost TCP.

This matters more than it looks. A localhost TCP port is reachable by every process on the machine, by every container sharing the network namespace, and in some configurations from outside. A socket file is governed by filesystem permissions. Anything that can talk to the control plane can publish, call any peer, and read runtime state, so it is the door to the whole workspace.

## Exposures

`ddrop expose --target http://localhost:3000` makes that server reachable by every peer in the workspace. There is no per-request authentication beyond workspace membership.

- Use `allowPeers` on an exposure to restrict it to named peers. Remember that peer names are self-asserted, so this is an organisational control, not a security boundary.
- Static exposures resolve every path inside the configured root and reject traversal; percent-encoded `..`, absolute paths and null bytes are all handled.
- The proxy strips hop-by-hop headers in both directions and never follows upstream redirects on your behalf.

## Denial of service

dead-drop bounds what it will accept, because the transport is shared and a peer can be malicious or broken:

| Limit | Default | Setting |
| --- | --- | --- |
| Decoded frame size | 64 MiB | `maxMessageBytes` |
| Decompressed frame size | same, enforced by zlib | `maxFrameBytes` |
| Chunk group size and count | 64 MiB, 256 groups | `ChunkAssembler` options |
| HTTP request/response body | 32 MiB | exposure and connect options |
| Control plane request body | 1 MiB | `maxBodyBytes` |
| Deduplication entries | 10 000, 1 hour | `DedupeStore` options |

A gzip bomb fails as `PAYLOAD_TOO_LARGE` rather than exhausting memory. An undecodable object is deleted rather than re-read forever.

## Reaping another peer's mail

Every peer deletes mail addressed to peers that are gone: older than `inboxOrphanMs` (7 days by default) **and** with no presence beacon, or a beacon older than the same window. Without it a message addressed to a peer that never returns is storage nothing reclaims, because only its recipient ever empties an inbox.

This grants no privilege that a member did not already have. Every member holds the workspace secret, so every member can already read any inbox, and every member already has unrestricted `delete` on the store. A hostile member could clear every inbox in the workspace before this existed and can do exactly as much afterwards.

What it does change is that **correct** peers now delete data they did not author. So the risk to weigh is accidental loss, not privilege: a peer offline for longer than `inboxOrphanMs` loses its mail. Set `inboxOrphanMs` to `0` to turn it off. Deciding costs a listing only, since age is read from the message id in the key; nothing is downloaded and nothing is decrypted, and a message's real TTL is unreadable from outside anyway. [ADR 0006](adr/0006-reaping-orphaned-inboxes.md) has the reasoning, [docs/configuration.md](configuration.md) the setting.

## Replay

Message ids are unique and the deduplication store persists across restarts, so a replayed frame is dropped rather than redelivered. Messages carry a TTL and expire; requests are stamped with a TTL equal to their timeout, so a captured request cannot be usefully replayed after it expires.

A workspace member can still replay their own traffic within the TTL window. Given that a member can also simply send the message again, this is not a boundary dead-drop tries to defend.

## Reporting

Security issues should go to the repository owner privately rather than to the public issue tracker.
