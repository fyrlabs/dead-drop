# @fyrlabs/dead-drop-transport-git

Any git remote as a dead-drop transport. Objects are files on a dedicated orphan branch, so dead-drop data never shares history with your code. Writes are batched into one commit and push, and push races are resolved by replaying onto the winner's state.

Part of [dead-drop](https://github.com/fyrlabs/dead-drop) — a transport-agnostic runtime for distributed applications. See the repository README for the full picture, and `docs/` for the architecture, security model and delivery guarantees.

## Install

```bash
npm install @fyrlabs/dead-drop-transport-git
```

Requires Node.js 20.11 or newer.

## Licence

Apache-2.0.
