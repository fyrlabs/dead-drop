# Configuration: what a user can express, and what they are stopped from
# expressing. No runtime survives this file; every check is a start that either
# succeeds or refuses with a reason.
#
# This exists because a config mistake used to produce a silently dead runtime.
# `start` returned success, the transport resolved lazily and failed later, and
# the actionable error reached no log. The property under test is not "bad input
# is rejected" but "bad input is rejected out loud, before anything looks alive".

scenario "configuration is checked before a runtime claims to be running"

CFG="$WORK/config"
mkdir -p "$CFG"

# `ddrop init` is the documented first command. If what it writes does not start,
# the quick start is broken no matter what the tests say.
( cd "$CFG" && $DDROP init --name probe >/dev/null 2>&1 )
init_name=$(json_get 'j.workspaces[0].name' < "$CFG/deaddrop.config.json" 2>/dev/null)
can "start from \`ddrop init\`, which writes a parseable config for the named workspace" \
  [ "$init_name" = "probe" ]

# The two failures that made the documented first afternoon impossible, and
# which the check above could not see because it only read the file back.
#
# 1. `init` used to reference an environment variable it did not set, so the
#    very next command failed on a config it had just written itself.
# 2. It used to default the shared location to a folder under the local data
#    directory, so two people each got a runtime that started cleanly and could
#    never see the other. There is no error to assert for that: it is silence.
#
# So the shared location is now a placeholder that refuses to start, and the
# assertions are one of each kind: unedited must fail with the field named,
# and `--root` must produce something that runs with nothing else to do.
INIT_RUN="$WORK/init-run"
mkdir -p "$INIT_RUN/unedited" "$INIT_RUN/ready" "$INIT_RUN/shared"
( cd "$INIT_RUN/unedited" && $DDROP init --name probe >/dev/null 2>&1 )
( cd "$INIT_RUN/ready" && $DDROP init --name probe --peer ready-peer --root ../shared >/dev/null 2>&1 )

unedited_err=$( cd "$INIT_RUN/unedited" && $DDROP status 2>&1 )
cannot "start a config whose shared location was never chosen, without being told which field" \
  grep -q 'root is still the placeholder' <<<"$unedited_err"

# No secret is exported anywhere in this scenario. That is the point: `init`
# generates one beside the config, so nothing stands between it and `start`.
READY_PID=$(start_peer "$INIT_RUN/ready" "$INIT_RUN/ready.log")
ON_FAIL="$INIT_RUN/ready.log"
can "start straight from \`ddrop init --root\`, with no secret to export first" \
  wait_up "$INIT_RUN/ready" "$READY_PID"
ON_FAIL=""
stop_peer "$READY_PID"

secret=$($DDROP keygen 2>/dev/null | grep -c '^ddk1_')
can "\`ddrop keygen\` mints a workspace secret in the documented format" \
  [ "$secret" = "1" ]

# Each of these is a real mistake someone makes on their first afternoon. The
# assertion is on the message, not just the exit code: an exit code tells you
# something is wrong, and the message is what tells you what to change.
refuses() { # $1 = json body, $2 = phrase the error must contain
  local file="$CFG/bad.json"
  printf '%s' "$1" > "$file"
  local output
  output=$(deadline 20 $DDROP start --config "$file" 2>&1)
  case "$output" in
    *"$2"*) return 0 ;;
    *) note "expected an error naming '$2', got: ${output:-<silence>}"; return 1 ;;
  esac
}

cannot "start a runtime whose config references an environment variable that is unset" \
  refuses '{"dataDir":"'"$CFG"'/d","logLevel":"info","workspaces":[{"name":"demo","peerId":"a","secrets":["${env:DEADDROP_ABSENT}"],"transports":[{"use":"filesystem","config":{"root":"'"$CFG"'/s"}}]}]}' \
  'unset environment variable DEADDROP_ABSENT'

cannot "start a runtime with no workspace secret" \
  refuses '{"dataDir":"'"$CFG"'/d","logLevel":"info","workspaces":[{"name":"demo","peerId":"a","secrets":[],"transports":[{"use":"filesystem","config":{"root":"'"$CFG"'/s"}}]}]}' \
  'at least one secret is required'

cannot "start a runtime with a secret that is not a workspace key" \
  refuses '{"dataDir":"'"$CFG"'/d","logLevel":"info","workspaces":[{"name":"demo","peerId":"a","secrets":["hunter2"],"transports":[{"use":"filesystem","config":{"root":"'"$CFG"'/s"}}]}]}' \
  'must start with "ddk1_"'

# The transport name is the one field a typo hides in: it is resolved by module
# specifier, so a wrong one looks like a missing dependency rather than a typo.
cannot "start a runtime naming a transport that is not installed" \
  refuses '{"dataDir":"'"$CFG"'/d","logLevel":"info","workspaces":[{"name":"demo","peerId":"a","secrets":["'"$DEADDROP_SECRET"'"],"transports":[{"use":"not-a-real-transport"}]}]}' \
  'cannot load transport'

cannot "start a runtime with a transport that is missing its own required config" \
  refuses '{"dataDir":"'"$CFG"'/d","logLevel":"info","workspaces":[{"name":"demo","peerId":"a","secrets":["'"$DEADDROP_SECRET"'"],"transports":[{"use":"filesystem","config":{}}]}]}' \
  'filesystem transport requires "root"'

missing_config_is_named() {
  local output
  output=$(deadline 20 $DDROP status --config "$CFG/absent.json" 2>&1)
  case "$output" in
    *'cannot read config file'*) return 0 ;;
    *) note "expected 'cannot read config file', got: ${output:-<silence>}"; return 1 ;;
  esac
}
cannot "run a client command against a config file that does not exist" \
  missing_config_is_named
