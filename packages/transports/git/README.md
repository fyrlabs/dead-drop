# @dead-drop/transport-git

Any git remote as a Bridge transport. Objects are files on a dedicated orphan branch, so Bridge data never shares history with your code. Writes are batched into one commit and push, and push races are resolved by replaying onto the winner's state.

Part of [Bridge](https://github.com/) — a transport-agnostic runtime for distributed applications. See the repository README for the full picture, and `docs/` for the architecture, security model and delivery guarantees.

## Install

```bash
npm install @dead-drop/transport-git
```

Requires Node.js 20.11 or newer.

## Licence

Apache-2.0.
