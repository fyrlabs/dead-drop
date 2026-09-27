# Proposal 0001: application extensions over slow shared infrastructure

**Status:** proposed  
**Date:** 2026-09-27

## Intent

dead-drop makes existing shared infrastructure useful for applications that would normally need a direct network path, a broker, or a deployment. It trades speed and transparent network compatibility for deploy-free reachability, encrypted frame contents, and use of infrastructure the participants already control.

Slow is normal here. A GitHub-backed request can take seconds. An extension must make that visible in its UX instead of pretending it is a local socket or an SSH connection.

The existing HTTP proxy is the first application capability: an unchanged HTTP server can be exposed on one peer and reached through a local HTTP endpoint on another. Streaming response bodies is opt-in as of 0.16.0. The proxy is not a general TCP tunnel, WebSocket proxy, or public ingress product.

## Terminology

### Transport plugin

A transport plugin connects the runtime to storage or a native messaging backend. It implements the existing stable `@fyrlabs/dead-drop-transport-sdk` contract. The runtime supplies framing, encryption, delivery, deduplication, retries, failover, and observability.

Examples: S3, Dropbox, SharePoint, or a company object store.

### Application extension

An application extension uses a dead-drop workspace to provide an end-user capability. It may run an agent on one peer and a client on another, but it does not implement transport storage.

Examples: a remote shell, a route translator, a remote build runner, or a synchronisation job.

There is no application-extension API, manifest, installer, or command registry today. This proposal does not add one yet.

## Product direction

```text
shared folder / git remote / object store
                    ↓
       dead-drop runtime and workspace
                    ↓
              application capability
 HTTP proxy · remote shell · configuration router · future tools
```

The core remains responsible for the durable encrypted message path. An extension is responsible for its own capability semantics and its honest limitations.

## First extension: remote shell

The first candidate is an independent project and package:

```text
@fyrlabs/dead-drop-shell
```

It depends on `@fyrlabs/dead-drop`; it does not modify the dead-drop repository or become a workspace package here. The VM installs the shell package, which brings dead-drop in as a dependency. It also needs Node.js 20.11 or newer, `git`, and `gh` authenticated for the chosen GitHub transport.

The phase-one commands are:

```text
ddshell agent --config vm.json
ddshell vm
ddshell vm --debug
ddshell exec vm -- uname -a
```

The agent runs under a dedicated restricted OS account. A new `ddshell vm` connection gets a separate shell session beginning in that account's home directory. Its current directory and shell environment persist through sequential commands:

```text
vm:~$ cd /srv/app
vm:/srv/app$ git status
```

The phase-one product is a line-oriented remote shell. It returns stdout, stderr, exit status, duration, and the resulting current directory. It is not SSH and does not promise a TTY, port forwarding, SCP, `sudo` prompts, `vim`, `top`, or terminal resize support.

### Delivery and execution rule

dead-drop gives at-least-once delivery. A remote command must therefore carry a unique job id, and the agent must persist a completed-result ledger keyed by that id. A redelivered completed command returns its stored result rather than running again.

If the VM stops while a command is running, the agent must report the job as `unknown` after restart. It must not automatically rerun it and must not claim that it did not run. Exactly-once arbitrary shell execution is not achievable over this transport.

### Security boundary

Use one dedicated workspace, one dedicated private transport repository, and one secret for the shell group. The workspace secret is transferred out of band and never committed to that repository. The agent allows an explicit controller peer list, but the durable security boundary is the operating-system account: every allowed command has that account's permissions.

## Phases

1. **Prototype locally.** Two runtimes over the filesystem transport. Prove separate sessions, home-directory start, `cd`, command errors, output capture, output cap, timeout, and unauthorised callers.
2. **Durable execution.** Add the job/result ledger, duplicate-delivery tests, restart recovery, explicit `unknown` state, and agent logs.
3. **GitHub-backed VM.** Use a private repository and a restricted system service. Measure request latency and document it as normal operation.
4. **Streaming terminal work.** Add ordered output chunks, cancellation, session reconnect, and terminal control only when the line-oriented shell is useful and well tested.
5. **Application extension host.** Generalise only the lifecycle proven necessary by the shell: manifest, API version, command registration, configuration validation, permissions, upgrade, and removal.

## Future: configuration translation

An Nginx configuration translator should be a separate application extension. It must parse a declared safe subset and generate an explicit dead-drop routing configuration plus an unsupported-directive report.

It must not execute configuration files or claim full Nginx compatibility. Nginx includes, modules, TLS termination, caching, Lua, arbitrary rewrites, and public ingress need their own design or stay unsupported. A translator can preserve routing intent; it cannot make a private dead-drop workspace into internet-facing ingress.

## Future application-plugin contract

Only after the shell proves the lifecycle should core add an application-plugin system. A likely manifest shape is:

```json
{
  "kind": "dead-drop-plugin",
  "apiVersion": 1,
  "id": "shell",
  "commands": ["shell", "shell-agent"],
  "permissions": ["runtime", "spawn-process"]
}
```

The eventual UX could be:

```text
ddrop plugin add @fyrlabs/dead-drop-plugin-shell
ddrop shell vm
```

Package prefixes are conventions, not proof of trust. Installation must use an explicit package specifier, lockfile integrity, and provenance or publisher trust checks. The core must never infer that an arbitrary `dd-*` package is safe to load into a process holding workspace secrets.

## Open questions

- Is `ddshell` the final standalone binary, or does it later become only `ddrop shell`?
- Which platforms belong in phase one? The initial agent should explicitly target POSIX shells.
- What output cap gives useful diagnostics without turning GitHub storage into a log archive?
- Which controller identities may open an agent session, and how are their fingerprints verified at initial setup?
- What extension permissions can safely be declared and enforced by a future host?

