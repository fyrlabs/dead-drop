# Operations

## Configuration

This section is the shape of a real config. For every field, its type and its default, see the [configuration reference](configuration.md).

`deaddrop.config.json`, found in this order: `--config <path>`, `./deaddrop.config.json`, `~/.deaddrop/config.json`.

Relative paths in the config resolve against the config file's directory, not the working directory, and a leading `~` expands to your home directory.

```json
{
  "dataDir": "~/.deaddrop",
  "logLevel": "info",
  "controlSocket": "/run/deaddrop/deaddrop.sock",
  "workspaces": [
    {
      "name": "demo",
      "peerId": "machine-a",
      "secrets": ["${env:DEADDROP_SECRET}"],
      "transports": [
        { "use": "filesystem", "name": "shared", "config": { "root": "/mnt/shared/deaddrop" } },
        { "use": "github", "config": { "repo": "acme/deaddrop-data", "workDir": "./.deaddrop/gh" } }
      ],
      "policy": { "mode": "failover", "primary": "shared", "fallback": ["github"] },
      "exposures": [
        { "name": "my-api", "type": "http", "target": "http://localhost:3000", "allowPeers": ["machine-b"] },
        { "name": "site", "type": "static", "directory": "./public" }
      ],
      "subscribe": ["events/orders"],
      "polling": { "minIntervalMs": 250, "maxIntervalMs": 15000 },
      "requestTimeoutMs": 30000
    }
  ]
}
```

`${env:NAME}` is expanded anywhere in the file at load time, and an unset variable is a hard error rather than a silent empty string. Relative paths resolve against the config file's directory, not the working directory.

`peerId` defaults to the machine's hostname. Set it explicitly if hostnames are not stable, because a peer id is a mailbox address: changing it strands undelivered messages.

## Running

```bash
ddrop start                 # foreground, JSON logs on stderr
ddrop start --pretty        # human-readable logs
```

systemd:

```ini
[Service]
Type=simple
Environment=DEADDROP_SECRET=…
ExecStart=/usr/bin/ddrop start --config /etc/deaddrop/config.json
Restart=on-failure
RestartSec=5
```

Startup does not depend on any transport being reachable. A runtime binds its control plane, and `ddrop connect` binds its local port, whether or not a transport can carry anything; requests made in the meantime fail with `NO_TRANSPORT_AVAILABLE` (502 through an exposure) rather than the port being closed. The presence beacon is published in the background and republished every 30 seconds, so peers see each other once a transport comes back, with no restart.

One beacon is in flight at a time, and a beacon is abandoned once it is older than the expiry window (three intervals, so 90 seconds by default) because nothing would believe it by then. That matters on a slow backend: beacons are the one thing a runtime writes without being asked, so unbounded ones accumulate as extra writers and make the backend slower still. A peer that misses beacons disappears from `ddrop discover` and stays reachable, since delivery does not depend on discovery.

Shutdown on SIGINT/SIGTERM is graceful: pending requests are rejected with `CANCELLED`, the presence beacon is withdrawn, queued writes finish, and transports close.

## Queued depth

`ddrop queues` reports what is waiting in each peer's inbox, deepest queue first:

```text
peer-b                       7 waiting  14.2 KB   oldest 4m 12s ago
peer-a                       1 waiting  2.1 KB    oldest 3s ago  (this peer)
```

A deep queue with an old head means the peer it names is not running, or is running and cannot keep up. A peer with nothing waiting is left out entirely, and `No messages are queued.` means all its inboxes are empty.

It reads object keys and nothing else. Keys carry the peer name and a time-sortable message id in the clear by design ([security model](security-model.md)), so counts and ages come from the key layout alone; no frame is fetched, and nothing is decrypted or consumed. The age is the sender's clock, taken from the message id, not the store's modification time, which store transports are not required to report.

Two things to know before scripting it:

- Each call lists every store transport once, which on `git` and `github` means a fetch. Fine for a dashboard poll, not for a tight loop.
- `read` in `--json` counts the transports that answered. When it is zero the command exits 1 and prints nothing to stdout, because "nothing is queued" and "I could not look" are different answers. `unreadable` names the transports that failed, and `truncated` marks counts as lower bounds when a listing hit its 10,000-object scan cap.

## Dashboard

`ddrop dashboard` opens a web page showing everything above at once: peers, transports and their health, queued depth per peer, mailbox counters and the recent log.

```bash
ddrop dashboard                 # http://127.0.0.1:7373, and opens a browser
ddrop dashboard --port 9000     # a port you choose
ddrop dashboard --no-open       # print the URL and stop there
```

It runs in the foreground and stops with Ctrl-C. The URL is printed before a browser is opened, and a failed open never fails the command, so it is usable over ssh on a machine with no desktop.

Three things about it are deliberate, and [ADR 0004](adr/0004-dashboard-binds-tcp-and-holds-no-runtime.md) has the reasoning:

- **It is read-only.** It shows what `status`, `discover`, `queues`, `logs`, `trace` and `metrics` already return. There is no route that publishes, calls, exposes, cancels or retries anything, and that is what makes a browser-reachable port an acceptable trade rather than a second door into the workspace.
- **It starts no runtime.** It is a client of the control socket, exactly like `ddrop status`. It clones no working directory, claims no peer id and writes no presence beacon, so leaving it open all day costs the transport nothing.
- **It binds `127.0.0.1` and nothing else**, answers only requests whose `Host` is the loopback interface, and fails on a port already in use rather than moving to a free one. Anything with local access can read workspace metadata from it while it is open, so run it while you are looking at it, not as a service.

It needs no network: the page and the one library it uses ship inside the package.

Each poll costs one listing per store transport, which on `git` and `github` means a fetch. The page polls every five seconds and stops while its tab is hidden.

## Metrics

`ddrop metrics` emits Prometheus text. The ones worth alerting on:

| Metric | Watch for |
| --- | --- |
| `deaddrop_transport_health` | Below 1 for a sustained period. 0.5 is degraded, 0 is unavailable. |
| `deaddrop_failovers_total` | Rising steadily means the primary transport is unwell. |
| `deaddrop_messages_dropped_total` | By `reason`. `dead-letter` and `undecodable` always deserve attention. |
| `deaddrop_transport_rate_limit_remaining` | Approaching zero on a GitHub transport. |
| `deaddrop_request_duration_ms` | p95 rising means the transport, not your application. |
| `deaddrop_poll_interval_ms` | Pinned at maximum means nothing is arriving. |
| `deaddrop_inflight_requests` | Growing without bound means responses are not coming back. |

## Traces

`ddrop trace` lists the recent traces; `ddrop trace <traceId>` expands one into a span tree with durations, statuses and attributes.

The trace id of a message is its message id, so the `requestId` in a timeout error's `details` is directly usable: `ddrop trace msg_01J…` shows the request, the send, each transport attempt and, if it arrived, the delivery of the response. Only this peer's side of a round trip is visible; the remote peer traces its own half under its own runtime.

The buffer holds the most recent 500 finished spans and is memory-only, so it is for debugging a problem happening now, not for after the fact. `ddrop trace --json` gives the raw spans.

## Troubleshooting

**`cannot reach the dead-drop runtime … Is "ddrop start" running?`**: the CLI could not open the control socket. The path it tried is in the message. Client commands derive it from the config they discover, so a command run from a directory without `deaddrop.config.json` falls back to `~/.deaddrop/deaddrop.sock` and misses a project-local runtime; pass `--config` or `--socket` in that case.

**`ddrop discover` shows nothing.** First check the exit code: `ddrop discover` exits 1 and names the transport when it could not list any store, which is a different problem from an empty workspace. If it exits 0, peers announce every 30 seconds and a beacon is stale after 90. Confirm both peers use the same workspace *name* and the same secret. The name is an HKDF salt, so `demo` and `Demo` produce unrelated keys and neither can read the other. `ddrop discover --stale` shows expired beacons.

**Requests time out.** `ddrop transport health` first. On a git transport a round trip is a push plus a poll interval, so a 30-second default timeout can be genuinely too short; raise `requestTimeoutMs`. Check the target peer is running and its `peerId` is what you are addressing.

**`refusing unencrypted frame on an encrypted workspace`**: something wrote a plaintext frame into a workspace that has secrets. Usually a misconfigured peer.

**`no workspace key matches key id …`**: a peer is using a secret this one does not have. Mid-rotation, add the other secret to this peer's list. See the rotation procedure in the security model.

**Dead letters are accumulating.** `ws/<workspace>/dead/<peer>/` on the transport. Each is an encrypted frame that failed its handler the configured number of times. Nothing removes them automatically; that is the point.

**The transport store is growing.** Undelivered messages accumulate in the recipient's inbox until they expire. Set a TTL on messages to a peer that may be offline for a long time. Broadcast topics are reaped after `topicRetentionMs`, one hour by default.

**A git transport keeps losing push races.** Expected under load, and the retry loop handles it. If it exhausts its attempts, raise `pushRetries` or `batchWindowMs` so more writes share one push.

## Backup and disaster recovery

The transport store holds only undelivered messages. Losing it loses in-flight mail, not state; that is the correct trade for a system that treats the transport as disposable.

What actually needs backing up is the **workspace secret**. Lose it and every peer must be reconfigured with a new one, and any message still on the transport becomes unreadable. Keep it in a secret manager.

The `dataDir` holds the socket and the deduplication cache. Losing it means some messages may be redelivered once. Not worth backing up.
