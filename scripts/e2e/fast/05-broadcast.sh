# One publisher, several subscribers, and one peer that is not listening.
#
# Everything else in the suite is request/response between two named peers.
# Broadcast is the other shape: a message addressed to a channel rather than a
# peer, written once and read by everyone subscribed to it. Nothing had ever
# driven it with more than two runtimes, and "three or more peers" has sat on
# the manual-testing list since the first walkthrough.
#
# Delivery is observed through `deaddrop_messages_received_total`, which carries
# the message kind and channel as labels. That is the only externally visible
# proof a runtime consumed an event: a subscription with no handler registered
# is silent by design.

BC="$WORK/broadcast"
SHARED="$BC/store"
mkdir -p "$SHARED"

events_received() { # $1 = peer dir
  metric "$1" deaddrop_messages_received_total 'kind="event"' 'channel="deploys"'
}

# Publishing is one object under the topic prefix, read by every subscriber, so
# the count of stored objects should not grow with the number of listeners.
topic_objects() { find "$SHARED" -type f -path "*topic/deploys*" 2>/dev/null | wc -l | tr -d ' '; }

subscribers_all_received() {
  local i
  for i in $(seq 30); do
    [ "$(events_received "$BC/b")" -ge 1 ] \
      && [ "$(events_received "$BC/c")" -ge 1 ] \
      && [ "$(events_received "$BC/d")" -ge 1 ] && return 0
    sleep 1
  done
  return 1
}

# The publisher subscribes too, so a scenario asserting fan-out is not quietly
# asserting "the sender kept a copy".
write_config "$BC/a" "peer-a" "$(fs_transport "$SHARED")" "" '"subscribe": ["deploys"]'
write_config "$BC/b" "peer-b" "$(fs_transport "$SHARED")" "" '"subscribe": ["deploys"]'
# Peer C also carries a channel nobody has published to yet. It is what makes
# the "missed while down" scenario below unambiguous: a receipt on `hotfix` can
# only have come from the message sent while C was dead, whereas a second
# receipt on `deploys` could just be C re-reading the first one.
write_config "$BC/c" "peer-c" "$(fs_transport "$SHARED")" "" '"subscribe": ["deploys", "hotfix"]'
write_config "$BC/d" "peer-d" "$(fs_transport "$SHARED")" "" '"subscribe": ["deploys"]'
# Peer E is in the workspace and holds the same secret. It just never subscribed.
write_config "$BC/e" "peer-e" "$(fs_transport "$SHARED")" "" '"subscribe": ["releases"]'

for peer in a b c d e; do
  eval "${peer}_pid=\$(start_peer '$BC/$peer' '$BC/$peer.log')"
done
for peer in a b c d e; do
  wait_up "$BC/$peer" >/dev/null
done

scenario "an announcement reaches every peer that asked for it"

before_e=$(events_received "$BC/e")

ON_FAIL="$BC/a.log"
can "publish an event to a channel rather than to a named peer" \
  quietly dd "$BC/a" publish deploys --input '{"version":"1.2.3"}'
ON_FAIL=""

ON_FAIL="$BC/b.log $BC/c.log $BC/d.log"
can "have one published event delivered to all three subscribers" \
  subscribers_all_received
ON_FAIL=""
note "received counts: b=$(events_received "$BC/b") c=$(events_received "$BC/c") d=$(events_received "$BC/d")"

stored=$(topic_objects)
cannot "make the publisher pay per subscriber: the event is stored once ($stored object), not once per listener" \
  [ "$stored" -le 2 ]

# Subscription is the contract. A peer in the same workspace, holding the same
# secret, listening to a different channel, must not be handed this message.
sleep 5
after_e=$(events_received "$BC/e")
cannot "receive a channel you never subscribed to (peer E stayed at $after_e)" \
  [ "$after_e" = "$before_e" ]

scenario "a subscriber that was not running when the announcement went out"

# Broadcast messages are not deleted on consumption: they belong to every
# subscriber, and a cursor rather than a delete is what stops redelivery. So a
# peer that was down has to be able to pick one up afterwards, up to the
# retention window.
kill_peer "$c_pid"
sleep 2

quietly dd "$BC/a" publish hotfix --input '{"version":"1.2.4"}'
sleep 4

c_pid=$(start_peer "$BC/c" "$BC/c2.log")
wait_up "$BC/c" "$c_pid" >/dev/null

restarted_saw_it() {
  local i
  for i in $(seq 30); do
    [ "$(metric "$BC/c" deaddrop_messages_received_total 'kind="event"' 'channel="hotfix"')" -ge 1 ] \
      && return 0
    sleep 1
  done
  return 1
}

ON_FAIL="$BC/c2.log"
can "start a peer after the fact and still receive the announcement it missed" \
  restarted_saw_it
ON_FAIL=""

# The other side of a cursor: a subscriber that stayed up must not be handed the
# same event twice just because another peer re-read the topic.
b_count=$(events_received "$BC/b")
sleep 4
cannot "be redelivered an event you already consumed (peer B held at $b_count)" \
  [ "$(events_received "$BC/b")" = "$b_count" ]

for peer in a b c d e; do
  eval "stop_peer \"\$${peer}_pid\""
done
