# Changing the workspace secret without taking the workspace down.
#
# `secrets` is a list, and the order is the whole mechanism: the first entry
# encrypts, every entry decrypts. So a rotation is two deployments, not one.
# Everyone adds the new key as a second entry, then everyone promotes it to
# first. Doing it in one step locks out whoever has not restarted yet.
#
# The negative half is the one that matters: a peer holding only the retired key
# must fail closed. There is no plaintext fallback and no "unknown key" path
# that treats a frame as readable, so a peer left behind goes quiet rather than
# quietly wrong. That is also why the failure looks like a peer that vanished.

KR="$WORK/key-rotation"
SHARED="$KR/store"
STATIC="$KR/site"
mkdir -p "$SHARED" "$STATIC"
echo "rotated-content" > "$STATIC/index.txt"

OLD_KEY="$DEADDROP_SECRET"
NEW_KEY=$($DDROP keygen 2>/dev/null | grep '^ddk1_')

serves_content() { # $1 = client peer dir, $2 = log name, $3 = request timeout ms
  local port pid body
  port=$(free_port)
  pid=$(start_connect "$1" "keeper/site" "$port" "$KR/$2" "${3:-20000}")
  body=$(curl -s --max-time "$(( ${3:-20000} / 1000 + 5 ))" "http://127.0.0.1:$port/index.txt" 2>/dev/null)
  stop_peer "$pid"
  [ "$body" = "rotated-content" ]
}

sees_keeper() { wait_for 25 1 grep_discover "$1"; }
grep_discover() { dd "$1" discover --json | grep -q '"keeper"'; }

# Deliberately not `sees_keeper` inverted with a short timeout: a negative needs
# to outlast the announce interval, or it only proves the check was impatient.
never_sees_keeper() {
  sleep 12
  ! grep_discover "$1"
}

# The peer that serves content. It starts on the old key like everyone else.
SECRETS_BODY="\"$OLD_KEY\"" write_config "$KR/keeper" "keeper" "$(fs_transport "$SHARED")" \
  "{ \"name\": \"site\", \"type\": \"static\", \"directory\": \"$STATIC\" }"

# Stage one of the rotation: this peer accepts both keys and still encrypts with
# the old one, which is what every peer looks like mid-rollout.
SECRETS_BODY="\"$OLD_KEY\", \"$NEW_KEY\"" write_config "$KR/ready" "ready" "$(fs_transport "$SHARED")"

# The peer nobody remembered to update. Old key only.
SECRETS_BODY="\"$OLD_KEY\"" write_config "$KR/stale" "stale" "$(fs_transport "$SHARED")"

KEEPER_PID=$(start_peer "$KR/keeper" "$KR/keeper.log")
READY_PID=$(start_peer "$KR/ready" "$KR/ready.log")
STALE_PID=$(start_peer "$KR/stale" "$KR/stale.log")
wait_up "$KR/keeper" "$KEEPER_PID" >/dev/null
wait_up "$KR/ready" "$READY_PID" >/dev/null
wait_up "$KR/stale" "$STALE_PID" >/dev/null

scenario "adding a second key changes nothing while the old one still encrypts"

ON_FAIL="$KR/ready.log"
can "hold two keys at once and keep talking to peers that hold only the first" \
  serves_content "$KR/ready" "ready-before.log"
ON_FAIL=""

can "hold only the old key and be none the wiser that a rotation is under way" \
  serves_content "$KR/stale" "stale-before.log"

# Nothing has actually rotated yet, so a peer with only the new key is the one
# that must be shut out at this point. Same mechanism, other direction.
SECRETS_BODY="\"$NEW_KEY\"" write_config "$KR/early" "early" "$(fs_transport "$SHARED")"
EARLY_PID=$(start_peer "$KR/early" "$KR/early.log")
wait_up "$KR/early" "$EARLY_PID" >/dev/null

cannot "join a workspace with a key nobody else accepts yet" \
  never_sees_keeper "$KR/early"

stop_peer "$EARLY_PID"

scenario "promoting the new key retires the old one"

# Stage two: the keeper promotes the new key to first, so everything it writes
# from now on is encrypted with it. Peers still listing both keys carry on;
# peers listing only the old one drop off.
stop_peer "$KEEPER_PID"
SECRETS_BODY="\"$NEW_KEY\", \"$OLD_KEY\"" write_config "$KR/keeper" "keeper" \
  "$(fs_transport "$SHARED")" \
  "{ \"name\": \"site\", \"type\": \"static\", \"directory\": \"$STATIC\" }"
KEEPER_PID=$(start_peer "$KR/keeper" "$KR/keeper2.log")
wait_up "$KR/keeper" "$KEEPER_PID" >/dev/null

ON_FAIL="$KR/ready.log $KR/keeper2.log"
can "rotate the encrypting key with no downtime for peers that added it in advance" \
  serves_content "$KR/ready" "ready-after.log"
ON_FAIL=""

# The stale peer is still running, still holds the workspace secret it was given,
# and is now simply unable to read anything the keeper writes. Beacons included,
# which is why it stops seeing the keeper at all rather than seeing it and
# failing later.
cannot "read a workspace after its key was rotated away from you" \
  never_sees_keeper "$KR/stale"

cannot "half-read the new traffic: there is no plaintext fallback to degrade into" \
  not serves_content "$KR/stale" "stale-after.log" 8000

stop_peer "$KEEPER_PID"
stop_peer "$READY_PID"
stop_peer "$STALE_PID"
