# The live GitHub walkthrough.
#
# Everything GitHub-specific is otherwise tested against a scripted fake `gh`
# and a local bare repository, so real authentication, real latency, real rate
# limits and real large objects are unverified until something like this runs.
# The release checklist has asked for it since the beginning; it stayed undone
# across three releases because it lived in a document as a list of things to
# type. It found a silent message-loss bug the moment it was automated.
#
# This tier is deliberately not in CI. It needs an account, it writes a
# `deaddrop-data` branch to a real repository and leaves it there, and it takes
# about fifteen minutes.

GH="$WORK/github"
STATIC="$GH/site"
mkdir -p "$GH" "$STATIC"
echo "hello-over-github" > "$STATIC/index.txt"

# Polling is slowed right down compared to the fast tier: every poll is a fetch
# against a real remote, and hammering it teaches nothing that one poll does not.
gh_transport() { # $1 = work dir
  printf '{ "use": "github", "config": { "repo": "%s", "workDir": "%s", "createIfMissing": false, "rateLimitIntervalMs": 5000 } }' \
    "$REPO" "$1"
}
POLLING='"polling": { "minIntervalMs": 3000, "maxIntervalMs": 15000 }'

transport_field() { # $1 = peer dir, $2 = field
  dd_json "$1" "j.transports?.[0]?.$2" transport health
}

# The github transport resolves lazily, so `start` succeeding proves nothing at
# all. A health probe is what forces `gh auth status`, `gh repo view` and the
# clone to actually happen.
transport_is_usable() { # $1 = peer dir
  case "$(transport_field "$1" status)" in
    healthy|degraded) return 0 ;;
    *) return 1 ;;
  esac
}

discovers_keeper() { dd "$1" discover --json | grep -q '"peer-a"'; }

# Every predicate is defined here, before any scenario runs: bash resolves a
# function when the call executes, and these files are executed as they are
# sourced.

branch_is_ciphertext() {
  ! git -C "$GH/a/work" grep -q "hello-over-github" \
      "$(git -C "$GH/a/work" rev-parse HEAD 2>/dev/null)" 2>/dev/null
}

missing_exposure_is_named() {
  local port pid code
  port=$(free_port)
  pid=$(start_connect "$GH/b" "peer-a/no-such-exposure" "$port" "$GH/missing.log" 120000)
  code=$(http_code "http://127.0.0.1:$port/index.txt" "$GH/missing-body.txt" 180)
  stop_peer "$pid"
  note "the caller got http $code: $(cat "$GH/missing-body.txt" 2>/dev/null)"
  [ "$code" = "404" ]
}

message_names_the_fix() {
  note "the transport says: $message"
  case "$message" in *"gh auth login"*) return 0 ;; *) return 1 ;; esac
}

auth_failure_is_logged() {
  grep -qi "error" "$GH/c.log" && grep -qi "gh auth login" "$GH/c.log"
}

big_arrived() { [ "$code" = "200" ] && [ "$got" = "$BIG_BYTES" ]; }


scenario "talking to a real GitHub repository at all"

ON_FAIL=""
can "reach GitHub with the credentials this machine already has" quietly gh auth status
can "see the repository the run was pointed at" quietly gh repo view "$REPO" --json nameWithOwner

if [ "$FAIL" -gt 0 ]; then
  note "skipping the rest of the live tier: the preflight above has to pass first"
  return 0 2>/dev/null || exit 1
fi

RL_START=$(gh api rate_limit --jq '.resources.core.remaining' 2>/dev/null)
RL_LIMIT=$(gh api rate_limit --jq '.resources.core.limit' 2>/dev/null)
note "core rate limit at start: $RL_START of $RL_LIMIT remaining"

UP_ATTEMPTS=60
write_config "$GH/a" "peer-a" "$(gh_transport "$GH/a/work")" \
  "{ \"name\": \"site\", \"type\": \"static\", \"directory\": \"$STATIC\" }" "$POLLING"
write_config "$GH/b" "peer-b" "$(gh_transport "$GH/b/work")" "" "$POLLING"

A_PID=$(start_peer "$GH/a" "$GH/a.log")
B_PID=$(start_peer "$GH/b" "$GH/b.log")

ON_FAIL="$GH/a.log"
can "start a peer backed by a GitHub repository" wait_up "$GH/a" "$A_PID"
ON_FAIL="$GH/b.log"
can "start a second peer against the same repository" wait_up "$GH/b" "$B_PID"
ON_FAIL=""

ON_FAIL="$GH/a.log"
can "resolve the repository for real: clone it, and report the transport usable" \
  wait_for 40 3 transport_is_usable "$GH/a"
ON_FAIL=""
note "peer A's github transport is '$(transport_field "$GH/a" status)', rate limit remaining $(transport_field "$GH/a" rateLimitRemaining)"

# Every object key names the workspace and the peer, on purpose, so an operator
# can look at the repository and understand it. What must never be there is
# readable payload.
cannot "read the traffic by cloning the repository: what lands there is ciphertext" \
  branch_is_ciphertext

scenario "two machines exchanging traffic through a repository"

ON_FAIL="$GH/b.log"
can "discover another peer through nothing but the repository" \
  wait_for 40 3 discovers_keeper "$GH/b"
ON_FAIL=""

PORT=$(free_port)
CONNECT_PID=$(start_connect "$GH/b" "peer-a/site" "$PORT" "$GH/connect.log" 300000)

started=$(date +%s)
body=$(curl -s --max-time 300 "http://127.0.0.1:$PORT/index.txt" 2>/dev/null)
rtt=$(( $(date +%s) - started ))

ON_FAIL="$GH/connect.log $GH/a.log"
can "fetch a file across the internet through a git repository (${rtt}s round trip)" \
  [ "$body" = "hello-over-github" ]
ON_FAIL=""

cannot "fetch an exposure the peer does not publish" \
  missing_exposure_is_named

scenario "credentials that do not work"

# `gh auth logout` would take this session's own credentials with it: the token
# lives in the OS keyring and came from a browser login, so it cannot be put
# back without another one. An empty GH_CONFIG_DIR produces the identical state
# for one process only, which is exactly what the transport sees.
mkdir -p "$GH/empty-config"
cannot "stay authenticated in an isolated gh config, which is what makes this scenario mean anything" \
  not quietly env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$GH/empty-config" gh auth status

write_config "$GH/c" "peer-c" "$(gh_transport "$GH/c/work")" "" "$POLLING"
( cd "$GH/c" && exec env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$GH/empty-config" \
    $DDROP start --config "$GH/c/deaddrop.config.json" ) > "$GH/c.log" 2>&1 &
NOAUTH_PID=$!
track "$NOAUTH_PID"

# A runtime that refuses to start is a runtime nobody can ask what is wrong. It
# has to come up, and it has to say the transport is the part that is broken.
ON_FAIL="$GH/c.log"
can "start a runtime with no GitHub credentials at all, so it can be asked what is wrong" \
  wait_up "$GH/c" "$NOAUTH_PID"
ON_FAIL=""

status=""
for _ in $(seq 20); do
  status=$(transport_field "$GH/c" status)
  [ -n "$status" ] && [ "$status" != "unknown" ] && break
  sleep 2
done
message=$(transport_field "$GH/c" message)

cannot "use a transport whose credentials do not work: it reports '$status', not health" \
  [ "$status" = "unavailable" ]

can "find out how to fix it from the message alone" \
  message_names_the_fix

# A transport that will never recover on its own has to reach the operator. A
# config typo used to leave a runtime silently dead because this logged at debug.
cannot "have the failure swallowed: it is logged at error level, not debug" \
  auth_failure_is_logged

stop_peer "$NOAUTH_PID"

scenario "sustained load against a real remote"

# Real rate-limit exhaustion is not reachable and not worth reaching: the core
# limit is 5000/hour, so it would take thousands of calls and leave the account
# throttled for an hour afterwards. What is reachable, and what actually
# matters, is that data movement is git rather than the REST API — so the API
# budget should barely move no matter how much traffic goes through.
RL_BEFORE=$(gh api rate_limit --jq '.resources.core.remaining' 2>/dev/null)
WAVES=5
PER_WAVE=10
requests=0
answered=0
for wave in $(seq "$WAVES"); do
  pids=""
  for i in $(seq "$PER_WAVE"); do
    curl -s --max-time 300 -o "$GH/load-$wave-$i.txt" \
      "http://127.0.0.1:$PORT/index.txt" 2>/dev/null &
    pids="$pids $!"
  done
  for pid in $pids; do wait "$pid" 2>/dev/null; done
  for i in $(seq "$PER_WAVE"); do
    requests=$((requests + 1))
    [ "$(cat "$GH/load-$wave-$i.txt" 2>/dev/null)" = "hello-over-github" ] \
      && answered=$((answered + 1))
  done
  note "wave $wave: $answered of $requests answered, rate limit remaining $(transport_field "$GH/a" rateLimitRemaining)"
done

# The bug this found: `git push` exits 0 and prints "Everything up-to-date" when
# HEAD no longer carries the commit it was told to publish, and the transport
# read that as proof of publication. A live run answered 40 of 50 requests and
# reported no error anywhere. Anything short of every request is that class of
# failure until proven otherwise.
ON_FAIL="$GH/a.log $GH/connect.log"
can "answer every one of $requests concurrent requests, losing none of them silently" \
  [ "$answered" = "$requests" ]
ON_FAIL=""

RL_AFTER=$(gh api rate_limit --jq '.resources.core.remaining' 2>/dev/null)
spent=$(( RL_BEFORE - RL_AFTER ))
if [ "$spent" -lt 0 ]; then
  # The hourly window rolled over mid-run, which refills the budget and makes
  # the subtraction meaningless. Say so rather than reporting "spent -385".
  note "the rate limit window reset mid-run ($RL_BEFORE -> $RL_AFTER); spend is not measurable this run"
  cannot "exhaust the API budget with ordinary traffic" true
else
  note "core API calls spent on $requests requests: $spent ($RL_BEFORE -> $RL_AFTER)"
  cannot "spend an API call per request: data moves over git, not the REST API ($spent calls for $requests requests)" \
    [ "$spent" -lt "$requests" ]
fi

can "keep the transport usable after the load" transport_is_usable "$GH/a"

scenario "a large object through a real repository"

BIG_BYTES=$((30 * 1024 * 1024))
head -c "$BIG_BYTES" /dev/urandom > "$STATIC/big.bin"

started=$(date +%s)
code=$(http_code "http://127.0.0.1:$PORT/big.bin" "$GH/big-out.bin" 900)
elapsed=$(( $(date +%s) - started ))
got=$(wc -c < "$GH/big-out.bin" | tr -d ' ')

ON_FAIL="$GH/connect.log $GH/a.log"
can "move 30 MiB through a real GitHub repository (${elapsed}s)" \
  big_arrived
ON_FAIL=""

can "trust the bytes after a round trip through git" \
  [ "$(sha256_of "$STATIC/big.bin")" = "$(sha256_of "$GH/big-out.bin")" ]

# GitHub rejects blobs over 100 MB and the transport caps a single object at
# 40 MiB well before that, so the exposure's own 32 MiB limit is what a user
# meets first. It has to be the same refusal they would get anywhere else.
head -c $((33 * 1024 * 1024)) /dev/urandom > "$STATIC/over.bin"
over_code=$(http_code "http://127.0.0.1:$PORT/over.bin" "$GH/over-out.txt" 900)
over_body=$(cat "$GH/over-out.txt" 2>/dev/null)

cannot "push a file past the 32 MiB cap into the repository" [ "$over_code" = "413" ]
cannot "be refused without an explanation" [ "$over_body" = "File is too large to serve." ]

stop_peer "$CONNECT_PID"
stop_peer "$A_PID"
stop_peer "$B_PID"

scenario "a data branch that re-orphans itself on a real host"

# Compaction (ADR 0005) replaces the branch with a single parentless commit and
# force-pushes it under a compare-and-swap lease. A force-push is the one
# operation whose behaviour genuinely differs between a local bare repository
# and a hosted one: the host applies the lease server side, keeps unreachable
# objects on its own schedule, and can refuse the push outright. The transport's
# own tests cover the mechanics against local git; only this tier sees GitHub.
#
# On its own branch, and only after the peers above have stopped, so nothing
# else in this run ever sees a rewritten history. In particular the load
# scenario's duration is the sensitive instrument for beacon-overlap
# regressions, and it must not be measuring compaction as well.
#
# The threshold is low on purpose: the default is 500 and a whole live run makes
# roughly 195 commits, so at the default this would never fire.

CBRANCH="deaddrop-compact-e2e"
compact_transport() { # $1 = work dir
  printf '{ "use": "github", "config": { "repo": "%s", "workDir": "%s", "branch": "%s", "createIfMissing": false, "rateLimitIntervalMs": 5000, "compactAfterCommits": 4 } }' \
    "$REPO" "$1" "$CBRANCH"
}

# Read the published branch through a clone of our own rather than through a
# runtime's working tree, which has a single owner and is not ours to poke.
OBS="$GH/compact-observer"
git init --quiet "$OBS" 2>/dev/null
git -C "$OBS" remote add origin "$(gh repo view "$REPO" --json url --jq .url 2>/dev/null)" 2>/dev/null

observed() { git -C "$OBS" fetch --quiet --force origin "$CBRANCH" 2>/dev/null; }
# A compacted branch has nothing behind its root, so the root's subject says
# which of the two ways the branch was last built.
compact_root() { git -C "$OBS" log --format=%s FETCH_HEAD 2>/dev/null | tail -1; }
has_compacted() {
  observed || return 1
  [ "$(compact_root)" = "chore: compact ddrop data branch" ]
}

write_config "$GH/c" "peer-c" "$(compact_transport "$GH/c/work")" \
  "{ \"name\": \"site\", \"type\": \"static\", \"directory\": \"$STATIC\" }" "$POLLING"
write_config "$GH/d" "peer-d" "$(compact_transport "$GH/d/work")" "" "$POLLING"

C_PID=$(start_peer "$GH/c" "$GH/c.log")
D_PID=$(start_peer "$GH/d" "$GH/d.log")

ON_FAIL="$GH/c.log"
can "start a peer on a branch that compacts itself" wait_up "$GH/c" "$C_PID"
ON_FAIL="$GH/d.log"
can "point a second peer at that same branch" wait_up "$GH/d" "$D_PID"
ON_FAIL="$GH/c.log $GH/d.log"
can "resolve the repository on the compacting branch" \
  wait_for 40 3 transport_is_usable "$GH/c"

can "re-orphan the branch on GitHub once its history passes the threshold" \
  wait_for 60 5 has_compacted
observed
note "the branch root is now \"$(compact_root)\", over $(git -C "$OBS" rev-list --count FETCH_HEAD 2>/dev/null) commit(s)"

# The lease held and the tree carried over, so peers that were mid-conversation
# when the history was discarded must not notice.
CPORT=$(free_port)
CCONNECT_PID=$(start_connect "$GH/d" "peer-c/site" "$CPORT" "$GH/c-connect.log" 300000)
cbody=$(curl -s --max-time 300 "http://127.0.0.1:$CPORT/index.txt" 2>/dev/null)
can "answer a request afterwards, from peers whose history GitHub just discarded" \
  [ "$cbody" = "hello-over-github" ]

can "keep the transport usable after a force-push it did not initiate" \
  transport_is_usable "$GH/d"
ON_FAIL=""

stop_peer "$CCONNECT_PID"
stop_peer "$C_PID"
stop_peer "$D_PID"
note "$REPO also keeps its $CBRANCH branch, which this scenario force-pushes"

RL_END=$(gh api rate_limit --jq '.resources.core.remaining' 2>/dev/null)
note "core rate limit at end: $RL_END of $RL_LIMIT, $(( RL_START - RL_END )) spent over the whole run"
note "$REPO keeps its deaddrop-data branch; the repository is yours to delete"
