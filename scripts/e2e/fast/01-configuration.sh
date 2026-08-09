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
