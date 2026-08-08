# @fyrlabs/dead-drop-transport-github

GitHub as a dead-drop transport. Data moves over git; `gh` supplies authentication, repository resolution and creation, and API rate-limit reporting that feeds transport scoring. No token is ever passed to or stored by dead-drop.

Part of [dead-drop](https://github.com/fyrlabs/dead-drop) — a transport-agnostic runtime for distributed applications. See the repository README for the full picture, and `docs/` for the architecture, security model and delivery guarantees.

## Install

```bash
npm install @fyrlabs/dead-drop-transport-github
```

Requires Node.js 20.11 or newer.

## Licence

Apache-2.0.
