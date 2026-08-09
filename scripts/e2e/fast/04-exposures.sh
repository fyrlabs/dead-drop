# The two things a peer can publish, and who is allowed to ask for them.
#
# `static` serves a directory; `http` proxies a local server that never learns
# dead-drop exists. Only `static` had ever been driven by a script, which is why
# the proxy path is here: it is the one in the quick start.
#
# `allowPeers` is the only access control in the product. Every peer holding the
# workspace secret can address every other peer, so an exposure that should not
# be readable by the whole workspace has to say so, and that has to hold.
#
# The list names configured peer ids, exactly as they appear in a peer's config.
# That is worth asserting rather than assuming: `ddrop connect` runs its own
# runtime with its own mailbox address, `<configured>-c<pid>`, so that it never
# polls the same inbox as an already-running peer sharing the config. Until
# 0.2.7 that address was also what the exposure checked, so a hand-written list
# matched nobody and denied everyone.

EX="$WORK/exposures"
SHARED="$EX/store"
PRIVATE="$EX/private"
mkdir -p "$SHARED" "$PRIVATE"
echo "members-only" > "$PRIVATE/index.txt"

# The mailbox address a `ddrop connect` process announced, read from its own
# log. Used only to prove it differs from the identity being authorised.
connect_peer_id() { # $1 = connect log
  grep -o 'peer=[A-Za-z0-9._-]*' "$1" 2>/dev/null | head -1 | cut -d= -f2
}

transport_still_healthy() {
  [ "$(dd_json "$EX/a" 'j.transports?.[0]?.status' transport health)" = "healthy" ]
}

# An ordinary local web server, the kind someone already has running. It is
# never told about dead-drop and is reachable from nowhere but this machine.
TARGET_PORT=$(free_port)
node -e '
  const port = Number(process.argv[1]);
  require("http").createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ method: request.method, path: request.url }));
  }).listen(port, "127.0.0.1");
' "$TARGET_PORT" &
TARGET_PID=$!
track "$TARGET_PID"
# Detached from job control so that killing it later does not print "Killed"
# into the middle of the report. It is still an ordinary pid that cleanup kills.
disown "$TARGET_PID" 2>/dev/null
wait_for 15 1 port_accepts "$TARGET_PORT"

write_config "$EX/b" "peer-b" "$(fs_transport "$SHARED")"
write_config "$EX/c" "peer-c" "$(fs_transport "$SHARED")"

# The list is written the way a user would write it: the peer id from peer B's
# config, nothing discovered and nothing derived.
write_config "$EX/a" "peer-a" "$(fs_transport "$SHARED")" "
  { \"name\": \"private\", \"type\": \"static\", \"directory\": \"$PRIVATE\", \"allowPeers\": [\"peer-b\"] },
  { \"name\": \"api\", \"type\": \"http\", \"target\": \"http://127.0.0.1:$TARGET_PORT\" }"
A_PID=$(start_peer "$EX/a" "$EX/a.log")
wait_up "$EX/a" "$A_PID" >/dev/null

ALLOWED_PORT=$(free_port)
DENIED_PORT=$(free_port)
ALLOWED_PID=$(start_connect "$EX/b" "peer-a/private" "$ALLOWED_PORT" "$EX/allowed.log" 45000)
DENIED_PID=$(start_connect "$EX/c" "peer-a/private" "$DENIED_PORT" "$EX/denied.log" 45000)
note "the proxy clients hold the addresses '$(connect_peer_id "$EX/allowed.log")' and '$(connect_peer_id "$EX/denied.log")', neither of which appears in any config"

scenario "an exposure only some peers are allowed to call"

allowed_body=$(curl -s --max-time 45 "http://127.0.0.1:$ALLOWED_PORT/index.txt" 2>/dev/null)
ON_FAIL="$EX/allowed.log $EX/a.log"
can "write an allowPeers list against the peer ids in the configs, and have a proxy client match it" \
  [ "$allowed_body" = "members-only" ]
ON_FAIL=""

denied_code=$(http_code "http://127.0.0.1:$DENIED_PORT/index.txt" "$EX/denied-body.txt" 45)
denied_body=$(cat "$EX/denied-body.txt" 2>/dev/null)
note "the peer that is not listed got http $denied_code: $denied_body"

# Holding the workspace secret is not the same as being allowed to call this.
cannot "fetch an exposure your peer id is not listed on, even holding the workspace secret" \
  [ "$denied_code" = "403" ]

cannot "be refused without being told why" \
  [ "$denied_body" = "This exposure does not accept requests from your peer." ]

stop_peer "$ALLOWED_PID"
stop_peer "$DENIED_PID"

scenario "a local web server, reachable from another machine"

API_PORT=$(free_port)
API_PID=$(start_connect "$EX/b" "peer-a/api" "$API_PORT" "$EX/api.log" 30000)

api_body=$(curl -s --max-time 30 "http://127.0.0.1:$API_PORT/users?active=1" 2>/dev/null)
ON_FAIL="$EX/api.log $EX/a.log"
can "reach a local server on another machine that was never changed to allow it" \
  [ -n "$api_body" ]
ON_FAIL=""

# A proxy is transparent or it is not a proxy: method and path have to survive
# the crossing intact, not merely the status code.
can "have the method and path arrive at the local server unchanged" \
  [ "$api_body" = '{"method":"GET","path":"/users?active=1"}' ]

posted=$(curl -s --max-time 30 -X POST --data 'x=1' \
         "http://127.0.0.1:$API_PORT/submit" 2>/dev/null)
can "make a POST across the transport, not only reads" \
  [ "$posted" = '{"method":"POST","path":"/submit"}' ]

# Kill the exposed server, not the runtime. The runtime is healthy; the thing it
# proxies to is not, and the caller has to be able to tell those apart.
kill -9 "$TARGET_PID" 2>/dev/null
untrack "$TARGET_PID"
sleep 1

down_code=$(http_code "http://127.0.0.1:$API_PORT/users" "$EX/down-body.txt" 60)
down_body=$(cat "$EX/down-body.txt" 2>/dev/null)
note "with the local server stopped, the caller got http $down_code: $down_body"

cannot "reach a local server that is not running, and does not hang waiting for it" \
  [ "$down_code" = "502" ]

cannot "mistake a dead local server for a dead peer: the message names the target" \
  [ "$down_body" = "The exposed target is not reachable from the dead-drop runtime." ]

# The runtime carried a failing exposure without becoming one itself.
can "keep the runtime and its transport healthy while an exposed target is down" \
  transport_still_healthy

stop_peer "$API_PID"
stop_peer "$A_PID"
