#!/usr/bin/env bash
# Harness for the scenario suite. Sourced by e2e/run.sh; not runnable alone.
#
# Every scenario asserts what a user CAN do and what a user CANNOT do. Both
# halves are required: a capability nobody has bounded is a capability nobody
# understands, and the runner fails a scenario that only declares one kind.
#
# Assertions are written as a description plus a command:
#
#   can    "peer B fetches peer A's file" [ "$body" = hello ]
#   cannot "the payload is readable on the transport" ! grep -qr hello "$STORE"
#
# `[` is an ordinary command, so this reads as prose and still runs as a test.

# ---------------------------------------------------------------- accounting

PASS=0
FAIL=0
SCENARIO=""
SCENARIO_CAN=0
SCENARIO_CANNOT=0
SCENARIO_STARTED_AT=0
FAILED_SCENARIOS=""

# Naming convention, and it is load-bearing rather than cosmetic: scenario files
# are sourced into the runner's shell, so every variable is shared. Harness and
# runner state is UPPER CASE; scenario files use lower case for their own
# working variables. A scenario timing something with `started` once overwrote
# the runner's own clock, and the suite reported the duration of that one
# measurement as the duration of the whole tier.

# Colour only when a human is watching. CI logs keep the escape codes out.
if [ -t 1 ]; then
  C_PASS=$'\033[32m'; C_FAIL=$'\033[31m'; C_HEAD=$'\033[1m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_PASS=""; C_FAIL=""; C_HEAD=""; C_DIM=""; C_OFF=""
fi

scenario() {
  finish_scenario
  SCENARIO="$1"
  SCENARIO_CAN=0
  SCENARIO_CANNOT=0
  SCENARIO_STARTED_AT=$(date +%s)
  echo
  echo "${C_HEAD}scenario: $1${C_OFF}"
}

# A scenario that only says what works has not been thought through. This is a
# structural check on the suite itself, so it counts as a failure like any other.
finish_scenario() {
  [ -z "$SCENARIO" ] && return 0
  if [ "$SCENARIO_CAN" -eq 0 ] || [ "$SCENARIO_CANNOT" -eq 0 ]; then
    echo "  ${C_FAIL}BROKEN${C_OFF}  scenario '$SCENARIO' declares ${SCENARIO_CAN} CAN and ${SCENARIO_CANNOT} CANNOT; both halves are required"
    FAIL=$((FAIL + 1))
    record_failure "$SCENARIO"
  fi
  # Per-scenario timing, so the slow ones are obvious without a stopwatch.
  local took=$(( $(date +%s) - SCENARIO_STARTED_AT ))
  [ "$took" -ge 20 ] && note "that scenario took ${took}s"
  SCENARIO=""
}

pass() { echo "  ${C_PASS}PASS${C_OFF}    $1"; PASS=$((PASS + 1)); }
fail() { echo "  ${C_FAIL}FAIL${C_OFF}    $1"; FAIL=$((FAIL + 1)); record_failure "$SCENARIO"; }
note() { echo "  ${C_DIM}....    $1${C_OFF}"; }

# Names can contain spaces, so the list is pipe-delimited rather than word-split.
record_failure() {
  [ -n "$1" ] || return 0
  case "|$FAILED_SCENARIOS" in
    *"|$1|"*) return 0 ;;
  esac
  FAILED_SCENARIOS="$FAILED_SCENARIOS$1|"
}

can() {
  local desc="$1"; shift
  SCENARIO_CAN=$((SCENARIO_CAN + 1))
  if "$@"; then pass "CAN     $desc"; else fail "CAN     $desc"; dump_context; fi
}

cannot() {
  local desc="$1"; shift
  SCENARIO_CANNOT=$((SCENARIO_CANNOT + 1))
  if "$@"; then pass "CANNOT  $desc"; else fail "CANNOT  $desc"; dump_context; fi
}

# Runs a command for its exit code alone. Assertions are prose plus a predicate;
# a CLI that prints its usual output in the middle of the report is noise.
quietly() { "$@" >/dev/null 2>&1; }

# Negates a predicate. `can "..." ! foo` cannot work: `!` is shell syntax, not a
# command, so it never survives being passed as the first word of "$@".
not() { ! "$@"; }

# Logs a scenario wants shown when the next assertion fails. A failing assertion
# without the runtime log beside it costs a whole second run to diagnose.
ON_FAIL=""
dump_context() {
  local file
  for file in $ON_FAIL; do context "$file" "${ON_FAIL_LINES:-20}"; done
}

# Dumps the tail of a log next to a failure. Silent when the file is missing so
# a scenario can offer context it did not always produce.
context() {
  local file="$1" lines="${2:-15}"
  [ -f "$file" ] || return 0
  echo "  ${C_DIM}--- ${file##*/} ---${C_OFF}"
  tail -"$lines" "$file" | sed 's/^/      /'
}

# ------------------------------------------------------------------ processes

TRACKED_PIDS=""

track() { TRACKED_PIDS="$TRACKED_PIDS $1"; }

untrack() {
  local keep="" pid
  for pid in $TRACKED_PIDS; do [ "$pid" = "$1" ] || keep="$keep $pid"; done
  TRACKED_PIDS="$keep"
}

# SIGTERM alone leaves runtimes behind when the kill lands while one is still
# starting up, so always follow with SIGKILL before removing anything.
kill_tracked() {
  local pid
  for pid in $TRACKED_PIDS; do kill "$pid" 2>/dev/null; done
  sleep 2
  for pid in $TRACKED_PIDS; do kill -9 "$pid" 2>/dev/null; done
  TRACKED_PIDS=""
}

cleanup() {
  kill_tracked
  # A git-backed runtime may still be committing into its clone when the kill
  # lands, so a single rm loses the race and reports "Directory not empty".
  local attempt
  for attempt in 1 2 3; do
    sleep 1
    rm -rf "$WORK" 2>/dev/null && return
  done
  rm -rf "$WORK" 2>/dev/null
}

# ------------------------------------------------------------------- utilities

# Ask the OS for a free port rather than hard-coding one, so a straggler from an
# earlier run cannot make this look like a product failure.
free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}

# macOS ships shasum, most Linux images ship sha256sum. Neither is guaranteed.
sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else sha256sum "$1" | cut -d' ' -f1; fi
}

# `jq` is not assumed; node is already a hard requirement.
json_get() { # $1 = expression over the parsed document `j`, reads stdin
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const v=($1);console.log(v===undefined||v===null?'':v)}catch{console.log('')}})"
}

# Waits for a command to succeed. Polling beats a fixed sleep: the filesystem
# transport settles in under a second and the git one takes tens of them.
wait_for() { # $1 = attempts, $2 = seconds between, rest = command
  local attempts="$1" gap="$2"; shift 2
  local i
  for i in $(seq "$attempts"); do
    "$@" >/dev/null 2>&1 && return 0
    sleep "$gap"
  done
  return 1
}

# Runs a command with an upper bound on how long it may take. macOS ships no
# `timeout`, and a scenario that hangs forever is worse than one that fails.
# The guard polls instead of being killed afterwards, because reaping a killed
# background job makes bash print "Terminated" into the middle of the report.
deadline() { # $1 = seconds, rest = command
  local seconds="$1"; shift
  "$@" &
  local pid=$!
  (
    local i
    for i in $(seq "$seconds"); do
      sleep 1
      kill -0 "$pid" 2>/dev/null || exit 0
    done
    kill -9 "$pid" 2>/dev/null
  ) &
  wait "$pid"
}

# ------------------------------------------------------------------- the CLI

# `$DDROP` may be `node /path/bin.js`, which only word-splits under a shell that
# splits unquoted expansions. This suite runs under bash for that reason.
dd() { # $1 = peer dir, rest = ddrop arguments
  local dir="$1"; shift
  $DDROP "$@" --config "$dir/deaddrop.config.json" 2>/dev/null
}

dd_json() { # same, with --json, returning the parsed field in $2 via json_get
  local dir="$1" expr="$2"; shift 2
  $DDROP "$@" --json --config "$dir/deaddrop.config.json" 2>/dev/null | json_get "$expr"
}

# Sums every Prometheus sample matching a metric name and all of the given label
# fragments. Labels are matched one at a time rather than as one substring
# because the exporter emits them in alphabetical order, so `{kind=...,channel=...}`
# never matches however obviously right it looks.
metric() { # $1 = peer dir, $2 = metric name, rest = label fragments, all required
  local dir="$1"; shift
  dd "$dir" metrics | node -e "
    const [name, ...labels] = process.argv.slice(1);
    let s='';
    process.stdin.on('data', (d) => (s += d)).on('end', () => {
      let total = 0;
      for (const line of s.split('\n')) {
        if (line.startsWith('#') || !line.startsWith(name)) continue;
        if (!labels.every((label) => line.includes(label))) continue;
        const value = Number(line.trim().split(/\s+/).pop());
        if (Number.isFinite(value)) total += value;
      }
      console.log(total);
    });
  " "$@"
}

# ------------------------------------------------------------------- peers

# peerId defaults to the machine's hostname, so two runtimes on one box would
# share a mailbox address and poll each other's mail, failing with
# DECODE_FAILED. Setting it explicitly is the one thing a same-machine test has
# to do that a two-machine test gets for free.
write_config() { # $1 = peer dir, $2 = peer id, $3 = transports body, $4 = exposures body, $5 = extra workspace keys
  mkdir -p "$1"
  # Built outside the heredoc on purpose. A `${env:...}` reference nested inside
  # a `${VAR:-default}` expansion has its closing brace eaten by the outer one,
  # which produced a config that was almost valid JSON and failed at load.
  local secrets="${SECRETS_BODY:-}"
  [ -n "$secrets" ] || secrets='"${env:DEADDROP_SECRET}"'
  local extra="${5:-}"
  [ -z "$extra" ] || extra="$extra,"
  cat > "$1/deaddrop.config.json" <<JSON
{
  "dataDir": "$1/.deaddrop",
  "logLevel": "${LOG_LEVEL:-info}",
  "workspaces": [
    {
      "name": "${WORKSPACE_NAME:-demo}",
      "peerId": "$2",
      "secrets": [$secrets],
      $extra
      "transports": [$3],
      "exposures": [${4:-}]
    }
  ]
}
JSON
}

# The default transport for the fast tier: one shared directory, polled often
# enough that a scenario does not spend its life waiting.
fs_transport() { # $1 = shared root
  printf '{ "use": "filesystem", "config": { "root": "%s", "pollIntervalMs": 300 } }' "$1"
}

git_transport() { # $1 = remote (a path is fine), $2 = work dir
  printf '{ "use": "git", "config": { "remote": "%s", "workDir": "%s", "freshnessMs": 500, "batchWindowMs": 50 } }' "$1" "$2"
}

# `exec` matters: without it the subshell forks node and `$!` is the subshell,
# so a later `kill` reaps the wrapper and leaves the runtime serving. An
# "offline peer" scenario then passes against a peer that never went offline.
start_peer() { # $1 = peer dir, $2 = log file; echoes the pid
  ( cd "$1" && exec $DDROP start --config "$1/deaddrop.config.json" ) > "$2" 2>&1 &
  local pid=$!
  track "$pid"
  echo "$pid"
}

# Polls until the runtime answers, and gives up the moment its process is gone.
# Without the liveness check a runtime that died on a bad config still burns the
# full timeout, which turns one broken scenario into a minute of waiting.
wait_up() { # $1 = peer dir, $2 = pid (optional)
  local i
  for i in $(seq "${UP_ATTEMPTS:-40}"); do
    $DDROP status --config "$1/deaddrop.config.json" >/dev/null 2>&1 && return 0
    if [ -n "${2:-}" ] && ! kill -0 "$2" 2>/dev/null; then
      note "the runtime exited before its control plane came up"
      return 1
    fi
    sleep 1
  done
  return 1
}

stop_peer() { # $1 = pid
  [ -n "$1" ] || return 0
  kill "$1" 2>/dev/null
  wait "$1" 2>/dev/null
  untrack "$1"
}

# A killed peer, not a stopped one. A laptop that closed its lid does not get to
# withdraw its presence beacon, and that is the state worth testing.
kill_peer() { # $1 = pid
  [ -n "$1" ] || return 0
  kill -9 "$1" 2>/dev/null
  wait "$1" 2>/dev/null
  untrack "$1"
}

# Where the runtime actually bound its control plane. Read from the log rather
# than derived, because deriving it here would reimplement the very fallback
# under test: past 104 bytes the socket moves to a hashed path under the temp
# directory, and an operator finds it the same way, by reading the log line.
socket_path() { # $1 = peer log
  grep -o '"socketPath":"[^"]*"' "$1" 2>/dev/null | tail -1 | cut -d'"' -f4
}

# True once something accepts TCP on the port. Deliberately not an HTTP request:
# a `connect` aimed at an unreachable peer accepts the connection and then sits
# on it until its own timeout, so probing with curl would wait for the failure
# it is supposed to be setting up.
port_accepts() { # $1 = port
  node -e '
    const socket = require("net").connect(Number(process.argv[1]), "127.0.0.1");
    socket.on("connect", () => { socket.destroy(); process.exit(0); });
    socket.on("error", () => process.exit(1));
    setTimeout(() => process.exit(1), 2000);
  ' "$1"
}

# Starts `ddrop connect` and waits for its local port to accept. Returns the pid
# on stdout; the caller stops it with stop_peer.
start_connect() { # $1 = peer dir, $2 = peer/exposure, $3 = port, $4 = log, $5 = timeout ms
  ( cd "$1" && exec $DDROP connect "$2" --port "$3" --timeout "${5:-60000}" \
      --config "$1/deaddrop.config.json" ) > "$4" 2>&1 &
  local pid=$!
  track "$pid"
  wait_for 30 1 port_accepts "$3"
  echo "$pid"
}

# HTTP status only, with the body written where a scenario can look at it.
http_code() { # $1 = url, $2 = body file, $3 = max seconds
  curl -s -o "${2:-/dev/null}" -w '%{http_code}' --max-time "${3:-30}" "$1" 2>/dev/null
}
