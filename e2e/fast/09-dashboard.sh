# What a dashboard is allowed to do, and what it must never do.
#
# `ddrop dashboard` is the one command that binds a TCP port, which at a glance
# contradicts invariant 3. It does not: the control plane keeps its socket and
# the dashboard is another client of it (ADR 0004). Two properties are what make
# that true, and neither is visible from reading the page — it must start no
# runtime, so it never appears in the workspace, and it must serve no route that
# writes. Both are asserted here against the real binary.

# Predicates first. Bash resolves a function at call time, so one defined below
# its `can` line is simply missing.

page_served() {
  [ "$(http_code "http://127.0.0.1:$DASH_PORT/" "$DASH/page.html" 10)" = "200" ]
}

library_served() {
  http_code "http://127.0.0.1:$DASH_PORT/lume.min.mjs" "$DASH/lume.mjs" 10 >/dev/null
  grep -q 'export{' "$DASH/lume.mjs"
}

page_needs_no_network() {
  # A CDN import would leave the dashboard blank on the offline machines this
  # product exists for.
  ! grep -qE '(src|href)="https?://' "$DASH/page.html"
}

dashboard_reports_queue_depth() {
  local answered
  answered=$(curl -s --max-time 10 "http://127.0.0.1:$DASH_PORT/api/queues" | json_get 'j.read')
  [ "${answered:-0}" -ge 1 ]
}

# A `cannot` passes when its predicate holds, so each of these states the safe
# condition rather than the forbidden one.

write_routes_are_refused() {
  local publish posted
  # Two separate refusals. `/publish` is not proxied at all, and no route the
  # dashboard does serve accepts a verb that writes -- the method is checked
  # before the path, so a POST is turned away without even saying what exists.
  publish=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    "http://127.0.0.1:$DASH_PORT/api/publish" 2>/dev/null)
  posted=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    -X POST --data '{}' "http://127.0.0.1:$DASH_PORT/api/status" 2>/dev/null)
  [ "$publish" = "404" ] && [ "$posted" = "405" ]
}

foreign_host_is_refused() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    -H 'Host: rebound.example' "http://127.0.0.1:$DASH_PORT/api/status" 2>/dev/null)
  [ "$code" = "403" ]
}

only_the_peer_itself_is_visible() {
  local peers
  peers=$(dd_json "$DASH/peer" 'j.peers.length' discover)
  [ "${peers:-0}" = "1" ]
}

second_dashboard_names_the_clash() {
  deadline 20 $DDROP dashboard --port "$DASH_PORT" --no-open \
    --config "$DASH/peer/deaddrop.config.json" > "$DASH/second.log" 2>&1
  grep -q "already in use" "$DASH/second.log"
}

second_dashboard_printed_no_url() {
  ! grep -q 'http://127.0.0.1' "$DASH/second.log"
}

scenario "a dashboard reads a running peer without joining its workspace"

DASH="$WORK/dashboard"
SHARED="$DASH/store"
mkdir -p "$SHARED"

write_config "$DASH/peer" "dash-peer" "$(fs_transport "$SHARED")"
PEER_PID=$(start_peer "$DASH/peer" "$DASH/peer.log")

ON_FAIL="$DASH/peer.log"
can "start the runtime the dashboard will read" \
  wait_up "$DASH/peer" "$PEER_PID"
ON_FAIL=""

# Something waiting for a peer that is not running, so the dashboard has a
# non-empty report to answer with.
quietly $DDROP call nobody-home demo/thing --timeout 2000 \
  --config "$DASH/peer/deaddrop.config.json"

DASH_PORT=$(free_port)
( cd "$DASH/peer" && exec $DDROP dashboard --port "$DASH_PORT" --no-open \
    --config "$DASH/peer/deaddrop.config.json" ) > "$DASH/dashboard.log" 2>&1 &
DASH_PID=$!
track "$DASH_PID"

ON_FAIL="$DASH/dashboard.log"
can "bind the dashboard on exactly the port it was given" \
  wait_for 30 1 port_accepts "$DASH_PORT"
ON_FAIL=""

can "serve the page" page_served
can "serve the reactive library from the package rather than a CDN" library_served
can "render with no network at all" page_needs_no_network
can "report queued depth through the dashboard, with no second runtime anywhere" \
  dashboard_reports_queue_depth

# The two properties the ADR rests on.
cannot "publish through the dashboard: every route it serves only reads" \
  write_routes_are_refused
cannot "reach the dashboard from a page that rebound its own name to 127.0.0.1" \
  foreign_host_is_refused
cannot "appear in the workspace as a phantom peer, because a dashboard starts no runtime" \
  only_the_peer_itself_is_visible

scenario "a taken port is an error, not a reason to move"

# A dashboard that silently picks another port is a dashboard nobody can
# bookmark, and it hides that something else already owns the one you asked for.
can "name the port that is already in use" second_dashboard_names_the_clash
cannot "start anyway on a port nobody asked for" second_dashboard_printed_no_url

stop_peer "$DASH_PID"
stop_peer "$PEER_PID"
