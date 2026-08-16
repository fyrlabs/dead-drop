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

# Joining, which is how the second machine in a workspace is meant to start.
#
# Reading the two secret files back and comparing them is not enough on its own.
# The failure this replaces is two peers that each generated their own secret:
# both configs look right, both runtimes start clean, and they never see each
# other. So the assertion that matters is the discovery one below, and the file
# comparison is only there to say why when it fails.
JOIN="$WORK/join"
mkdir -p "$JOIN/a" "$JOIN/b" "$JOIN/shared"
( cd "$JOIN/a" && $DDROP init --name joined --peer join-a --root ../shared >/dev/null 2>&1 )
( cd "$JOIN/b" && $DDROP init --name joined --peer join-b --root ../shared \
    --secret - < "$JOIN/a/.deaddrop/secret" >/dev/null 2>&1 )

joined_on_one_secret() {
  [ "$(cat "$JOIN/a/.deaddrop/secret")" = "$(cat "$JOIN/b/.deaddrop/secret")" ]
}
can "join a workspace with \`--secret -\`, with no secret file copied into place" \
  joined_on_one_secret

JOIN_A_PID=$(start_peer "$JOIN/a" "$JOIN/a.log")
JOIN_B_PID=$(start_peer "$JOIN/b" "$JOIN/b.log")
ON_FAIL="$JOIN/b.log"
joined_peers_find_each_other() {
  wait_up "$JOIN/a" "$JOIN_A_PID" || return 1
  wait_up "$JOIN/b" "$JOIN_B_PID" || return 1
  wait_for 40 1 eval 'dd "$JOIN/b" discover --json | grep -q join-a'
}
can "reach the peer it joined, which is what a matching secret actually buys" \
  joined_peers_find_each_other
ON_FAIL=""
stop_peer "$JOIN_A_PID"
stop_peer "$JOIN_B_PID"

# A mistyped secret has to fail here, at the one moment the user is looking at
# it. Accepted, it derives a different key and surfaces much later as a decode
# failure against a peer's first message, which names nothing.
mkdir -p "$JOIN/typo"
typo_err=$( cd "$JOIN/typo" && $DDROP init --name joined --root ../shared --secret ddk1_short 2>&1 )
cannot "join with a secret that is not a workspace key, or be told so only later" \
  grep -q '32 bytes' <<< "$typo_err"

mkdir -p "$JOIN/both"
both_err=$( cd "$JOIN/both" && $DDROP init --name joined --root ../shared --github a/b 2>&1 )
cannot "name two transports at once and have one of them silently win" \
  grep -q 'two different transports' <<< "$both_err"

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

# DEADDROP_PEER_ID, which was the one documented setting with no coverage of any
# kind: no unit test named it, no scenario set it, and the coverage report marked
# the line that reads it as never executed.
#
# It was also wrong. `ddrop init` chose the peer id from the hostname alone and
# never looked at the variable, and the field `init` writes wins over the
# variable -- so exporting it and then running `init`, which is the order anyone
# would do it in, produced a config carrying the hostname and a variable that
# could never take effect again. The docs said it overrides this machine's id.
#
# The assertions go through `discover` rather than reading back a reported
# string, because a peer id is a mailbox address: a build that announced one
# name while answering on another would pass every assertion made about its own
# output, and pass no assertion made from the other side.
ENVID="$WORK/envid"
mkdir -p "$ENVID/shared"

mkdir -p "$ENVID/init"
( cd "$ENVID/init" && DEADDROP_PEER_ID=env-written $DDROP init --name envid --root ../shared >/dev/null 2>&1 )
envid_written=$(json_get 'j.workspaces[0].peerId' < "$ENVID/init/deaddrop.config.json" 2>/dev/null)
can "export DEADDROP_PEER_ID and have \`ddrop init\` write that id rather than the hostname" \
  [ "$envid_written" = "env-written" ]

# The two configs differ in exactly one line, which is the whole scenario: the
# first omits `peerId` and takes the variable, the second states it and must
# ignore the variable it is started with.
envid_config() { # $1 = peer dir, $2 = peerId line, empty to omit it
  mkdir -p "$1"
  cat > "$1/deaddrop.config.json" <<JSON
{
  "dataDir": "$1/.deaddrop",
  "logLevel": "info",
  "workspaces": [
    {
      "name": "envid",
      $2
      "secrets": ["\${env:DEADDROP_SECRET}"],
      "transports": [$(fs_transport "$ENVID/shared")]
    }
  ]
}
JSON
}
envid_config "$ENVID/fallback" ''
envid_config "$ENVID/explicit" '"peerId": "env-explicit",'

# Exported around the two starts and unset immediately: every later scenario in
# this tier runs in the same shell, and a stray peer id would rename their peers.
export DEADDROP_PEER_ID=env-fallback
ENVID_FALLBACK_PID=$(start_peer "$ENVID/fallback" "$ENVID/fallback.log")
export DEADDROP_PEER_ID=env-ignored
ENVID_EXPLICIT_PID=$(start_peer "$ENVID/explicit" "$ENVID/explicit.log")
unset DEADDROP_PEER_ID

ON_FAIL="$ENVID/fallback.log"
envid_fallback_answers() {
  wait_up "$ENVID/fallback" "$ENVID_FALLBACK_PID" || return 1
  wait_up "$ENVID/explicit" "$ENVID_EXPLICIT_PID" || return 1
  wait_for 40 1 eval 'dd "$ENVID/explicit" discover --json | grep -q env-fallback'
}
can "omit \`peerId\` and have the runtime answer on the id DEADDROP_PEER_ID names" \
  envid_fallback_answers
ON_FAIL=""

ON_FAIL="$ENVID/explicit.log"
envid_explicit_answers() {
  wait_for 40 1 eval 'dd "$ENVID/fallback" discover --json | grep -q env-explicit'
}
can "keep answering on the \`peerId\` in the file when the variable says otherwise" \
  envid_explicit_answers
ON_FAIL=""

# The negative that makes the assertion above mean something. Without it, a build
# that ignored the variable entirely would still pass every check so far.
envid_variable_lost_to_the_field() {
  not eval 'dd "$ENVID/fallback" discover --json | grep -q env-ignored'
}
cannot "have DEADDROP_PEER_ID rename a peer whose config already states its id" \
  envid_variable_lost_to_the_field

stop_peer "$ENVID_FALLBACK_PID"
stop_peer "$ENVID_EXPLICIT_PID"
