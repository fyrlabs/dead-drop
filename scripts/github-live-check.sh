#!/usr/bin/env bash
# The live GitHub walkthrough, as a script instead of prose.
#
# Everything GitHub-specific is otherwise tested against a scripted fake `gh`
# and a local bare repo, so real auth, real latency, real rate limits and real
# large objects are unverified until something like this runs. The release
# checklist asks for it before every tag; it stayed undone across three
# releases because it lived in a document as a list of things to type.
#
# This is deliberately NOT part of `npm run verify`. It needs a GitHub account,
# it writes to a real repository, and it takes minutes rather than seconds.
#
# Usage:
#   scripts/github-live-check.sh <owner/repo>            # against the built tree
#   scripts/github-live-check.sh <owner/repo> 0.2.3      # against that npm version
#
# The repository must already exist and be one you do not mind writing to; the
# check pushes a `deaddrop-data` branch and leaves it there. A private throwaway
# repo is the intended target:
#
#   gh repo create <owner>/dead-drop-trial --private
#
# What it covers, beyond the round trip the two-peer check already proves over a
# filesystem: authentication failure, sustained load against the API rate limit,
# and a 30 MiB object through git.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${1:-}"
FROM_NPM="${2:-}"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/ddrop-gh-XXXXXX")
PASS=0; FAIL=0
A_PID=""; B_PID=""; CONNECT_PID=""; NOAUTH_PID=""

ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
note(){ echo "  ....  $1"; }

if [ -z "$REPO" ]; then
  echo "usage: scripts/github-live-check.sh <owner/repo> [npm-version]" >&2
  exit 2
fi

free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}
sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else sha256sum "$1" | cut -d' ' -f1; fi
}
# `jq` is not assumed; node is already a hard requirement here.
json_get() { # $1 = expression over the parsed document, reads stdin
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const v=($1);console.log(v===undefined||v===null?'':v)}catch{console.log('')}})"
}

# SIGTERM alone leaves runtimes behind when the kill lands while one is still
# starting up, so follow up with SIGKILL before removing anything.
cleanup() {
  local pids="$CONNECT_PID $NOAUTH_PID $A_PID $B_PID"
  for pid in $pids; do kill "$pid" 2>/dev/null; done
  sleep 2
  for pid in $pids; do kill -9 "$pid" 2>/dev/null; done
  # The runtimes are still committing into their clones when the kill lands, so
  # a single rm loses a race with git and reports "Directory not empty".
  for _ in 1 2 3; do
    sleep 2
    rm -rf "$WORK" 2>/dev/null && return
  done
  rm -rf "$WORK" 2>/dev/null
}
trap cleanup EXIT

echo "live GitHub check against $REPO"
echo "work dir: $WORK"

if [ -n "$FROM_NPM" ]; then
  echo "testing @fyrlabs/dead-drop@$FROM_NPM from the registry"
  ( cd "$WORK" && npm init -y >/dev/null 2>&1 && npm install "@fyrlabs/dead-drop@$FROM_NPM" >/dev/null 2>&1 ) \
    || { echo "install failed"; exit 1; }
  DDROP="$WORK/node_modules/.bin/ddrop"
else
  echo "testing the built tree at $REPO_ROOT"
  DDROP="node $REPO_ROOT/packages/dead-drop/dist/cli/bin.js"
fi

echo
echo "--- preflight ---"
gh auth status >/dev/null 2>&1 && ok "gh is authenticated" || { bad "gh is not authenticated; run 'gh auth login'"; exit 1; }
gh repo view "$REPO" --json nameWithOwner >/dev/null 2>&1 \
  && ok "repository $REPO is visible" || { bad "cannot see $REPO"; exit 1; }

RL_START=$(gh api rate_limit --jq '.resources.core.remaining' 2>/dev/null)
RL_LIMIT=$(gh api rate_limit --jq '.resources.core.limit' 2>/dev/null)
note "core rate limit at start: $RL_START of $RL_LIMIT remaining"

SECRET=$($DDROP keygen 2>/dev/null | grep '^ddk1_')
[ -n "$SECRET" ] && ok "generated a workspace secret" || { bad "keygen"; exit 1; }
export DEADDROP_SECRET="$SECRET"

STATIC="$WORK/site"; mkdir -p "$STATIC"
echo "hello-over-github" > "$STATIC/index.txt"

# Same trap as the filesystem check: peerId defaults to the hostname, so two
# runtimes on one machine would share a mailbox address. Separate workDirs are
# given here for clarity; the transport would otherwise sort it out itself by
# cloning the second runtime into `<workDir>.peers/`.
write_config() { # $1 = peer dir, $2 = peer id, $3 = exposures body
  mkdir -p "$1"
  cat > "$1/deaddrop.config.json" <<JSON
{
  "dataDir": "$1/.deaddrop",
  "logLevel": "info",
  "workspaces": [
    {
      "name": "demo",
      "peerId": "$2",
      "secrets": ["\${env:DEADDROP_SECRET}"],
      "polling": { "minIntervalMs": 3000, "maxIntervalMs": 15000 },
      "transports": [
        {
          "use": "github",
          "config": {
            "repo": "$REPO",
            "workDir": "$1/gh-work",
            "createIfMissing": false,
            "rateLimitIntervalMs": 5000
          }
        }
      ],
      "exposures": [${3:-}]
    }
  ]
}
JSON
}

write_config "$WORK/peerA" "peer-a" \
  "{ \"name\": \"site\", \"type\": \"static\", \"directory\": \"$STATIC\" }"
write_config "$WORK/peerB" "peer-b"
ok "wrote two configs sharing one GitHub repository"

# `exec` so $! is the runtime and not a subshell wrapper that `kill` would reap
# while leaving the runtime serving.
start_peer() { # $1 = peer dir, $2 = log
  ( cd "$1" && exec $DDROP start --config "$1/deaddrop.config.json" ) > "$2" 2>&1 &
  echo $!
}

A_PID=$(start_peer "$WORK/peerA" "$WORK/a.log")
B_PID=$(start_peer "$WORK/peerB" "$WORK/b.log")

wait_up() { # $1 = peer dir
  for _ in $(seq 60); do
    sleep 1
    $DDROP status --config "$1/deaddrop.config.json" >/dev/null 2>&1 && return 0
  done
  return 1
}
wait_up "$WORK/peerA" && ok "peer A is up" || { bad "peer A never started"; tail -20 "$WORK/a.log"; exit 1; }
wait_up "$WORK/peerB" && ok "peer B is up" || { bad "peer B never started"; tail -20 "$WORK/b.log"; exit 1; }

echo
echo "--- the transport resolves against real GitHub ---"
# The github transport resolves lazily, so `start` succeeding proves nothing.
# A health probe is what forces `gh auth status`, `gh repo view` and the clone.
health=""
for _ in $(seq 40); do
  health=$($DDROP transport health --config "$WORK/peerA/deaddrop.config.json" --json 2>/dev/null \
           | json_get "j.transports?.[0]?.status")
  [ "$health" = "healthy" ] || [ "$health" = "degraded" ] && break
  sleep 3
done
if [ "$health" = "healthy" ] || [ "$health" = "degraded" ]; then
  ok "peer A's github transport is $health"
else
  bad "peer A's github transport never became healthy (status: '${health:-<none>}')"
  tail -25 "$WORK/a.log"
fi

rl=$($DDROP transport health --config "$WORK/peerA/deaddrop.config.json" --json 2>/dev/null \
     | json_get "j.transports?.[0]?.rateLimitRemaining")
[ -n "$rl" ] && ok "the transport reports the API rate limit ($rl remaining)" \
  || bad "no rateLimitRemaining on the github transport"

echo
echo "--- discovery and a real round trip over GitHub ---"
found=0
for _ in $(seq 40); do
  sleep 3
  if $DDROP discover --config "$WORK/peerB/deaddrop.config.json" --json 2>/dev/null | grep -q "peer-a"; then
    found=1; break
  fi
done
[ "$found" = 1 ] && ok "peer B discovered peer A through the repository" || bad "peer B never saw peer A"

PORT=$(free_port)
( cd "$WORK/peerB" && exec $DDROP connect "peer-a/site" --port "$PORT" --timeout 300000 \
    --config "$WORK/peerB/deaddrop.config.json" ) > "$WORK/connect.log" 2>&1 &
CONNECT_PID=$!
sleep 8

start=$(date +%s)
body=$(curl -s --max-time 300 "http://127.0.0.1:$PORT/index.txt" 2>/dev/null)
rtt=$(( $(date +%s) - start ))
if [ "$body" = "hello-over-github" ]; then
  ok "peer B fetched peer A's file through GitHub in ${rtt}s"
else
  bad "round trip failed: got '${body:-<empty>}'"
  tail -20 "$WORK/connect.log"
fi

echo
echo "--- authentication failure ---"
# `gh auth logout` would take the session's own credentials with it: the token
# here lives in the OS keyring and comes from a browser login, so it cannot be
# put back without one. An empty GH_CONFIG_DIR produces the identical state --
# `gh auth status` reports "not logged into any GitHub hosts" -- for one process
# only, which is what the transport actually sees.
mkdir -p "$WORK/gh-empty"
if env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$WORK/gh-empty" gh auth status >/dev/null 2>&1; then
  bad "the isolated gh config is still authenticated; this check would prove nothing"
else
  ok "an isolated gh config is genuinely logged out"
fi

write_config "$WORK/peerC" "peer-c"
( cd "$WORK/peerC" && exec env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$WORK/gh-empty" \
    $DDROP start --config "$WORK/peerC/deaddrop.config.json" ) > "$WORK/c.log" 2>&1 &
NOAUTH_PID=$!
wait_up "$WORK/peerC" && ok "the runtime still starts with no GitHub credentials" \
  || bad "the runtime would not start at all without credentials"

status=""; message=""
for _ in $(seq 20); do
  out=$($DDROP transport health --config "$WORK/peerC/deaddrop.config.json" --json 2>/dev/null)
  status=$(printf '%s' "$out" | json_get "j.transports?.[0]?.status")
  message=$(printf '%s' "$out" | json_get "j.transports?.[0]?.message")
  [ -n "$status" ] && [ "$status" != "unknown" ] && break
  sleep 2
done
[ "$status" = "unavailable" ] && ok "the unauthenticated transport reports 'unavailable'" \
  || bad "expected 'unavailable' without credentials, got '${status:-<none>}'"

case "$message" in
  *"gh auth login"*) ok "the failure names the fix: '$message'" ;;
  *) bad "the failure does not say how to fix it: '${message:-<empty>}'" ;;
esac

# A transport that will never recover on its own has to reach the operator. A
# config typo used to leave a runtime silently dead because this logged at debug.
if grep -qi "error" "$WORK/c.log" && grep -qi "gh auth login" "$WORK/c.log"; then
  ok "the auth failure is logged at error level, not swallowed"
else
  bad "no error-level log names the auth failure"
  tail -20 "$WORK/c.log"
fi
kill "$NOAUTH_PID" 2>/dev/null; NOAUTH_PID=""

echo
echo "--- sustained load against the rate limit ---"
# Real exhaustion is not reachable: the core limit is 5000/hour, so it would
# take thousands of calls and leave the account throttled for an hour. What is
# reachable, and what actually matters, is whether the counter the transport
# scores itself on moves under load, and whether the transport survives the run.
RL_BEFORE=$(gh api rate_limit --jq '.resources.core.remaining' 2>/dev/null)
WAVES=5; PER_WAVE=10
requests=0; okays=0
for wave in $(seq "$WAVES"); do
  pids=""
  for i in $(seq "$PER_WAVE"); do
    curl -s --max-time 300 -o "$WORK/load-$wave-$i.txt" \
      "http://127.0.0.1:$PORT/index.txt" 2>/dev/null &
    pids="$pids $!"
  done
  for pid in $pids; do wait "$pid" 2>/dev/null; done
  for i in $(seq "$PER_WAVE"); do
    requests=$((requests+1))
    [ "$(cat "$WORK/load-$wave-$i.txt" 2>/dev/null)" = "hello-over-github" ] && okays=$((okays+1))
  done
  rl_now=$($DDROP transport health --config "$WORK/peerA/deaddrop.config.json" --json 2>/dev/null \
           | json_get "j.transports?.[0]?.rateLimitRemaining")
  note "wave $wave: $okays/$requests answered so far, rate limit remaining ${rl_now:-unknown}"
done

[ "$okays" = "$requests" ] && ok "all $requests requests under sustained load were answered" \
  || bad "only $okays of $requests requests were answered under load"

RL_AFTER=$(gh api rate_limit --jq '.resources.core.remaining' 2>/dev/null)
spent=$(( RL_BEFORE - RL_AFTER ))
# The hourly window can roll over mid-run, which refills the budget and makes
# the subtraction negative. That is not a measurement of anything; say so rather
# than reporting "spent -385".
if [ "$spent" -lt 0 ]; then
  note "the rate limit window reset mid-run (${RL_BEFORE} -> ${RL_AFTER}); spend not measurable this run"
  ok "sustained traffic did not exhaust the API budget"
else
  note "core API calls spent on $requests requests: $spent (${RL_BEFORE} -> ${RL_AFTER})"
  # Data movement is git, not the REST API, so the spend should be a handful of
  # polls rather than one call per request. If that ever stops being true, the
  # transport has started using the API for data and will exhaust the budget.
  if [ "$spent" -lt "$requests" ]; then
    ok "sustained traffic does not cost one API call per request ($spent for $requests)"
  else
    bad "the API budget is being spent per request ($spent for $requests)"
  fi
fi

health_after=$($DDROP transport health --config "$WORK/peerA/deaddrop.config.json" --json 2>/dev/null \
               | json_get "j.transports?.[0]?.status")
[ "$health_after" = "healthy" ] || [ "$health_after" = "degraded" ] \
  && ok "the transport is still $health_after after the load" \
  || bad "the transport is '$health_after' after the load"

echo
echo "--- a 30 MiB object through git ---"
BIG_BYTES=$((30 * 1024 * 1024))
head -c "$BIG_BYTES" /dev/urandom > "$STATIC/big.bin"

start=$(date +%s)
code=$(curl -s --max-time 900 -o "$WORK/big-out.bin" -w '%{http_code}' \
       "http://127.0.0.1:$PORT/big.bin" 2>/dev/null)
elapsed=$(( $(date +%s) - start ))
got=$(wc -c < "$WORK/big-out.bin" | tr -d ' ')
if [ "$code" = "200" ] && [ "$got" = "$BIG_BYTES" ]; then
  ok "30 MiB moved through a real GitHub repository in ${elapsed}s"
else
  bad "30 MiB transfer failed: http $code, $got of $BIG_BYTES bytes after ${elapsed}s"
  tail -25 "$WORK/connect.log"
  tail -25 "$WORK/a.log"
fi

if [ "$(sha256_of "$STATIC/big.bin")" = "$(sha256_of "$WORK/big-out.bin")" ]; then
  ok "the 30 MiB payload is byte-identical after the round trip"
else
  bad "the 30 MiB payload came back corrupted"
fi

kill "$CONNECT_PID" 2>/dev/null; CONNECT_PID=""

RL_END=$(gh api rate_limit --jq '.resources.core.remaining' 2>/dev/null)
note "core rate limit at end: $RL_END of $RL_LIMIT (spent $(( RL_START - RL_END )) overall)"
note "the repository keeps its deaddrop-data branch; delete the repo when done"

echo
echo "================================"
echo "  PASS: $PASS   FAIL: $FAIL"
echo "================================"
[ "$FAIL" -eq 0 ]
