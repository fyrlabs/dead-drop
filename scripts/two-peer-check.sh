#!/usr/bin/env bash
# Two peers exchanging real traffic, on one machine.
#
# You do not need a second laptop. A "peer" is a runtime with its own data
# directory and peer id; what makes two runtimes peers is sharing one transport,
# not sitting on different hardware. This starts two of them over a single
# shared filesystem transport, then serves an HTTP exposure from peer A and
# fetches it through peer B. Every layer is exercised for real: envelope
# encryption, chunking, the filesystem transport, the mailbox engine, discovery
# and the control plane.
#
# The same shape works over the git transport by pointing both peers at one
# repository, which is the closest you get to a true cross-machine test without
# a second machine.
#
# Usage:
#   scripts/two-peer-check.sh              # against the built tree in this repo
#   scripts/two-peer-check.sh 0.2.2        # against that version from npm

set -uo pipefail
export PATH="$HOME/.nvm/versions/node/v26.7.0/bin:$PATH"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FROM_NPM="${1:-}"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/ddrop-2peer-XXXXXX")
PASS=0; FAIL=0
A_PID=""; B_PID=""; EXPOSE_PID=""; CONNECT_PID=""

ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

cleanup() {
  for pid in "$CONNECT_PID" "$EXPOSE_PID" "$A_PID" "$B_PID"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
  sleep 1
  rm -rf "$WORK"
}
trap cleanup EXIT

if [ -n "$FROM_NPM" ]; then
  echo "testing @fyrlabs/dead-drop@$FROM_NPM from the registry"
  cd "$WORK" && npm init -y >/dev/null 2>&1
  npm install "@fyrlabs/dead-drop@$FROM_NPM" >/dev/null 2>&1 || { echo "install failed"; exit 1; }
  DDROP="$WORK/node_modules/.bin/ddrop"
else
  echo "testing the built tree at $REPO_ROOT"
  DDROP="node $REPO_ROOT/packages/dead-drop/dist/cli/bin.js"
fi

# One secret, one workspace name, one shared transport directory. That is the
# whole definition of "same workspace" -- the rest is per-peer local state.
SHARED="$WORK/shared-store"
mkdir -p "$SHARED"
SECRET=$($DDROP keygen 2>/dev/null | grep '^ddk1_')
[ -n "$SECRET" ] && ok "generated a workspace secret" || { bad "keygen"; exit 1; }
export DEADDROP_SECRET="$SECRET"

# peerId defaults to the machine's hostname, so two runtimes on one box would
# share a mailbox address and poll each other's mail. Set it explicitly. This is
# the one thing a same-machine test must do that a two-machine test gets free.
write_config() { # $1 = peer dir, $2 = peer id
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
      "transports": [
        { "use": "filesystem", "config": { "root": "$SHARED", "pollIntervalMs": 300 } }
      ],
      "exposures": []
    }
  ]
}
JSON
}

write_config "$WORK/peerA" "peer-a"
write_config "$WORK/peerB" "peer-b"
ok "wrote two configs sharing one filesystem transport, with distinct peer ids"

start_peer() { # $1 = peer dir, $2 = log
  ( cd "$1" && $DDROP start --config "$1/deaddrop.config.json" ) > "$2" 2>&1 &
  echo $!
}

A_PID=$(start_peer "$WORK/peerA" "$WORK/a.log")
B_PID=$(start_peer "$WORK/peerB" "$WORK/b.log")

wait_up() { # $1 = peer dir
  for _ in $(seq 40); do
    sleep 1
    $DDROP status --config "$1/deaddrop.config.json" >/dev/null 2>&1 && return 0
  done
  return 1
}

wait_up "$WORK/peerA" && ok "peer A is up" || { bad "peer A never started"; tail -20 "$WORK/a.log"; exit 1; }
wait_up "$WORK/peerB" && ok "peer B is up" || { bad "peer B never started"; tail -20 "$WORK/b.log"; exit 1; }

A_ID=$($DDROP status --config "$WORK/peerA/deaddrop.config.json" --json 2>/dev/null \
       | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.workspaces?.[0]?.peerId??"")})')
B_ID=$($DDROP status --config "$WORK/peerB/deaddrop.config.json" --json 2>/dev/null \
       | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.workspaces?.[0]?.peerId??"")})')
echo "  peer A id: $A_ID"
echo "  peer B id: $B_ID"
[ -n "$A_ID" ] && [ -n "$B_ID" ] && ok "both peers have ids" || bad "could not read peer ids"

if [ "$A_ID" = "$B_ID" ]; then
  bad "both runtimes claim the SAME peer id -- they are not distinct peers"
else
  ok "peer ids are distinct"
fi

echo
echo "--- discovery (presence travels through the shared transport) ---"
found=0
for _ in $(seq 40); do
  sleep 1
  if $DDROP discover --config "$WORK/peerB/deaddrop.config.json" --json 2>/dev/null | grep -q "$A_ID"; then
    found=1; break
  fi
done
[ "$found" = 1 ] && ok "peer B discovered peer A" || bad "peer B never saw peer A"

found=0
for _ in $(seq 20); do
  sleep 1
  if $DDROP discover --config "$WORK/peerA/deaddrop.config.json" --json 2>/dev/null | grep -q "$B_ID"; then
    found=1; break
  fi
done
[ "$found" = 1 ] && ok "peer A discovered peer B" || bad "peer A never saw peer B"

echo
echo "--- request/response: expose from A, fetch through B ---"
STATIC="$WORK/site"; mkdir -p "$STATIC"
echo "hello-from-peer-a" > "$STATIC/index.txt"

( cd "$WORK/peerA" && $DDROP expose "$STATIC" --name files \
    --config "$WORK/peerA/deaddrop.config.json" ) > "$WORK/expose.log" 2>&1 &
EXPOSE_PID=$!
sleep 4

if $DDROP status --config "$WORK/peerA/deaddrop.config.json" --json 2>/dev/null | grep -q files; then
  ok "peer A is exposing 'files'"
else
  bad "exposure not visible on peer A"; tail -10 "$WORK/expose.log"
fi

# Ask the OS for a free port instead of hard-coding one, so a straggler from a
# previous run cannot make this look like a product failure.
PORT=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
( cd "$WORK/peerB" && $DDROP connect "$A_ID/files" --port "$PORT" \
    --config "$WORK/peerB/deaddrop.config.json" ) > "$WORK/connect.log" 2>&1 &
CONNECT_PID=$!
sleep 5

body=""
for _ in $(seq 20); do
  body=$(curl -s --max-time 5 "http://127.0.0.1:$PORT/index.txt" 2>/dev/null)
  [ -n "$body" ] && break
  sleep 1
done
kill "$CONNECT_PID" 2>/dev/null

if [ "$body" = "hello-from-peer-a" ]; then
  ok "peer B fetched peer A's file through the transport ('$body')"
else
  bad "expected 'hello-from-peer-a', got '${body:-<empty>}'"
  echo "  --- connect log ---"; tail -15 "$WORK/connect.log"
  echo "  --- expose log ---";  tail -10 "$WORK/expose.log"
fi

echo
echo "--- the transport really is the medium ---"
files=$(find "$SHARED" -type f | wc -l | tr -d ' ')
[ "$files" -gt 0 ] && ok "shared store holds $files objects" || bad "shared store is empty"
if find "$SHARED" -type f -exec grep -l "hello-from-peer-a" {} \; 2>/dev/null | grep -q .; then
  bad "PLAINTEXT payload on the transport -- invariant 9 broken"
else
  ok "payload is not readable on the transport (ciphertext, invariant 9)"
fi

# Contents and keys are different promises. This check only covered contents,
# so it passed while `ws/<workspace>/peers/<peer>.ddf` sat in the clear on a
# real GitHub repo. Keys being readable is deliberate (docs/security-model.md),
# so assert the documented shape rather than absence -- if keys ever stop
# carrying these names, the security model doc is what needs updating.
if find "$SHARED" -type f | grep -q "demo"; then
  ok "object keys carry the workspace name in clear text, as security-model.md documents"
else
  bad "object keys no longer match the documented layout; update docs/security-model.md"
fi
echo "  note: keys are readable by design; only frame contents are encrypted"

echo
echo "================================"
echo "  PASS: $PASS   FAIL: $FAIL"
echo "================================"
[ "$FAIL" -eq 0 ]
