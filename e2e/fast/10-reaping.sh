# Mail addressed to a peer that never comes back, and mail addressed to one that does.
#
# Only the peer a message is for ever empties its inbox, so anything left for a
# peer that has gone is storage nothing reclaims. ADR 0006 added a reaper for
# it, and the whole difficulty is telling "gone" from "not looking right now".
#
# The unit tests own the sharp version of that distinction, because it needs a
# controlled clock: a peer with a fresh beacon and week-old mail must keep every
# message. What only a real runtime can show is the wiring -- that the pass
# fires on its own schedule, against real frames on a real transport, and stops
# at the boundary of what it was told to leave alone.
#
# Timings are scaled down hard, and the two that matter are derived rather than
# set. A beacon expires at three `presenceIntervalMs`, and a maintenance pass
# runs at ten of those again, so 200ms here means a beacon is stale in 600ms and
# a pass runs every 6 seconds. The 20 second window is deliberately wider than
# the whole of the first scenario and narrower than the wait in the second.

RP="$WORK/reaping"
SHARED="$RP/store"
mkdir -p "$SHARED"

TIMINGS='"presenceIntervalMs": 200, "inboxOrphanMs": 20000'

inbox_objects() { # $1 = peer id
  find "$SHARED" -type f -path "*inbox/$1/*" 2>/dev/null | wc -l | tr -d ' '
}

# Predicates, not expansions: `wait_for` re-runs its command, and a `$(...)`
# written at the call site would be expanded once and then polled forever
# against its own first answer.
inbox_has() { [ "$(inbox_objects "$1")" -gt 0 ]; }
inbox_drained() { [ "$(inbox_objects "$1")" -eq 0 ]; }
beacon_exists() { [ -n "$(find "$SHARED" -type f -path "*peers/$1.ddf" 2>/dev/null)" ]; }

write_config "$RP/a" "peer-a" "$(fs_transport "$SHARED")" \
  "{ \"name\": \"site\", \"type\": \"static\", \"directory\": \"$RP/a/public\" }" "$TIMINGS"
write_config "$RP/b" "peer-b" "$(fs_transport "$SHARED")" "" "$TIMINGS"

mkdir -p "$RP/a/public"
echo "hello-from-peer-a" > "$RP/a/public/index.txt"

A_PID=$(start_peer "$RP/a" "$RP/a.log")
B_PID=$(start_peer "$RP/b" "$RP/b.log")

scenario "mail for a peer that is briefly gone"

# Asserted rather than assumed: a config this scenario got wrong would
# otherwise surface as a queue that never fills, thirty seconds later, with
# nothing saying why.
ON_FAIL="$RP/a.log $RP/b.log"
can "start both peers on a scaled-down maintenance schedule" \
  wait_up "$RP/a" "$A_PID"
wait_up "$RP/b" "$B_PID" >/dev/null
ON_FAIL=""

# Killed, not stopped: a peer that exits politely withdraws its beacon, and the
# state worth testing is the one where it did not get the chance.
kill_peer "$A_PID"

A_PORT=$(free_port)
A_CONNECT=$(start_connect "$RP/b" "peer-a/site" "$A_PORT" "$RP/to-a.log" 120000)
curl -s --max-time 90 "http://127.0.0.1:$A_PORT/index.txt" > "$RP/a-body.txt" 2>/dev/null &
A_CURL=$!
track "$A_CURL"

ON_FAIL="$RP/to-a.log"
can "queue a request for a peer that is not listening" wait_for 30 1 inbox_has peer-a
ON_FAIL=""

# Peer A's beacon went stale within a second of it dying, so by now the only
# thing standing between this message and deletion is its own age. Sleep past a
# full maintenance pass and it must still be here: a reaper that went on age
# alone, or read the window wrongly, deletes it in this gap.
sleep 8
cannot "reap a message that is still inside its window ($(inbox_objects peer-a) waiting)" \
  inbox_has peer-a

A_PID=$(start_peer "$RP/a" "$RP/a2.log")
ON_FAIL="$RP/a2.log"
can "bring the peer back and have it collect its own mail" wait_up "$RP/a" "$A_PID"
ON_FAIL=""

wait "$A_CURL" 2>/dev/null
untrack "$A_CURL"
ON_FAIL="$RP/to-a.log $RP/a2.log"
can "answer the request the peer was not around to hear" \
  [ "$(cat "$RP/a-body.txt" 2>/dev/null)" = "hello-from-peer-a" ]
ON_FAIL=""
stop_peer "$A_CONNECT"

scenario "mail for a peer that never arrives at all"

# `peer-ghost` is in nobody's config, so it has never published a beacon and
# never will. This is the measured leak in miniature: every `ddrop connect`
# session takes its own short-lived address, and one that exits mid-transfer
# leaves exactly this behind.
GHOST_PORT=$(free_port)
GHOST_CONNECT=$(start_connect "$RP/b" "peer-ghost/site" "$GHOST_PORT" "$RP/to-ghost.log" 8000)
curl -s --max-time 20 "http://127.0.0.1:$GHOST_PORT/index.txt" > /dev/null 2>&1 &
GHOST_CURL=$!
track "$GHOST_CURL"

ON_FAIL="$RP/to-ghost.log"
can "strand a frame addressed to a peer that does not exist" wait_for 30 1 inbox_has peer-ghost
ON_FAIL=""

wait "$GHOST_CURL" 2>/dev/null
untrack "$GHOST_CURL"
stop_peer "$GHOST_CONNECT"

# Past the window, with no beacon anywhere in the workspace saying otherwise.
ON_FAIL="$RP/a2.log $RP/b.log"
can "reclaim a stranded frame once its owner is past the window and unannounced" \
  wait_for 45 1 inbox_drained peer-ghost
ON_FAIL=""

# Both peers are alive and announcing throughout, so their own beacons have to
# survive a pass that is deleting other things. Without these the scenario
# passes just as well against a reaper that clears the whole store.
cannot "take a running peer's beacon with it while reaping" beacon_exists peer-a
cannot "take the other running peer's beacon either" beacon_exists peer-b

stop_peer "$B_PID"
stop_peer "$A_PID"
