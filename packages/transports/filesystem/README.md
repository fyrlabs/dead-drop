# @fyrlabs/dead-drop-transport-filesystem

The reference transport. Point two machines at one directory — a network mount, an SMB share, a synced Dropbox/OneDrive/Drive folder — and dead-drop works. Atomic writes, a filesystem watcher with a polling fallback for network mounts, and a health probe that actually writes so a stale mount reports unavailable.

Part of [dead-drop](https://github.com/fyrlabs/dead-drop) — a transport-agnostic runtime for distributed applications. See the repository README for the full picture, and `docs/` for the architecture, security model and delivery guarantees.

## Install

```bash
npm install @fyrlabs/dead-drop-transport-filesystem
```

Requires Node.js 20.11 or newer.

## Licence

Apache-2.0.
