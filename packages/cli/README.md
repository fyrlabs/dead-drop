# @fyrlabs/dead-drop

The `ddrop` command: run a dead-drop runtime, expose a local application to other machines, and connect to what they expose.

dead-drop lets applications on different machines talk through infrastructure you already have, such as a git repository, a shared folder or object storage. Nothing is deployed, no port is opened, and no broker sits in the middle. This package is the front door; install it and nothing else to get started.

## Install

```bash
npm install -g @fyrlabs/dead-drop
```

Requires Node.js 20.11 or newer. Installs as `ddrop`, with `dead-drop` as a second name for the same binary.

The filesystem, git, github and memory transports ship with it. The git and github transports shell out to the `git` and `gh` binaries, so install those if you use them.

## Getting started

```bash
ddrop keygen                 # a workspace secret; share it with your peer securely
export DEADDROP_SECRET='ddk1_…'
ddrop init --name demo       # writes deaddrop.config.json
ddrop start                  # runs in the foreground
```

Then, in a second shell:

```bash
ddrop expose --target http://localhost:3000 --name my-api
```

On the other machine, with the same secret and transport in its own config:

```bash
ddrop discover                     # see the peer and what it exposes
ddrop connect machine-a/my-api     # prints a local url that proxies to it
```

## Commands

```text
ddrop start                         run the runtime
ddrop status                        runtime, workspaces, transports
ddrop list                          workspaces this runtime serves
ddrop discover                      peers visible in the workspace
ddrop transport list | health       transport scores and health
ddrop expose --target <url> --name <n>
ddrop expose <dir> --name <n>
ddrop connect <peer>/<exposure>
ddrop call <peer> <channel> --input '{"a":1}'
ddrop publish <channel> --input '{...}'
ddrop logs | metrics
ddrop trace [<traceId>]             recent traces, or one as a span tree
ddrop keygen | init
```

`--json` makes any command machine-readable, including its errors. Run `ddrop --help` for the full flag list.

## Documentation

Part of [dead-drop](https://github.com/fyrlabs/dead-drop).

- [Configuration reference](https://github.com/fyrlabs/dead-drop/blob/main/docs/configuration.md)
- [Operations](https://github.com/fyrlabs/dead-drop/blob/main/docs/operations.md)
- [Security model](https://github.com/fyrlabs/dead-drop/blob/main/docs/security-model.md)
- [Delivery guarantees](https://github.com/fyrlabs/dead-drop/blob/main/docs/guarantees.md)

## Licence

Apache-2.0.
