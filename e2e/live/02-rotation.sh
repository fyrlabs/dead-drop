# Rotating an era through a real GitHub repository. ADR 0007.
#
# The fast tier already owns who a rotation wraps for, and it owns it better
# than this file could: a shared directory makes every object visible the
# instant it is written, so the semantics are easy to assert there.
#
# What a shared directory cannot present is that a rotation is not one write.
# It is a wrapped key per peer plus the era pointer that tells everybody what
# to seal under, and over git those land on one branch through fetch, commit
# and push, becoming visible to another machine only after it fetches. If a
# peer sees the pointer before the key wrapped for it arrives, it holds a
# pointer to an era it cannot open. That is the `waitingFor` state, and it is
# worth a live scenario because nothing else about the peer looks wrong: it
# keeps running, keeps announcing and keeps writing, and simply reads nothing
# new. Only a real remote produces the ordering that causes it.
#
# The removal half runs under `requireApproval`, because that is the only
# configuration in which a rotation removes anybody. With it off a rotation
# wraps for every enrolled peer and changes nothing about who can read, which
# is the distinction the README and docs/security-model.md both spell out.
#
# The workspace name is deliberately not the default. Identity objects are not
# deleted when a peer stops, so 01-github's peers are still enrolled in `demo`
# for the rest of the run and a count of who is enrolled here would count them.

ROT="$WORK/rotation"
STATIC="$ROT/site"
mkdir -p "$ROT" "$STATIC"
echo "rotated-over-github" > "$STATIC/index.txt"

# Defined here rather than borrowed from 01-github. Scenarios are sourced into
# one shell, so borrowing works for a whole-tier run and breaks the moment
# somebody runs this one alone with `--only`, which is exactly how it will be
# run while it is being changed.
rot_transport() { # $1 = work dir
  printf '{ "use": "github", "config": { "repo": "%s", "workDir": "%s", "createIfMissing": false, "rateLimitIntervalMs": 5000 } }' \
    "$REPO" "$1"
}
ROT_POLLING='"polling": { "minIntervalMs": 3000, "maxIntervalMs": 15000 }'

sealing_of() { # $1 = peer dir; the era id this peer currently seals under
  dd_json "$1" 'j.sealing' peer list
}

enrolled_both() { [ "$(dd_json "$ROT/rot-a" 'j.peers.length' peer list)" = "2" ]; }

# Asserted rather than assumed: a rotation that reported success and promoted
# nothing would leave this equal to what it was, and every later check here
# would pass against it.
era_moved() { [ -n "$AFTER" ] && [ "$AFTER" != "$BEFORE" ]; }

# Sealing under the era the rotation minted is the positive form of "not
# stranded": a peer reporting `waitingFor` holds the pointer and not the key,
# and cannot be sealing under that era at the same time.
b_sealed_under_new() { [ "$(sealing_of "$ROT/rot-b")" = "$AFTER" ]; }

# A real request and response, not a getter. The timeout is an argument because
# the negative has to be generous enough that a failure means "cannot read"
# rather than "was slower than a GitHub round trip", and 27s round trips are
# normal on this tier.
serves_content() { # $1 = client peer dir, $2 = log name, $3 = timeout ms
  local port pid body
  port=$(free_port)
  pid=$(start_connect "$1" "rot-a/site" "$port" "$ROT/$2" "${3:-300000}")
  body=$(curl -s --max-time "$(( ${3:-300000} / 1000 + 5 ))" "http://127.0.0.1:$port/index.txt" 2>/dev/null)
  stop_peer "$pid"
  [ "$body" = "rotated-over-github" ]
}

WORKSPACE_NAME=rotation write_config "$ROT/rot-a" "rot-a" "$(rot_transport "$ROT/a/work")" \
  "{ \"name\": \"site\", \"type\": \"static\", \"directory\": \"$STATIC\" }" \
  "$ROT_POLLING, \"enrollment\": { \"requireApproval\": true }"
WORKSPACE_NAME=rotation write_config "$ROT/rot-b" "rot-b" "$(rot_transport "$ROT/b/work")" "" "$ROT_POLLING"

A_PID=$(start_peer "$ROT/rot-a" "$ROT/a.log")
B_PID=$(start_peer "$ROT/rot-b" "$ROT/b.log")
wait_up "$ROT/rot-a" "$A_PID" >/dev/null
wait_up "$ROT/rot-b" "$B_PID" >/dev/null

scenario "rotating an era through a real repository"

ON_FAIL="$ROT/a.log $ROT/b.log"
can "enrol two machines through nothing but a git repository" \
  wait_for 60 3 enrolled_both
ON_FAIL=""

BEFORE=$(sealing_of "$ROT/rot-a")
B_FP=$(dd_json "$ROT/rot-a" "j.peers.find((p) => p.peerId === 'rot-b')?.fingerprint" peer list)
quietly dd "$ROT/rot-a" peer approve rot-b "$B_FP"

# One rotation, parsed twice. Reading each field through its own `dd_json` would
# rotate twice, mint two eras and leave `AFTER` naming an era nobody measured.
FIRST=$(dd "$ROT/rot-a" rotate --json)
ROTATED=$(echo "$FIRST" | json_get 'j.wrappedFor.sort().join(",")')
AFTER=$(sealing_of "$ROT/rot-a")

ON_FAIL="$ROT/a.log"
can "wrap a new era for an approved peer over a real remote" \
  [ "$ROTATED" = "rot-a,rot-b" ]

can "leave the era it was sealing under, rather than reporting a rotation it did not perform" \
  era_moved
ON_FAIL=""

# The ordering hazard, and the reason this file exists. The wrapped key and the
# pointer are separate objects on one branch, and both have to arrive.
ON_FAIL="$ROT/b.log"
can "carry the rotation to the other machine, wrapped key and pointer together" \
  wait_for 60 3 b_sealed_under_new
ON_FAIL=""

ON_FAIL="$ROT/connect-kept.log $ROT/a.log $ROT/b.log"
can "serve a request across the internet under the era the rotation minted" \
  serves_content "$ROT/rot-b" "connect-kept.log"
ON_FAIL=""

quietly dd "$ROT/rot-a" peer revoke rot-b
SECOND=$(dd "$ROT/rot-a" rotate --json)
LEFT_OUT=$(echo "$SECOND" | json_get 'j.skipped.join(",")')

can "name the peer it left out rather than reporting a plain success" \
  [ "$LEFT_OUT" = "rot-b" ]

# rot-b is still running, still holds the workspace secret, still reaches the
# repository and still writes to it. What it cannot do is read the response,
# because that is sealed under an era nothing wrapped for it. The request it
# sends is sealed under the era it still holds, which rot-a can still open, so
# this is a peer that is answered and cannot hear the answer.
ON_FAIL="$ROT/connect-cut.log $ROT/a.log $ROT/b.log"
cannot "read a workspace across the internet after a rotation you were left out of" \
  not serves_content "$ROT/rot-b" "connect-cut.log" 90000
ON_FAIL=""

stop_peer "$A_PID"
stop_peer "$B_PID"
