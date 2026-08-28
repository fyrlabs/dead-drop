# Streamed response bodies, over a real transport rather than a stub.
#
# The unit suites drive the sender and the receiver against fakes, which proves
# the parts and the reordering but not that a body actually crosses a transport
# incrementally. This is the difference: a response that never ends, one that is
# too big to hold, and a caller that walks away mid-stream.
#
# Incrementality is proved by deadlock rather than by timing. The target sends
# its first event and then refuses to send the second until the client has
# created a file, and the client only creates that file once it has read the
# first event. If the body were buffered the two would wait on each other, so a
# pass means the first event genuinely arrived before the last was produced. The
# control is the same request through an exposure that was not told to stream,
# which deadlocks exactly as predicted and times out. A stopwatch would have
# measured the same thing and flaked on a slow host, which this suite has done.

ST="$WORK/streaming"
SHARED="$ST/store"
mkdir -p "$SHARED" "$ST"

GO="$ST/go"
CLOSED="$ST/target-closed"
BIG_BYTES=$((4 * 1024 * 1024))

# The local server being exposed. It is never told dead-drop exists.
#
#   /sse    two events, the second gated on $GO appearing
#   /big    a body with no content-length, written in chunks
#   /small  an ordinary short body
#
# `/sse` records its own connection close, which is how the cancellation test
# sees that a caller walking away reached all the way back to the target.
TARGET_PORT=$(free_port)
node -e '
  const fs = require("fs");
  const [port, go, closed, bigBytes] = process.argv.slice(1);
  const chunk = Buffer.alloc(64 * 1024, "x");
  require("http").createServer((request, response) => {
    if (request.url === "/sse") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      response.on("close", () => fs.appendFileSync(closed, "closed\n"));
      const waiting = setInterval(() => {
        if (!fs.existsSync(go)) return;
        clearInterval(waiting);
        response.write("data: second\n\n");
        response.end();
      }, 100);
      return;
    }
    if (request.url === "/big") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      let written = 0;
      const total = Number(bigBytes);
      while (written < total) {
        response.write(chunk);
        written += chunk.length;
      }
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("buffered body");
  }).listen(Number(port), "127.0.0.1");
' "$TARGET_PORT" "$GO" "$CLOSED" "$BIG_BYTES" &
TARGET_PID=$!
track "$TARGET_PID"
disown "$TARGET_PID" 2>/dev/null
wait_for 15 1 port_accepts "$TARGET_PORT"

# Reads a stream, and only once the first event is in hand does it release the
# second. A buffered body can never satisfy both halves of that.
gated_read() { # $1 = url, $2 = where to write what arrived
  deadline 45 node -e '
    const [url, go, out] = process.argv.slice(1);
    const fs = require("fs");
    const seen = [];
    fetch(url).then(async (response) => {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        seen.push(text);
        // Proof of incrementality: this only runs if the first event was
        // delivered while the target was still holding the second one back.
        if (text.includes("first") && !fs.existsSync(go)) fs.writeFileSync(go, "go");
      }
      fs.writeFileSync(out, seen.join(""));
    });
  ' "$1" "$GO" "$2" >/dev/null 2>&1
}

# Three exposures over one target. `live` may stream; `whole` is the default
# everyone already has; `strict` is `whole` with a short timeout, so the control
# below fails in five seconds rather than thirty.
write_config "$ST/b" "peer-b" "$(fs_transport "$SHARED")"
write_config "$ST/a" "peer-a" "$(fs_transport "$SHARED")" "
  { \"name\": \"live\", \"type\": \"http\", \"target\": \"http://127.0.0.1:$TARGET_PORT\",
    \"streaming\": { \"enabled\": true, \"thresholdBytes\": 65536 } },
  { \"name\": \"whole\", \"type\": \"http\", \"target\": \"http://127.0.0.1:$TARGET_PORT\" },
  { \"name\": \"strict\", \"type\": \"http\", \"target\": \"http://127.0.0.1:$TARGET_PORT\",
    \"timeoutMs\": 5000 }"
A_PID=$(start_peer "$ST/a" "$ST/a.log")
wait_up "$ST/a" "$A_PID" >/dev/null

LIVE_PORT=$(free_port)
LIVE_PID=$(start_connect "$ST/b" "peer-a/live" "$LIVE_PORT" "$ST/live.log" 60000)

scenario "a response that arrives while it is still being produced"

rm -f "$GO"
gated_read "http://127.0.0.1:$LIVE_PORT/sse" "$ST/sse-body.txt"
sse_body=$(cat "$ST/sse-body.txt" 2>/dev/null)

ON_FAIL="$ST/live.log $ST/a.log"
can "read the first event before the target has produced the last one" \
  [ -f "$GO" ]

can "receive every event of a stream that was gated on the reader" \
  [ "$sse_body" = "$(printf 'data: first\n\ndata: second\n\n')" ]

can "answer an ordinary short request through the same exposure, unchanged" \
  [ "$(curl -s --max-time 45 "http://127.0.0.1:$LIVE_PORT/small" 2>/dev/null)" = "buffered body" ]
ON_FAIL=""

# The control. Same target, same gated stream, an exposure that was not told to
# stream: it buffers, so it waits for an end the target will not send until it
# is read, and the two deadlock until the exposure gives up. This is what makes
# the three assertions above mean something.
STRICT_PORT=$(free_port)
STRICT_PID=$(start_connect "$ST/b" "peer-a/strict" "$STRICT_PORT" "$ST/strict.log" 60000)
rm -f "$GO"
strict_code=$(http_code "http://127.0.0.1:$STRICT_PORT/sse" "$ST/strict-body.txt" 60)
note "with streaming off the same request came back http $strict_code"

ON_FAIL="$ST/strict.log $ST/a.log"
cannot "deliver a gated event stream through an exposure that was not told to stream" \
  [ "$strict_code" = "504" ]
ON_FAIL=""
stop_peer "$STRICT_PID"

scenario "a body too large to hold whole on either side"

curl -s --max-time 90 -D "$ST/big-headers.txt" -o "$ST/big-body.bin" \
  "http://127.0.0.1:$LIVE_PORT/big" 2>/dev/null
big_size=$(wc -c < "$ST/big-body.bin" 2>/dev/null | tr -d ' ')

WHOLE_PORT=$(free_port)
WHOLE_PID=$(start_connect "$ST/b" "peer-a/whole" "$WHOLE_PORT" "$ST/whole.log" 60000)
curl -s --max-time 90 -o "$ST/whole-body.bin" "http://127.0.0.1:$WHOLE_PORT/big" 2>/dev/null
whole_size=$(wc -c < "$ST/whole-body.bin" 2>/dev/null | tr -d ' ')

ON_FAIL="$ST/live.log $ST/a.log"
can "carry a body of $BIG_BYTES bytes across the transport intact" \
  [ "$big_size" = "$BIG_BYTES" ]

can "deliver it chunked, forwarding each part as it arrives" \
  grep -qi 'transfer-encoding: chunked' "$ST/big-headers.txt"

# Streaming must not change what comes out, only when. Same bytes, both ways.
can "return byte-for-byte the same body through an exposure that buffers it" \
  cmp -s "$ST/big-body.bin" "$ST/whole-body.bin"

cannot "declare a content-length for a body it never held whole" \
  not grep -qi '^content-length:' "$ST/big-headers.txt"
ON_FAIL=""
stop_peer "$WHOLE_PID"

scenario "a caller that walks away mid-stream"

rm -f "$GO" "$CLOSED"
# Reads one event and hangs up, leaving the target still holding the second.
curl -s --max-time 5 --max-filesize 1 "http://127.0.0.1:$LIVE_PORT/sse" >/dev/null 2>&1 || true

ON_FAIL="$ST/live.log $ST/a.log"
# The whole chain has to unwind: the local client hangs up, connect tells the
# exposure to stop, and the exposure releases the target. Without that last hop
# the target keeps producing for a reader that left, one transport write each.
cannot "be left producing a body for a caller that has gone" \
  wait_for 45 1 test -s "$CLOSED"

# Abandoning a stream is an ordinary event, not damage.
can "keep the runtime and its transport healthy after a stream is abandoned" \
  [ "$(dd_json "$ST/a" 'j.transports?.[0]?.status' transport health)" = "healthy" ]
ON_FAIL=""

stop_peer "$LIVE_PID"
stop_peer "$A_PID"
kill -9 "$TARGET_PID" 2>/dev/null
untrack "$TARGET_PID"
