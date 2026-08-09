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
# It then kills peer A, sends a request into the store while nothing is
# listening, and checks the answer arrives once A comes back; and moves a 30 MiB
# payload end to end, plus a 33 MiB one that must be refused at the 32 MiB cap.
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
A_PID=""; B_PID=""; EXPOSE_PID=""; CONNECT_PID=""; CURL_PID=""

ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

# Ask the OS for a free port instead of hard-coding one, so a straggler from a
# previous run cannot make this look like a product failure.
free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}

# macOS ships shasum, most Linux images ship sha256sum. Neither is guaranteed.
sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else sha256sum "$1" | cut -d' ' -f1; fi
}

cleanup() {
  for pid in "$CURL_PID" "$CONNECT_PID" "$EXPOSE_PID" "$A_PID" "$B_PID"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
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

# The directory peer A serves. It is created before the configs because peer A
# declares a static exposure over it in config rather than through `ddrop
# expose`: a config exposure is registered during workspace start, so a request
# already sitting in the inbox cannot arrive before its handler exists. The
# `ddrop expose` path is still exercised separately below.
STATIC="$WORK/site"; mkdir -p "$STATIC"
echo "hello-from-peer-a" > "$STATIC/index.txt"

# peerId defaults to the machine's hostname, so two runtimes on one box would
# share a mailbox address and poll each other's mail. Set it explicitly. This is
# the one thing a same-machine test must do that a two-machine test gets free.
write_config() { # $1 = peer dir, $2 = peer id, $3 = exposures array body (optional)
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
      "exposures": [${3:-}]
    }
  ]
}
JSON
}

write_config "$WORK/peerA" "peer-a" \
  "{ \"name\": \"site\", \"type\": \"static\", \"directory\": \"$STATIC\" }"
write_config "$WORK/peerB" "peer-b"
ok "wrote two configs sharing one filesystem transport, with distinct peer ids"

# `exec` matters: without it the subshell forks node and `$!` is the subshell,
# so a later `kill` reaps the wrapper and leaves the runtime running. The offline
# check below then silently tests nothing, because the peer it "killed" is still
# answering.
start_peer() { # $1 = peer dir, $2 = log
  ( cd "$1" && exec $DDROP start --config "$1/deaddrop.config.json" ) > "$2" 2>&1 &
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
( cd "$WORK/peerA" && exec $DDROP expose "$STATIC" --name files \
    --config "$WORK/peerA/deaddrop.config.json" ) > "$WORK/expose.log" 2>&1 &
EXPOSE_PID=$!
sleep 4

if $DDROP status --config "$WORK/peerA/deaddrop.config.json" --json 2>/dev/null | grep -q files; then
  ok "peer A is exposing 'files'"
else
  bad "exposure not visible on peer A"; tail -10 "$WORK/expose.log"
fi

PORT=$(free_port)
( cd "$WORK/peerB" && exec $DDROP connect "$A_ID/files" --port "$PORT" \
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
echo "--- offline peer redelivery: A is down when the request is sent ---"

# Kill peer A outright instead of stopping it politely. A laptop that closed its
# lid does not get to withdraw its presence beacon, and the property under test
# is that a request survives in the store until the peer comes back.
kill -9 "$A_PID" 2>/dev/null
wait "$A_PID" 2>/dev/null
A_PID=""
sleep 2
if $DDROP status --config "$WORK/peerA/deaddrop.config.json" >/dev/null 2>&1; then
  bad "peer A still answers after being killed"
else
  ok "peer A is offline"
fi

PORT=$(free_port)
( cd "$WORK/peerB" && exec $DDROP connect "$A_ID/site" --port "$PORT" --timeout 120000 \
    --config "$WORK/peerB/deaddrop.config.json" ) > "$WORK/offline-connect.log" 2>&1 &
CONNECT_PID=$!
sleep 6

# Fire the request with nobody listening. curl blocks; the envelope goes into
# A's inbox on the shared store and stays there until A polls it.
curl -s --max-time 150 "http://127.0.0.1:$PORT/index.txt" > "$WORK/offline-body.txt" 2>/dev/null &
CURL_PID=$!
sleep 6

queued=$(find "$SHARED" -type f -path "*inbox/$A_ID/*" 2>/dev/null | wc -l | tr -d ' ')
if [ "$queued" -gt 0 ]; then
  ok "the request is queued in peer A's inbox while A is offline ($queued objects)"
else
  bad "nothing queued for peer A -- the request never reached the transport"
fi

A_PID=$(start_peer "$WORK/peerA" "$WORK/a2.log")
if wait_up "$WORK/peerA"; then
  ok "peer A came back up after being killed"
else
  bad "peer A did not restart"; tail -20 "$WORK/a2.log"
fi

wait "$CURL_PID" 2>/dev/null
body=$(cat "$WORK/offline-body.txt" 2>/dev/null)
kill "$CONNECT_PID" 2>/dev/null; CONNECT_PID=""
if [ "$body" = "hello-from-peer-a" ]; then
  ok "the request queued while A was offline was answered once A returned"
else
  bad "offline redelivery failed: expected 'hello-from-peer-a', got '${body:-<empty>}'"
  echo "  --- connect log ---";        tail -20 "$WORK/offline-connect.log"
  echo "  --- peer A restart log ---"; tail -20 "$WORK/a2.log"
fi

echo
echo "--- large payloads, and the 32 MiB cap ---"
BIG_BYTES=$((30 * 1024 * 1024))
OVER_BYTES=$((33 * 1024 * 1024))
head -c "$BIG_BYTES"  /dev/urandom > "$STATIC/big.bin"
head -c "$OVER_BYTES" /dev/urandom > "$STATIC/over.bin"

PORT=$(free_port)
( cd "$WORK/peerB" && exec $DDROP connect "$A_ID/site" --port "$PORT" --timeout 300000 \
    --config "$WORK/peerB/deaddrop.config.json" ) > "$WORK/big-connect.log" 2>&1 &
CONNECT_PID=$!
sleep 6

start=$(date +%s)
code=$(curl -s --max-time 300 -o "$WORK/big-out.bin" -w '%{http_code}' \
       "http://127.0.0.1:$PORT/big.bin" 2>/dev/null)
elapsed=$(( $(date +%s) - start ))
got_bytes=$(wc -c < "$WORK/big-out.bin" | tr -d ' ')
if [ "$code" = "200" ] && [ "$got_bytes" = "$BIG_BYTES" ]; then
  ok "30 MiB payload arrived whole through the transport in ${elapsed}s"
else
  bad "30 MiB payload: http $code, $got_bytes of $BIG_BYTES bytes"
  tail -15 "$WORK/big-connect.log"
fi

if [ "$(sha256_of "$STATIC/big.bin")" = "$(sha256_of "$WORK/big-out.bin")" ]; then
  ok "30 MiB payload is byte-identical after encrypt, transport and decrypt"
else
  bad "30 MiB payload came back corrupted"
fi

# Over the cap the exposure must refuse cheaply and legibly, not stall until the
# caller's timeout and not ship 33 MiB before noticing.
code=$(curl -s --max-time 300 -o "$WORK/over-out.txt" -w '%{http_code}' \
       "http://127.0.0.1:$PORT/over.bin" 2>/dev/null)
over_body=$(cat "$WORK/over-out.txt" 2>/dev/null)
if [ "$code" = "413" ]; then
  ok "33 MiB file is refused with 413, not truncated or hung"
else
  bad "expected 413 over the 32 MiB cap, got http $code"
fi
if [ "$over_body" = "File is too large to serve." ]; then
  ok "the refusal says why: '$over_body'"
else
  bad "413 body does not name the cause: '${over_body:-<empty>}'"
fi
kill "$CONNECT_PID" 2>/dev/null; CONNECT_PID=""

echo
echo "================================"
echo "  PASS: $PASS   FAIL: $FAIL"
echo "================================"
[ "$FAIL" -eq 0 ]
