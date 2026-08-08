# @fyrlabs/dead-drop-transport-github

Moves dead-drop traffic through a GitHub repository. A thin layer over [@fyrlabs/dead-drop-transport-git](https://www.npmjs.com/package/@fyrlabs/dead-drop-transport-git) that resolves the clone url through `gh`, creates the repository when you ask it to, and reports the API rate limit so the transport manager can route around a nearly exhausted budget.

Data lives on a dedicated orphan branch. Your default branch is never touched.

Ships with [@fyrlabs/dead-drop](https://www.npmjs.com/package/@fyrlabs/dead-drop); install it separately only when embedding the runtime yourself.

## Install

```bash
npm install @fyrlabs/dead-drop-transport-github
```

Requires Node.js 20.11 or newer, plus `git` and the [GitHub CLI](https://cli.github.com/) on `PATH`.

```bash
gh auth login
gh auth setup-git
```

Authentication is whatever `gh` already has. dead-drop never sees a token, and no token is written to your config.

## Configure

```json
{
  "use": "github",
  "config": {
    "repo": "acme/deaddrop-data",
    "workDir": "./.deaddrop/gh",
    "createIfMissing": true,
    "private": true
  }
}
```

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `repo` | string | required | `owner/name`. |
| `workDir` | string | required | Local clone directory. |
| `createIfMissing` | boolean | `false` | Create the repository when it does not exist. |
| `private` | boolean | `true` | Visibility used when creating. |
| `rateLimitIntervalMs` | number | `60000` | How often the API rate limit is re-read. |
| `ghPath` | string | `gh` | Path to the `gh` binary. |

It also forwards `branch`, `prefix`, `gitPath`, `timeoutMs`, `batchWindowMs` and `freshnessMs` to the git transport. The git transport's `pushRetries`, `authorName` and `authorEmail` are not forwarded; use the `git` transport directly if you need them.

Leave `createIfMissing` off on peers that should never create anything, so a typo in `repo` fails loudly instead of quietly producing a second repository.

## Rate limits

Below 10% remaining API headroom the transport reports itself `degraded` rather than healthy. The transport manager scores on that, so a workspace with a second transport configured moves traffic away before the budget runs out and requests start failing. Watch it with `ddrop transport health`.

## What to expect

Seconds per round trip, not milliseconds. Every message is a commit, a push and a fetch. Measure a real round trip and set the workspace's `requestTimeoutMs` from it.

## Documentation

Part of [dead-drop](https://github.com/fyrlabs/dead-drop), a transport-agnostic runtime for distributed applications.

- [Configuration reference](https://github.com/fyrlabs/dead-drop/blob/main/docs/configuration.md)
- [Testing, including the live GitHub walkthrough](https://github.com/fyrlabs/dead-drop/blob/main/docs/testing.md)

## Licence

Apache-2.0.
