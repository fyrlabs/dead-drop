# Two transports configured, one of them broken.
#
# Transport independence is the premise of the project, and the place it has to
# pay off is when one transport dies underneath a running peer. Nothing above
# the transport manager may name a transport (invariant 1), so no application
# can be told to switch: the manager notices, trips a breaker, moves the
# traffic, and the caller sees a slow request rather than an error.
#
# Both transports here are filesystem transports over separate directories.
# That is not a realistic deployment, but it is the cheapest honest way to break
# one on demand: revoking permissions on a directory fails reads and writes the
# same way a revoked token or an unreachable remote does.
#
# One proxy client is started while everything is healthy and kept for the whole
# file. That is the realistic shape of an outage — it begins during a session,
# not before one — and it avoids a startup dependency documented at the bottom
# of this file.

FO="$WORK/failover"
PRIMARY="$FO/primary"
FALLBACK="$FO/fallback"
STATIC="$FO/site"
mkdir -p "$PRIMARY" "$FALLBACK" "$STATIC"
echo "served-over-either" > "$STATIC/index.txt"

TRANSPORTS="
  { \"use\": \"filesystem\", \"name\": \"primary\", \"config\": { \"root\": \"$PRIMARY\", \"pollIntervalMs\": 300 } },
  { \"use\": \"filesystem\", \"name\": \"fallback\", \"config\": { \"root\": \"$FALLBACK\", \"pollIntervalMs\": 300 } }"
POLICY='"policy": { "mode": "failover", "primary": "primary", "fallback": ["fallback"] }'

# The status a transport reports for itself, by instance name.
transport_status() { # $1 = peer dir, $2 = transport name
  dd_json "$1" "j.transports?.find((t) => t.name === '$2')?.status" transport health
}

fetches_content() {
  [ "$(curl -s --max-time 20 "http://127.0.0.1:$PROXY_PORT/index.txt" 2>/dev/null)" \
    = "served-over-either" ]
}

# Retries the fetch rather than waiting inside one request. A single long
# request cannot distinguish "still failing over" from "wedged", and each
# attempt is bounded by the proxy's own request timeout anyway.
fetches_content_within() { # $1 = attempts, $2 = seconds between
  wait_for "$1" "$2" fetches_content
}

primary_is_marked_down() {
  local i
  for i in $(seq 30); do
    case "$(transport_status "$FO/server" primary)" in
      unavailable|degraded) return 0 ;;
    esac
    sleep 2
  done
  return 1
}

fallback_carries_traffic() {
  [ "$(find "$FALLBACK" -type f | wc -l | tr -d ' ')" -gt 0 ]
}

# Both of the observations below need the manager to have actually attempted a
# write since the break, so they poll rather than sampling once.
traffic_moved_to_fallback() { wait_for 40 3 fallback_carries_traffic; }
manager_recorded_a_failover() {
  wait_for 40 3 test 1 -le "$(metric "$FO/server" deaddrop_failovers_total)"
}

write_config "$FO/server" "server" "$TRANSPORTS" \
  "{ \"name\": \"site\", \"type\": \"static\", \"directory\": \"$STATIC\" }" "$POLICY"
write_config "$FO/client" "client" "$TRANSPORTS" "" "$POLICY"

SERVER_PID=$(start_peer "$FO/server" "$FO/server.log")
wait_up "$FO/server" "$SERVER_PID" >/dev/null

PROXY_PORT=$(free_port)
# 15s per request: long enough for a healthy round trip over a filesystem
# transport, short enough that a failing one reports back quickly. Each retry
# below costs at most this, so it also sets the ceiling on the whole scenario.
PROXY_PID=$(start_connect "$FO/client" "server/site" "$PROXY_PORT" "$FO/proxy.log" 15000)

scenario "one transport dies under a running peer"

ON_FAIL="$FO/server.log"
can "configure two transports and have the runtime choose the primary" \
  [ "$(transport_status "$FO/server" primary)" = "healthy" ]
ON_FAIL=""

ON_FAIL="$FO/proxy.log $FO/server.log"
can "exchange traffic normally while both transports are up" fetches_content
ON_FAIL=""

# Revoke access to the primary directory. Nothing is told to switch; the manager
# has to work it out from failures.
chmod 000 "$PRIMARY"

ON_FAIL="$FO/server.log"
can "notice the primary transport has stopped working, without being told" \
  primary_is_marked_down
ON_FAIL=""
note "primary is now '$(transport_status "$FO/server" primary)', fallback is '$(transport_status "$FO/server" fallback)'"

# This is the assertion the scenario exists for, and until 0.2.7 it could not be
# made: a failover took between 90 and 460 seconds, and got slower every time it
# was measured, because the manager retried with backoff capped at 30 seconds
# even when the breaker it was retrying through was already open. An open
# breaker is now treated as the answer it is, so the fallback is reached on the
# next attempt. The elapsed time is printed on every run; if it starts climbing
# back into the minutes, that regressed.
started_at=$(date +%s)
ON_FAIL="$FO/server.log $FO/proxy.log"
can "keep serving through the surviving transport, with no config change and no restart" \
  fetches_content_within 10 3
ON_FAIL=""
note "the first successful round trip after the break came $(( $(date +%s) - started_at ))s later"

can "see the traffic move: the fallback directory is now carrying it" \
  traffic_moved_to_fallback

# Invariant 1 says nothing above the transport manager may name a transport, so
# no application asked for any of this. `deaddrop_failovers_total` is the proof
# the manager moved the traffic rather than it having drifted there by luck.
cannot "keep choosing a transport that is failing, or need an application to notice for it" \
  manager_recorded_a_failover
note "$(metric "$FO/server" deaddrop_failovers_total) failovers recorded"

scenario "every transport is gone"

chmod 000 "$FALLBACK"

PROXY_TIMEOUT_S=15
dead_started=$(date +%s)
dead_code=$(http_code "http://127.0.0.1:$PROXY_PORT/index.txt" "$FO/dead-body.txt" 120)
dead_elapsed=$(( $(date +%s) - dead_started ))
dead_body=$(cat "$FO/dead-body.txt" 2>/dev/null)
note "with both transports revoked the caller got http $dead_code after ${dead_elapsed}s: $dead_body"

cannot "get an answer when no transport can carry the message" \
  [ "$dead_code" != "200" ]

# The deadline is the whole promise of a timeout, so it is asserted as one.
# `Workspace.request` calls it "the caller's only guarantee" and until 0.2.7 it
# guarded only the wait for a reply: the send in front of it ran unbounded, and
# a caller asking for 15 seconds waited 120. The allowance below is the
# requested deadline plus room for process scheduling, not a shrug.
cannot "wait longer than the deadline it asked for (${PROXY_TIMEOUT_S}s requested, ${dead_elapsed}s waited)" \
  [ "$dead_elapsed" -le $(( PROXY_TIMEOUT_S + 15 )) ]

cannot "be left with silence: the runtime answered rather than dropping the caller" \
  [ "$dead_code" != "000" ]

# Restoring access has to be enough on its own. A breaker that latched open
# would mean a transient outage needed a restart to recover from, which is worse
# than the outage.
chmod 755 "$PRIMARY" "$FALLBACK"

ON_FAIL="$FO/server.log"
can "recover once the transports come back, with no restart and no intervention" \
  fetches_content_within 20 3
ON_FAIL=""

stop_peer "$PROXY_PID"
stop_peer "$SERVER_PID"

# Worth writing down, because it is why the proxy client above is started before
# anything is broken rather than during the outage: `ddrop connect` runs a
# runtime in-process and waits for `runtime.start()` before it binds its local
# port, and workspace start-up waits on the first presence announcement. With
# every transport unavailable that announcement retries behind an open breaker,
# so `ddrop connect` never finishes starting, never binds, and prints no error —
# a caller sees "connection refused" on a port that was never opened. Starting
# during a total outage is therefore not something this file can assert on.
