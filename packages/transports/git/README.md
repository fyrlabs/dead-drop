# @fyrlabs/dead-drop-transport-git

Moves dead-drop traffic through a git remote. Any remote `git clone` accepts works: GitHub, GitLab, Gitea, a bare repository on a box you own, or a path on a shared disk.

Objects live on a dedicated orphan branch, so your default branch and its history are never touched. The repository becomes the medium; nobody needs to open a port.

For GitHub specifically, [@fyrlabs/dead-drop-transport-github](https://www.npmjs.com/package/@fyrlabs/dead-drop-transport-github) adds repository creation and rate-limit awareness on top of this package.

Ships with [@fyrlabs/dead-drop](https://www.npmjs.com/package/@fyrlabs/dead-drop); install it separately only when embedding the runtime yourself.

## Install

```bash
npm install @fyrlabs/dead-drop-transport-git
```

Requires Node.js 20.11 or newer and a `git` binary on `PATH`. Authentication is whatever git already has: a credential helper, an ssh key, whatever you already use to push.

## Configure

```json
{
  "use": "git",
  "config": {
    "remote": "git@github.com:acme/deaddrop-data.git",
    "workDir": "./.deaddrop/git"
  }
}
```

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `remote` | string | required | Anything `git clone` accepts. |
| `workDir` | string | required | Local clone directory. Created if missing. |
| `branch` | string | `deaddrop-data` | Orphan branch holding the objects. |
| `prefix` | string | none | Subdirectory inside the branch, so one repository can host several workspaces. |
| `freshnessMs` | number | `5000` | How stale a local read may be before a fetch is forced. |
| `batchWindowMs` | number | `50` | How long to wait for other writes before committing, so concurrent sends become one commit. |
| `pushRetries` | number | `5` | Attempts to resolve a push race before giving up. |
| `authorName`, `authorEmail` | string | git's own config | Identity on generated commits. |
| `gitPath` | string | `git` | Path to the git binary. |
| `timeoutMs` | number | `120000` | Per-command timeout. |

## What to expect

A round trip costs seconds, not milliseconds: every message is a commit, a push and a fetch. This transport is for the case where standing up infrastructure is the expensive part, not for throughput. Set `requestTimeoutMs` on the workspace from a round trip you have actually measured.

Concurrent writers are handled: two peers pushing at once resolve the race rather than losing a write, and writes inside `batchWindowMs` collapse into a single commit.

## Documentation

Part of [dead-drop](https://github.com/fyrlabs/dead-drop), a transport-agnostic runtime for distributed applications.

- [Configuration reference](https://github.com/fyrlabs/dead-drop/blob/main/docs/configuration.md)
- [Delivery guarantees](https://github.com/fyrlabs/dead-drop/blob/main/docs/guarantees.md)

## Licence

Apache-2.0.
