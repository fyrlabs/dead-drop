# Two peers exchanging real traffic over one shared filesystem transport.
#
# You do not need a second laptop. A peer is a runtime with its own data
# directory and peer id; what makes two runtimes peers is sharing one transport,
# not sitting on different hardware. Everything below is exercised for real:
# envelope encryption, chunking, the transport, the mailbox engine, discovery,
# exposures and the control plane.
#
# The scenarios share one pair of runtimes, because starting a runtime is the
# expensive part. They run in order and the destructive ones come last.

TP="$WORK/two-peers"
SHARED="$TP/store"
STATIC="$TP/site"
mkdir -p "$SHARED" "$STATIC"
echo "hello-from-peer-a" > "$STATIC/index.txt"
# Sits one level above the exposed directory, so a traversal that worked would
# return something recognisable rather than merely a different status code.
echo "NOT-FOR-THE-NETWORK" > "$TP/neighbour.txt"

# Predicates are named after the property they check, and defined up front:
# bash resolves a function at call time, so one defined below its use is simply
# missing. Each returns 0 for "the property holds".
discovers()   { dd "$1" discover --json | grep -q "\"$2\""; }
exposes()     { dd "$1" status --json | grep -q "\"$2\""; }
peer_is_gone() { ! quietly dd "$1" status; }

both_directions_discover() {
  wait_for 40 1 discovers "$TP/b" "$A_ID" && wait_for 20 1 discovers "$TP/a" "$B_ID"
}

distinct_identities() { [ -n "$A_ID" ] && [ -n "$B_ID" ] && [ "$A_ID" != "$B_ID" ]; }

# A negative needs a settling period, otherwise it only proves the check was
# quick. Six seconds is twenty poll intervals at this transport's cadence.
never_discovers() { # $1 = peer dir, $2 = id that must not appear
  sleep 6
  ! discovers "$1" "$2"
}

no_plaintext_on_the_wire() {
  ! find "$SHARED" -type f -exec grep -l "hello-from-peer-a" {} \; 2>/dev/null | grep -q .
}

documented_key_layout() { find "$SHARED" -type f | grep -q "demo/peers/"; }

# A HEAD answers with the file's metadata and none of its bytes. `content-length`
# is deliberately not among them: it is hop-by-hop, stripped by the protocol
# mapping, and recomputed by whichever server finally speaks to the client.
head_returns_metadata_only() {
  local headers="$TP/head.txt" out
  out=$(curl -s -I -D "$headers" -o /dev/null -w '%{http_code} %{size_download}' \
        --max-time 20 "http://127.0.0.1:$PORT/index.txt" 2>/dev/null)
  [ "$out" = "200 0" ] && grep -qi '^etag:' "$headers"
}

# --path-as-is matters: curl normalises `..` out of a URL before sending it, so
# without this the traversal never reaches the runtime and the check passes for
# the wrong reason. The target is a real file one level above the exposed
# directory, so a pass means the file was genuinely not served rather than
# merely absent.
traversal_is_refused() {
  local code body
  body=$(curl -s --path-as-is -w '\n%{http_code}' --max-time 20 \
         "http://127.0.0.1:$PORT/../neighbour.txt" 2>/dev/null)
  code=$(printf '%s' "$body" | tail -1)
  note "the traversal got http $code"
  # 404 rather than 403: `..` at the front of an absolute path normalises away
  # before the containment check sees it, so the path resolves inside the root
  # and simply does not exist there. Contained either way, which is the property.
  case "$body" in *NOT-FOR-THE-NETWORK*) return 1 ;; esac
  [ "$code" = "404" ] || [ "$code" = "403" ]
}

missing_exposure_is_named() {
  local port pid code body
  port=$(free_port)
  pid=$(start_connect "$TP/b" "$A_ID/no-such-exposure" "$port" "$TP/missing.log" 20000)
  code=$(http_code "http://127.0.0.1:$port/index.txt" "$TP/missing-body.txt" 40)
  body=$(cat "$TP/missing-body.txt" 2>/dev/null)
  stop_peer "$pid"
  note "the caller got http $code: $body"
  [ "$code" = "404" ] || return 1
  case "$body" in *NOT_FOUND*) return 0 ;; *) return 1 ;; esac
}

write_is_refused() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST --data 'x=1' \
         "http://127.0.0.1:$PORT/index.txt" 2>/dev/null)
  [ "$code" = "405" ]
}

ghost_peer_is_reported() {
  local port pid code body
  port=$(free_port)
  pid=$(start_connect "$TP/b" "ghost-peer/site" "$port" "$TP/ghost.log" 8000)
  code=$(http_code "http://127.0.0.1:$port/index.txt" "$TP/ghost-body.txt" 40)
  body=$(cat "$TP/ghost-body.txt" 2>/dev/null)
  stop_peer "$pid"
  note "the caller got http $code: $body"
  [ "$code" = "504" ] || return 1
  case "$body" in *TIMEOUT*) return 0 ;; *) return 1 ;; esac
}

big_payload_arrived_whole() { [ "$BIG_CODE" = "200" ] && [ "$BIG_GOT" = "$BIG_BYTES" ]; }
big_payload_is_identical() {
  [ "$(sha256_of "$STATIC/big.bin")" = "$(sha256_of "$TP/big-out.bin")" ]
}

inbox_is_drained() {
  [ "$(find "$SHARED" -type f -path "*inbox/$A_ID/*" 2>/dev/null | wc -l | tr -d ' ')" = "0" ]
}

# Peer A declares its exposure in config rather than through `ddrop expose`,
# because a config exposure is registered during workspace start: a request
# already sitting in the inbox cannot arrive before its handler exists. The
# `ddrop expose` path is exercised separately below.
write_config "$TP/a" "peer-a" "$(fs_transport "$SHARED")" \
  "{ \"name\": \"site\", \"type\": \"static\", \"directory\": \"$STATIC\" }"
write_config "$TP/b" "peer-b" "$(fs_transport "$SHARED")"

A_PID=$(start_peer "$TP/a" "$TP/a.log")
B_PID=$(start_peer "$TP/b" "$TP/b.log")

scenario "two peers find each other with nothing but a shared directory"

ON_FAIL="$TP/a.log"
can "start a peer that serves a directory" wait_up "$TP/a" "$A_PID"
ON_FAIL="$TP/b.log"
can "start a second peer beside it" wait_up "$TP/b" "$B_PID"
ON_FAIL=""

A_ID=$(dd_json "$TP/a" 'j.workspaces?.[0]?.peerId' status)
B_ID=$(dd_json "$TP/b" 'j.workspaces?.[0]?.peerId' status)
note "peer ids: '$A_ID' and '$B_ID'"

can "give each runtime its own identity in the workspace" distinct_identities
can "discover a peer that announced itself, in both directions" both_directions_discover

# Membership is the secret and the workspace name, not the directory. A runtime
# pointed at the same folder under a different workspace name is a stranger and
# has to stay one, because discovery is what everything else trusts.
WORKSPACE_NAME=other write_config "$TP/outsider" "outsider" "$(fs_transport "$SHARED")"
O_PID=$(start_peer "$TP/outsider" "$TP/outsider.log")
wait_up "$TP/outsider" "$O_PID" >/dev/null

cannot "be discovered by a runtime in another workspace that happens to share the directory" \
  never_discovers "$TP/b" "outsider"

stop_peer "$O_PID"

scenario "a directory on one machine is served on another"

PORT=$(free_port)
C_PID=$(start_connect "$TP/b" "$A_ID/site" "$PORT" "$TP/connect.log" 60000)
body=$(curl -s --max-time 30 "http://127.0.0.1:$PORT/index.txt" 2>/dev/null)

ON_FAIL="$TP/connect.log $TP/a.log"
can "fetch a file from the other peer with no direct connection between the two" \
  [ "$body" = "hello-from-peer-a" ]
ON_FAIL=""

# `ddrop expose` registers an exposure on a runtime that is already running,
# which is the interactive path and a different one from config exposures.
( cd "$TP/a" && exec $DDROP expose "$STATIC" --name files \
    --config "$TP/a/deaddrop.config.json" ) > "$TP/expose.log" 2>&1 &
EXPOSE_PID=$!
track "$EXPOSE_PID"

ON_FAIL="$TP/expose.log"
can "add an exposure to a runtime that is already serving traffic" \
  wait_for 15 1 exposes "$TP/a" files
ON_FAIL=""

# The peer is real and reachable; the exposure name is not. That has to read as
# "no such exposure" rather than as a transport or framing failure, or the first
# thing a user does is debug the wrong layer.
cannot "connect to an exposure the peer does not have, without being told which part was wrong" \
  missing_exposure_is_named

scenario "what the transport can see"

files=$(find "$SHARED" -type f | wc -l | tr -d ' ')
can "watch the traffic accumulate as ordinary files in the shared directory ($files objects)" \
  [ "$files" -gt 0 ]

# Invariant 9. Frame contents are ciphertext including the envelope header, so
# whoever holds the storage learns nothing about what was said.
cannot "read the payload out of the transport: every frame is ciphertext" \
  no_plaintext_on_the_wire

# Contents and keys are different promises. This check once covered only
# contents, so it passed while `ws/<workspace>/peers/<peer>.ddf` sat in the
# clear on a real repository. Keys carrying those names is deliberate and
# documented, so assert the documented shape rather than its absence: if the
# layout changes, docs/security-model.md is what has to change with it.
can "look at the storage and understand it: keys carry workspace and peer names by design" \
  documented_key_layout
note "keys are readable on purpose (docs/security-model.md); only frame contents are encrypted"

scenario "a static exposure serves files, and only files"

can "fetch a file that exists" [ "$(http_code "http://127.0.0.1:$PORT/index.txt")" = "200" ]
can "ask for a file's metadata without downloading it" head_returns_metadata_only

cannot "reach outside the exposed directory with a traversal path" traversal_is_refused
cannot "fetch a file that is not there" [ "$(http_code "http://127.0.0.1:$PORT/nope.txt")" = "404" ]
cannot "write to a static exposure" write_is_refused

scenario "reaching for a peer that is not there"

cannot "hang forever on a peer that never existed: the caller is told, and told why" \
  ghost_peer_is_reported

can "keep using the runtime afterwards, because one dead target poisons nothing" \
  [ "$(http_code "http://127.0.0.1:$PORT/index.txt")" = "200" ]

scenario "large payloads, and the size the runtime refuses"

BIG_BYTES=$((30 * 1024 * 1024))
OVER_BYTES=$((33 * 1024 * 1024))
head -c "$BIG_BYTES" /dev/urandom > "$STATIC/big.bin"
head -c "$OVER_BYTES" /dev/urandom > "$STATIC/over.bin"

BIG_PORT=$(free_port)
BIG_PID=$(start_connect "$TP/b" "$A_ID/site" "$BIG_PORT" "$TP/big-connect.log" 300000)

started=$(date +%s)
BIG_CODE=$(http_code "http://127.0.0.1:$BIG_PORT/big.bin" "$TP/big-out.bin" 300)
elapsed=$(( $(date +%s) - started ))
BIG_GOT=$(wc -c < "$TP/big-out.bin" | tr -d ' ')

ON_FAIL="$TP/big-connect.log"
can "move a 30 MiB file end to end in ${elapsed}s, which means chunking and reassembly both work" \
  big_payload_arrived_whole
ON_FAIL=""

can "trust the bytes: the payload is identical after encrypt, transport and decrypt" \
  big_payload_is_identical

# Past the cap the exposure has to refuse cheaply and legibly: not stall until
# the caller's timeout, and not ship 33 MiB before noticing.
over_code=$(http_code "http://127.0.0.1:$BIG_PORT/over.bin" "$TP/over-out.txt" 300)
over_body=$(cat "$TP/over-out.txt" 2>/dev/null)

cannot "serve a file past the 32 MiB cap, and does not truncate or hang instead" \
  [ "$over_code" = "413" ]
cannot "be left guessing why it was refused: the body names the cause" \
  [ "$over_body" = "File is too large to serve." ]

stop_peer "$BIG_PID"
stop_peer "$C_PID"
stop_peer "$EXPOSE_PID"

scenario "a peer that was offline when the request arrived"

# Kill peer A outright rather than stopping it politely. A laptop that closed
# its lid does not withdraw its presence beacon, and the property under test is
# that the request survives in the store until the peer comes back.
kill_peer "$A_PID"
sleep 2
cannot "reach a peer that is gone: it stops answering the moment it dies" \
  peer_is_gone "$TP/a"

OFF_PORT=$(free_port)
OFF_PID=$(start_connect "$TP/b" "$A_ID/site" "$OFF_PORT" "$TP/offline-connect.log" 120000)

# Fire the request with nobody listening. curl blocks; the envelope goes into
# peer A's inbox on the shared store and waits there.
curl -s --max-time 150 "http://127.0.0.1:$OFF_PORT/index.txt" > "$TP/offline-body.txt" 2>/dev/null &
CURL_PID=$!
track "$CURL_PID"
sleep 6

queued=$(find "$SHARED" -type f -path "*inbox/$A_ID/*" 2>/dev/null | wc -l | tr -d ' ')
cannot "lose a message sent to a peer that is not listening: it is queued, not dropped ($queued waiting)" \
  [ "$queued" -gt 0 ]

A_PID=$(start_peer "$TP/a" "$TP/a2.log")
ON_FAIL="$TP/a2.log"
can "bring the peer back and have it collect its mail" wait_up "$TP/a" "$A_PID"
ON_FAIL=""

wait "$CURL_PID" 2>/dev/null
untrack "$CURL_PID"
offline_body=$(cat "$TP/offline-body.txt" 2>/dev/null)

ON_FAIL="$TP/offline-connect.log $TP/a2.log"
can "get an answer to a request the peer was not around to hear" \
  [ "$offline_body" = "hello-from-peer-a" ]
ON_FAIL=""

stop_peer "$OFF_PID"

scenario "a message that outlived its own deadline"

# A request carries its timeout as the envelope TTL, because a request that
# outlives its caller's patience is garbage on the transport. A peer that finds
# one has to throw it away rather than answer a caller who stopped listening.
expired_before=$(metric "$TP/a" deaddrop_messages_dropped_total 'reason="expired"')
kill_peer "$A_PID"
sleep 2

# `call` addresses a channel directly, so this needs no exposure and no proxy.
deadline 25 $DDROP call "$A_ID" "http/site" --timeout 4000 \
  --config "$TP/b/deaddrop.config.json" >/dev/null 2>&1
sleep 6

A_PID=$(start_peer "$TP/a" "$TP/a3.log")
wait_up "$TP/a" "$A_PID" >/dev/null

expired_after=0
for _ in $(seq 20); do
  expired_after=$(metric "$TP/a" deaddrop_messages_dropped_total 'reason="expired"')
  [ "${expired_after:-0}" -gt "${expired_before:-0}" ] && break
  sleep 1
done

ON_FAIL="$TP/a3.log"
cannot "have a stale request answered late: the peer discards it as expired on arrival (dropped $expired_before -> $expired_after)" \
  [ "${expired_after:-0}" -gt "${expired_before:-0}" ]
ON_FAIL=""

cannot "leave the expired message sitting in the inbox forever" \
  wait_for 20 1 inbox_is_drained

# Expiry must not wedge the mailbox: the next real request still has to work.
LAST_PORT=$(free_port)
LAST_PID=$(start_connect "$TP/b" "$A_ID/site" "$LAST_PORT" "$TP/last-connect.log" 60000)
last_body=$(curl -s --max-time 30 "http://127.0.0.1:$LAST_PORT/index.txt" 2>/dev/null)

ON_FAIL="$TP/last-connect.log $TP/a3.log"
can "keep talking to a peer that has just discarded an expired message" \
  [ "$last_body" = "hello-from-peer-a" ]
ON_FAIL=""

stop_peer "$LAST_PID"
stop_peer "$A_PID"
stop_peer "$B_PID"
