# ADR 0001: two transport kinds instead of one interface

**Status:** accepted

## Context

The design sketch (`design-sketch.md`, §10) gives every transport this interface:

```ts
interface Transport {
  connect(context): Promise<void>;
  send(message): Promise<TransportResult>;
  receive(handler): Promise<void>;
  health(): Promise<TransportHealth>;
  close(): Promise<void>;
}
```

The same document lists the intended transports: GitHub, GitLab, Bitbucket, Azure DevOps, OneDrive, SharePoint, local filesystem, S3-compatible storage, Dropbox.

Every one of those is an object store. None has delivery semantics.

## Problem

`send`/`receive` asks each adapter to *invent* messaging on top of storage. To implement `receive` against GitHub, an author has to write polling with adaptive backoff, acknowledgement, deduplication, redelivery with jitter, dead-lettering and chunking for the 100 MB blob limit. Then the OneDrive author writes it again. Then the S3 author writes it again.

Three things follow, and all of them are bad:

1. Every adapter is several hundred lines instead of fifty, so fewer get written.
2. Each one has its own delivery bugs, in a package this repository does not control.
3. The stated goal of an open plugin ecosystem is undermined by the cost of entry.

## Decision

Split the contract by what the backend actually provides.

```ts
capabilities.kind === 'store'   // put / get / list / delete, optional watch
capabilities.kind === 'native'  // send / subscribe
```

The mailbox engine in `@fyrlabs/dead-drop-core` implements messaging once, over the store primitives: framing, encryption, chunking and reassembly, delete-as-acknowledgement, redelivery with backoff, dead letters, deduplication, broadcast topics with a resume cursor, adaptive polling.

`native` remains for backends that genuinely are message systems, where synthesising acknowledgements on top would be wrong.

## Consequences

**Good.** A store adapter is four methods. The filesystem transport is about 300 lines including atomic writes and a polling watcher. Delivery correctness is implemented once, tested once, and fixed once. The conformance suite can be strict because the surface is small.

**Cost.** The runtime is doing more work, so its bugs affect every transport — mitigated by the fact that it is the most heavily tested code in the repository. A backend with unusual native semantics has to be modelled as `native` or lose them.

**Rejected alternative:** keep the single interface and ship a `StoreBackedTransport` base class adapters extend. Rejected because inheritance across a package boundary is a versioning trap, and because it leaves the door open to adapters that half-implement delivery.
