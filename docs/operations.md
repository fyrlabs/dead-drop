# Operations

## Configuration

`bridge.config.json`, found in this order: `--config <path>`, `./bridge.config.json`, `~/.bridge/config.json`.

Relative paths in the config resolve against the config file's directory, not the working directory, and a leading `~` expands to your home directory.

```json
{
  "dataDir": "~/.bridge",
  "logLevel": "info",
  "controlSocket": "/run/bridge/bridge.sock",
  "workspaces": [
    {
      "name": "demo",
      "peerId": "machine-a",
      "secrets": ["${env:BRIDGE_SECRET}"],
      "transports": [
        { "use": "filesystem", "name": "shared", "config": { "root": "/mnt/shared/bridge" } },
        { "use": "github", "config": { "repo": "acme/bridge-data", "workDir": "./.bridge/gh" } }
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
bridge start                 # foreground, JSON logs on stderr
bridge start --pretty        # human-readable logs
```

systemd:

```ini
[Service]
Type=simple
Environment=BRIDGE_SECRET=…
ExecStart=/usr/bin/bridge start --config /etc/bridge/config.json
Restart=on-failure
RestartSec=5
```

Shutdown on SIGINT/SIGTERM is graceful: pending requests are rejected with `CANCELLED`, the presence beacon is withdrawn, queued writes finish, and transports close.

## Metrics

`bridge metrics` emits Prometheus text. The ones worth alerting on:

| Metric | Watch for |
| --- | --- |
| `bridge_transport_health` | Below 1 for a sustained period. 0.5 is degraded, 0 is unavailable. |
| `bridge_failovers_total` | Rising steadily means the primary transport is unwell. |
| `bridge_messages_dropped_total` | By `reason`. `dead-letter` and `undecodable` always deserve attention. |
| `bridge_transport_rate_limit_remaining` | Approaching zero on a GitHub transport. |
| `bridge_request_duration_ms` | p95 rising means the transport, not your application. |
| `bridge_poll_interval_ms` | Pinned at maximum means nothing is arriving. |
| `bridge_inflight_requests` | Growing without bound means responses are not coming back. |

## Troubleshooting

**`cannot reach the Bridge runtime … Is "bridge start" running?`** — the CLI could not open the control socket. The path it tried is in the message. Client commands derive it from the config they discover, so a command run from a directory without `bridge.config.json` falls back to `~/.bridge/bridge.sock` and misses a project-local runtime; pass `--config` or `--socket` in that case.

**`bridge discover` shows nothing.** Peers announce every 30 seconds and a beacon is stale after 90. Confirm both peers use the same workspace *name* and the same secret — the name is an HKDF salt, so `demo` and `Demo` produce unrelated keys and neither can read the other. `bridge discover --stale` shows expired beacons.

**Requests time out.** `bridge transport health` first. On a git transport a round trip is a push plus a poll interval, so a 30-second default timeout can be genuinely too short; raise `requestTimeoutMs`. Check the target peer is running and its `peerId` is what you are addressing.

**`refusing unencrypted frame on an encrypted workspace`** — something wrote a plaintext frame into a workspace that has secrets. Usually a misconfigured peer.

**`no workspace key matches key id …`** — a peer is using a secret this one does not have. Mid-rotation, add the other secret to this peer's list. See the rotation procedure in the security model.

**Dead letters are accumulating.** `ws/<workspace>/dead/<peer>/` on the transport. Each is an encrypted frame that failed its handler the configured number of times. Nothing removes them automatically; that is the point.

**The transport store is growing.** Undelivered messages accumulate in the recipient's inbox until they expire. Set a TTL on messages to a peer that may be offline for a long time. Broadcast topics are reaped after `topicRetentionMs`, one hour by default.

**A git transport keeps losing push races.** Expected under load, and the retry loop handles it. If it exhausts its attempts, raise `pushRetries` or `batchWindowMs` so more writes share one push.

## Backup and disaster recovery

The transport store holds only undelivered messages. Losing it loses in-flight mail, not state; that is the correct trade for a system that treats the transport as disposable.

What actually needs backing up is the **workspace secret**. Lose it and every peer must be reconfigured with a new one, and any message still on the transport becomes unreadable. Keep it in a secret manager.

The `dataDir` holds the socket and the deduplication cache. Losing it means some messages may be redelivered once. Not worth backing up.
