# Joining a workspace, and being removed from one. ADR 0007.
#
# Before this, membership was the secret and nothing else: adding a machine
# handed over the key to everything ever written, and removing one meant
# every remaining peer took a new secret by hand. Now each peer publishes a key
# of its own on first start, and `ddrop rotate` mints an era and wraps it for
# the peers that may still read.
#
# The unit tests own who gets wrapped for. What only real processes can show is
# that the peer left out actually goes dark: it keeps running, keeps announcing
# and keeps writing, and simply cannot read anything written after the rotation.
#
# The observable is content served through `ddrop connect`, the same one
# 06-key-rotation uses, because it exercises a full request and response rather
# than a getter. Presence is the second: beacons are frames too, so a peer that
# cannot read the current era stops seeing the peer that rotated at all.

EN="$WORK/enrollment"
SHARED="$EN/store"
STATIC="$EN/site"
mkdir -p "$SHARED" "$STATIC"
echo "enrolled-content" > "$STATIC/index.txt"

serves_content() { # $1 = client peer dir, $2 = log name, $3 = request timeout ms
  local port pid body
  port=$(free_port)
  pid=$(start_connect "$1" "admin/site" "$port" "$EN/$2" "${3:-20000}")
  body=$(curl -s --max-time "$(( ${3:-20000} / 1000 + 5 ))" "http://127.0.0.1:$port/index.txt" 2>/dev/null)
  stop_peer "$pid"
  [ "$body" = "enrolled-content" ]
}

# A negative has to outlast the announce interval, or it only proves the check
# was impatient. Same reasoning as 06-key-rotation.
never_sees_admin() {
  sleep 12
  ! dd "$1" discover --json | grep -q '"admin"'
}

fingerprint_of() { # $1 = peer id
  dd_json "$EN/admin" "j.peers.find((p) => p.peerId === '$1')?.fingerprint" peer list
}

enrolled_count() { [ "$(dd_json "$EN/admin" 'j.peers.length' peer list)" = "3" ]; }

# A one-second beacon, so a peer that has been rotated away from stops seeing
# the admin within the negative check's window rather than after the 30 second
# default. The beacon it wrote before the rotation is still readable to the peer
# that was left out; what removes it from `discover` is going stale, at three
# intervals. Nothing else in this file depends on the timing.
TIMINGS='"presenceIntervalMs": 1000'

# The admin serves the content and performs every rotation, and is the only peer
# that needs the strict tier: the setting governs the rotations this peer makes,
# not what anybody else may do.
write_config "$EN/admin" "admin" "$(fs_transport "$SHARED")" \
  "{ \"name\": \"site\", \"type\": \"static\", \"directory\": \"$STATIC\" }" \
  "$TIMINGS, \"enrollment\": { \"requireApproval\": true }"
write_config "$EN/kept" "kept" "$(fs_transport "$SHARED")" "" "$TIMINGS"
write_config "$EN/left" "left" "$(fs_transport "$SHARED")" "" "$TIMINGS"

ADMIN_PID=$(start_peer "$EN/admin" "$EN/admin.log")
KEPT_PID=$(start_peer "$EN/kept" "$EN/kept.log")
LEFT_PID=$(start_peer "$EN/left" "$EN/left.log")
wait_up "$EN/admin" "$ADMIN_PID" >/dev/null
wait_up "$EN/kept" "$KEPT_PID" >/dev/null
wait_up "$EN/left" "$LEFT_PID" >/dev/null

scenario "joining publishes a key, and costs nothing extra"

ON_FAIL="$EN/admin.log $EN/kept.log $EN/left.log"
can "enrol three peers with no approval, no ordering and no extra command" \
  wait_for 30 1 enrolled_count
ON_FAIL=""

KEPT_FP=$(fingerprint_of "kept")
LEFT_FP=$(fingerprint_of "left")

can "print a fingerprint a human could read down a phone line" \
  grep -Eq '^[0-9a-f]{4}(-[0-9a-f]{4}){3}$' <<<"$KEPT_FP"

# The baseline the rest of the file is measured against. Every peer reads
# everything until somebody rotates, which is what keeps upgrading a workspace
# uneventful.
can "talk to every peer before anybody has rotated" \
  serves_content "$EN/left" "left-before.log"

cannot "approve a peer with a fingerprint it does not publish" \
  not quietly dd "$EN/admin" peer approve kept 0000-0000-0000-0000

scenario "a rotation hands the new key only to the approved"

quietly dd "$EN/admin" peer approve kept "$KEPT_FP"
ROTATED=$(dd_json "$EN/admin" 'j.wrappedFor.sort().join(",")' rotate)
SKIPPED=$(dd_json "$EN/admin" 'j.skipped.join(",")' rotate)

can "wrap the new era for the peers that were approved" \
  [ "$ROTATED" = "admin,kept" ]

# `rotate` ran twice above, once per field read, so this is the second
# rotation's report. Both leave the same peer out, which is the point.
can "name the peer it left out rather than reporting a plain success" \
  [ "$SKIPPED" = "left" ]

ON_FAIL="$EN/admin.log $EN/kept.log"
can "keep serving the peer that was approved, with no restart anywhere" \
  serves_content "$EN/kept" "kept-after.log"
ON_FAIL=""

# Still running, still holding the workspace secret, and now unable to read a
# word written since the rotation. Presence included, which is why it loses
# sight of the admin entirely rather than seeing it and failing later.
cannot "read a workspace after a rotation you were left out of" \
  never_sees_admin "$EN/left"

cannot "half-read the new traffic: there is no plaintext path to degrade into" \
  not serves_content "$EN/left" "left-after.log" 8000

scenario "approving readmits, revoking removes again"

quietly dd "$EN/admin" peer approve left "$LEFT_FP"
READMITTED=$(dd_json "$EN/admin" 'j.wrappedFor.sort().join(",")' rotate)

can "hand the era to a peer approved after it had been left out" \
  [ "$READMITTED" = "admin,kept,left" ]

ON_FAIL="$EN/admin.log $EN/left.log"
can "read the workspace again once a rotation has included you" \
  serves_content "$EN/left" "left-readmitted.log"
ON_FAIL=""

quietly dd "$EN/admin" peer revoke left

# The misreading the CLI warns about, asserted rather than described: the
# revoked peer holds the era everybody is sealing under until a rotation
# replaces it, and no scheme can take that back.
ON_FAIL="$EN/admin.log $EN/left.log"
cannot "cut a peer off by revoking alone, without rotating" \
  serves_content "$EN/left" "left-revoked.log"
ON_FAIL=""

REVOKED=$(dd_json "$EN/admin" 'j.wrappedFor.sort().join(",")' rotate)

can "leave a revoked peer out of the next rotation" \
  [ "$REVOKED" = "admin,kept" ]

stop_peer "$ADMIN_PID"
stop_peer "$KEPT_PID"
stop_peer "$LEFT_PID"
