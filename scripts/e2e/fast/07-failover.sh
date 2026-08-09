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
# file, because that is the realistic shape of an outage: it begins during a
# session, not before one. The last scenario starts a second proxy from inside a
# total outage, which is the other half of the same question.

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

# This file used to be the slow one in the fast tier, and almost all of it was
# spent waiting out timers rather than exercising anything. Three of them, in
# the order they cost:
#
#   healthIntervalMs  the reported status of a transport changes on a sweep, not
#                     on the failure itself, so "notice the primary died" waited
#                     up to a full 30s sweep however fast the failure was
#   breaker           30s before a probe is allowed through, so every "recover
#                     once it comes back" assertion waited that out too
#   retry             a ladder capped at 30s per delay in front of each attempt
#
# All three are config now, so the scenario shortens them instead of sleeping
# through them. The mechanism under test is identical; only the clock moved.
# Anything asserting a *duration* below is deliberately left alone, because a
# budget measured against shortened timers proves nothing about the defaults.
#   presenceIntervalMs  "the fallback is carrying traffic" is checked by looking
#                     for files in the fallback directory, and request objects
#                     are deleted as acknowledgement, so the beacon is the only
#                     thing reliably left behind -- which put a 30s floor under
#                     that assertion no matter how fast the failover itself was
TUNING='"healthIntervalMs": 1000,
  "presenceIntervalMs": 2000,
  "breaker": { "failureThreshold": 2, "resetTimeoutMs": 2000, "successThreshold": 1 },
  "retry": { "maxAttempts": 3, "initialDelayMs": 100, "maxDelayMs": 1000 }'

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

# The second proxy, started during a total outage rather than before one. Same
# shape as the pair above; kept separate so both can be live at once.
marooned_fetches_content() {
  [ "$(curl -s --max-time 20 "http://127.0.0.1:$MAROONED_PORT/index.txt" 2>/dev/null)" \
    = "served-over-either" ]
}
marooned_fetches_content_within() { # $1 = attempts, $2 = seconds between
  wait_for "$1" "$2" marooned_fetches_content
}

# 502 for a transport that cannot carry the message, 504 for a deadline reached
# while trying. Either is an answer; the failure this guards against is silence.
is_gateway_error() { # $1 = http status
  case "$1" in 502 | 504) return 0 ;; *) return 1 ;; esac
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
  "{ \"name\": \"site\", \"type\": \"static\", \"directory\": \"$STATIC\" }" "$POLICY, $TUNING"
write_config "$FO/client" "client" "$TRANSPORTS" "" "$POLICY, $TUNING"

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

scenario "a local server starts while nobody is reachable"

# The proxy above was started before anything broke, because until 0.3.1 one
# started during an outage never finished starting at all: `ddrop connect` runs
# a runtime in-process and binds its local port only after `runtime.start()`
# resolves, and workspace start-up awaited the first presence announcement,
# which sits in a retry ladder behind an open breaker. Nothing was printed and
# no port was opened, so a caller got "connection refused" and no reason for it.
#
# Peers join and quit whenever they like, which is the whole premise of a
# store-and-forward transport, so a local server that will not come up until a
# remote one is reachable has turned somebody else's absence into its own
# outage. The beacon is published in the background now and re-published every
# 30 seconds, so discoverability catches up on its own.
#
# This client gets a third transport, first in its own failover order, whose
# every operation fails after three seconds. A revoked directory fails in
# microseconds, which is fast enough that the old code bound its port anyway, so
# a scenario built only on the two above would pass either way and prove
# nothing. Three seconds an attempt is what an unreachable network remote
# actually costs, and it is what the bug was found on.
chmod 000 "$PRIMARY" "$FALLBACK"

MAROONED_TRANSPORTS="
  { \"use\": \"memory\", \"name\": \"slow\", \"config\": { \"namespace\": \"marooned\", \"failureRate\": 1, \"latencyMs\": 3000 } },
  $TRANSPORTS"
# This peer keeps the default retry ladder deliberately, unlike the two above.
# The bind assertion below is what catches the bug this scenario exists for, and
# it catches it precisely because the ladder in front of the announce is slow: a
# shortened one would let the old code bind inside the budget and prove nothing.
# Only the breaker's reset window and the health sweep are shortened, and
# neither can make that assertion easier to pass -- an earlier half-open lets
# another three-second probe through rather than skipping one.
write_config "$FO/marooned" "marooned" "$MAROONED_TRANSPORTS" "" \
  '"policy": { "mode": "failover", "primary": "slow", "fallback": ["primary", "fallback"] },
  "healthIntervalMs": 1000,
  "breaker": { "resetTimeoutMs": 2000 }'

MAROONED_PORT=$(free_port)
marooned_started=$(date +%s)
MAROONED_PID=$(start_connect "$FO/marooned" "server/site" "$MAROONED_PORT" "$FO/marooned.log" 15000)
marooned_bind_elapsed=$(( $(date +%s) - marooned_started ))

ON_FAIL="$FO/marooned.log"
can "start a proxy with every transport unavailable and have it bind its port" \
  port_accepts "$MAROONED_PORT"
ON_FAIL=""

# Awaiting the beacon put the whole retry ladder in front of the bind: measured
# at 12s here against the 3s-per-attempt transport above, and at minutes against
# a real remote behind an open breaker. Publishing it in the background brings
# that back to 2s, which is the transport manager's own opening health sweep and
# nothing else. The bound below sits between the two with room on either side.
cannot "make a caller wait out a dead transport before the port opens (${marooned_bind_elapsed}s)" \
  [ "$marooned_bind_elapsed" -le 8 ]

marooned_code=$(http_code "http://127.0.0.1:$MAROONED_PORT/index.txt" "$FO/marooned-body.txt" 120)
note "the marooned proxy answered http $marooned_code: $(cat "$FO/marooned-body.txt" 2>/dev/null)"

cannot "leave a caller refused on a port that was never opened" \
  [ "$marooned_code" != "000" ]

ON_FAIL="$FO/marooned.log"
can "answer a gateway error while it waits for a transport to come back" \
  is_gateway_error "$marooned_code"
ON_FAIL=""

chmod 755 "$PRIMARY" "$FALLBACK"

# The point of starting without a transport is being useful once there is one.
# This is also what makes the background beacon safe: nothing here was told to
# re-announce. The budget is wider than the pair above because every poll cycle
# on this client still pays a three-second probe on the failing transport until
# its breaker settles.
ON_FAIL="$FO/marooned.log $FO/server.log"
can "serve normally once a transport comes back, having never had one" \
  marooned_fetches_content_within 30 3
ON_FAIL=""

stop_peer "$MAROONED_PID"
stop_peer "$PROXY_PID"
stop_peer "$SERVER_PID"
