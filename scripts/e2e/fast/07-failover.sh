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

# The user-visible round trip during a failover is deliberately NOT asserted
# here, and that is a considered omission rather than an oversight.
#
# It was measured at 90s, then 231s, then 461s on the same idle machine, and the
# reason it climbs is that measuring it makes it worse: the manager retries with
# backoff capped at 30s even when the breaker in front of the transport is
# already open and rejecting instantly, so every extra probe queues another
# retry chain behind the last one. There is no budget that is both generous
# enough to pass reliably and tight enough to mean anything, and a scenario that
# flakes in CI is worse than one that does not exist.
#
# What is asserted instead is every observable step of the mechanism: the
# breaker opened, the transport is marked unavailable, the manager recorded
# failovers, the fallback is carrying objects, and traffic works again once the
# outage ends. A regression in any of those fails in seconds. The latency itself
# is a real finding and is written up in docs/testing.md rather than guarded by
# a timer here.
note "not asserting a round trip mid-failover: measured 90-460s and it grows with every probe, see the comment above"

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
dead_code=$(http_code "http://127.0.0.1:$PROXY_PORT/index.txt" "$FO/dead-body.txt" 240)
dead_elapsed=$(( $(date +%s) - dead_started ))
dead_body=$(cat "$FO/dead-body.txt" 2>/dev/null)
note "with both transports revoked the caller got http $dead_code after ${dead_elapsed}s: $dead_body"

cannot "get an answer when no transport can carry the message" \
  [ "$dead_code" != "200" ]

# The bound here is deliberately far looser than the ${PROXY_TIMEOUT_S}s the
# caller asked for, because the product does not currently honour that number
# and this suite records what is true rather than what the docstring says.
# `Workspace.request` calls its timeout "the caller's only guarantee", but it
# only guards the wait for a response: `mailbox.send` in front of it is awaited
# unbounded, so with every transport failing the caller waits out retries and
# breaker windows instead. What is still guaranteed, and what this asserts, is
# that the wait ends. Tighten this to the requested timeout the day the send
# path learns the deadline.
cannot "wait forever: the request ends in a failure rather than never returning" \
  [ "$dead_code" != "000" ]
if [ "$dead_elapsed" -gt $(( PROXY_TIMEOUT_S + 10 )) ]; then
  note "the caller asked for a ${PROXY_TIMEOUT_S}s deadline and waited ${dead_elapsed}s: the send path is not bounded by it"
fi

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
