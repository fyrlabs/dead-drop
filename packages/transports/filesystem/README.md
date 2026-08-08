# @fyrlabs/dead-drop-transport-filesystem

Moves dead-drop traffic through a directory. Any directory both machines can see works: an SMB or NFS mount, a Dropbox or OneDrive folder, a shared volume between containers.

This is dead-drop's reference transport, the one the conformance suite is written against and the easiest way to get two machines talking.

Ships with [@fyrlabs/dead-drop](https://www.npmjs.com/package/@fyrlabs/dead-drop); install it separately only when embedding the runtime yourself.

## Install

```bash
npm install @fyrlabs/dead-drop-transport-filesystem
```

Requires Node.js 20.11 or newer.

## Configure

```json
{
  "use": "filesystem",
  "config": {
    "root": "/Volumes/shared/deaddrop"
  }
}
```

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `root` | string | required | Directory holding the objects. Created if missing. |
| `pollIntervalMs` | number | `1000` | Poll interval when native filesystem events are unavailable. |
| `forcePolling` | boolean | `false` | Skip `fs.watch` and poll instead. |

`fs.watch` fails silently on many SMB and NFS mounts, reporting success while delivering no events, so polling always runs alongside it rather than only as a fallback. Watching therefore works everywhere by default, and `forcePolling` exists for filesystems where `fs.watch` itself misbehaves: set it to skip the watcher and rely on the poll interval alone.

Writes go through a temporary file and an atomic rename, which is what stops a sync client from replicating a half-written frame.

## Documentation

Part of [dead-drop](https://github.com/fyrlabs/dead-drop), a transport-agnostic runtime for distributed applications.

- [Configuration reference](https://github.com/fyrlabs/dead-drop/blob/main/docs/configuration.md)

## Licence

Apache-2.0.
