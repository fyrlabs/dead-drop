# Security model

Read this before deciding dead-drop fits your situation. It states what is protected, what is not, and where the sharp edges are.

## Identity is a shared secret

A workspace has one 32-byte secret. Every peer in the workspace holds it. Possession of that secret *is* membership: there is no per-peer identity, no signing key, and no way for a peer to prove which peer it is. `from` in an envelope is a claim, not an assertion.

This is a deliberate simplification, and it is the single most important thing to understand. It means:

- Any workspace member can impersonate any other workspace member.
- Any workspace member can read every message in the workspace, including ones addressed to other peers.
- Any workspace member can delete every message in the workspace, including ones addressed to other peers. Authorisation over the store belongs to the transport, not to dead-drop.
- Removing a peer means rotating the secret. Nothing else revokes access.

If you need peers that can send but not read, or an audit trail that survives a malicious member, dead-drop as it stands is the wrong tool. That would need per-peer keypairs and signed envelopes, which is a protocol change, not a configuration change.

A change to the first and fourth points is designed but not built: [ADR 0007](adr/0007-per-peer-key-wrapping.md) proposes making the secret an enrollment token and wrapping a per-era data key to each peer's X25519 public key, so admitting a peer stops handing over the key to everything already written and removing one stops requiring everybody else to re-key. It is proposed, not implemented; everything above describes what ships today.

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
- Key derivation: HKDF-SHA256, salt = workspace name, info = `dead-drop/v1/workspace-aead`. Salting by name means the same secret in two differently-named workspaces yields unrelated keys, so a frame cannot be replayed across them.
- Encryption: AES-256-GCM with a fresh random 96-bit IV per frame. The frame preamble is the additional authenticated data.
- Key id: first 8 hex characters of SHA-256 over the derived key. Not secret; it exists so a receiver can pick the right key during a rotation.

## Key rotation

Frames name the key they were sealed with, so old and new keys can be accepted at once.

1. `ddrop keygen` produces the new secret.
2. Add it to **every** peer's config as the *second* entry: `"secrets": ["<old>", "<new>"]`. Restart. Peers now accept both, still encrypt with the old.
3. Once every peer is updated, swap the order: `"secrets": ["<new>", "<old>"]`. Restart. Peers now encrypt with the new and still accept the old.
4. After the longest plausible in-flight message TTL, drop the old secret entirely.

Skipping step 2 breaks every peer that has not been updated yet.

## Where secrets live

- **Not in the config file.** `ddrop init` writes `"${env:DEADDROP_SECRET}"`, and the config parser expands `${env:NAME}` at load time. Put the real value in a secret manager or your shell environment.
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
