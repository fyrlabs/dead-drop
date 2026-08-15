# Resolving and creating the repository a workspace lives in.
#
# This is the one part of the github transport that never touches git. Every
# other live assertion in this tier goes through `gitTransport` against a
# repository that already exists and already carries a `deaddrop-data` branch,
# so what stays untested there is the whole of `GitHubStore.resolve`: what `gh
# repo view` says about a repository that is not there, whether that answer is
# recognised as "missing" rather than "broken", and whether `gh repo create`
# produces something a workspace can immediately use.
#
# It matters more than its size suggests, because `ddrop init --github <o>/<r>`
# writes `createIfMissing: true` (cli/cli.ts), so the create path is the first
# thing a new user runs and the only live scenarios that existed pinned it to
# `false`. The rest of it was tested against a scripted `gh` returning strings
# somebody typed, which is exactly the kind of test that keeps passing after
# GitHub changes its wording.
#
# Two real GitHub behaviours are load-bearing here and neither is ours:
#
#   - `gh repo view` on a missing repository fails with "could not resolve to a
#     Repository". `GhCli.repoInfo` matches that text to tell "not there" from
#     "the call broke", and gets NOT_FOUND with a usable message out of the
#     first and a retryable TRANSPORT_ERROR out of the second. If the wording
#     moves, a missing repository starts looking like an outage and the message
#     stops naming the fix.
#   - a repository `gh` has just created has no commits and no default branch at
#     all. `initialise` in the git transport never clones; it inits, adds a
#     remote, fails to fetch the branch and checks out an orphan, and `health`
#     carries a special case for `ls-remote` exiting 2 against a repository with
#     no branches. That path only ever runs on somebody's first day.
#
# THIS SCENARIO CREATES A REPOSITORY AND CANNOT DELETE IT. The `gh` token used
# here has no `delete_repo` scope, on purpose, so every run leaves one more
# private repository behind. They are all named `dead-drop-e2e-<timestamp>`;
# the last line of the run tells you how to remove them.

LIFE="$WORK/lifecycle"
LIFE_STATIC="$LIFE/site"
mkdir -p "$LIFE" "$LIFE_STATIC"
echo "served-from-a-repository-that-did-not-exist" > "$LIFE_STATIC/index.txt"

# The repository this scenario invents. Owned by whoever owns the repository the
# run was pointed at, so the tier still names exactly one account.
NEW_REPO="${REPO%%/*}/dead-drop-e2e-$(date +%Y%m%d-%H%M%S)"

# Defined here and not borrowed from 01-github, which defines an identical-looking
# `gh_transport` against `$REPO`. Scenarios are sourced into one shell, so
# borrowing survives a whole-tier run and dies under `--only` with an unbound
# variable, and the run still exits 0 having asserted nothing.
life_transport() { # $1 = work dir, $2 = createIfMissing
  printf '{ "use": "github", "config": { "repo": "%s", "workDir": "%s", "createIfMissing": %s, "rateLimitIntervalMs": 5000 } }' \
    "$NEW_REPO" "$1" "$2"
}
LIFE_POLLING='"polling": { "minIntervalMs": 3000, "maxIntervalMs": 15000 }'

life_field() { # $1 = peer dir, $2 = field
  dd_json "$1" "j.transports?.[0]?.$2" transport health
}

# A github transport resolves lazily, so a runtime that started proves nothing.
# Probing health is what forces `gh auth status` and `gh repo view` to run.
life_settled() { # $1 = peer dir; any verdict except the one that means "not asked yet"
  local status
  status=$(life_field "$1" status)
  [ -n "$status" ] && [ "$status" != "unknown" ]
}

life_usable() { # $1 = peer dir
  case "$(life_field "$1" status)" in healthy | degraded) return 0 ;; *) return 1 ;; esac
}

# The assertion that actually pins GitHub's wording. A message naming the
# repository and the setting can only have come through the `repoInfo`
# undefined branch; the failure this guards against reports
# "gh repo view failed: ..." instead, which is true, retryable, and useless.
missing_message_names_the_fix() {
  note "the transport says: $missing_message"
  case "$missing_message" in
    *"$NEW_REPO"*createIfMissing*) return 0 ;;
    *) return 1 ;;
  esac
}

repo_is_private() {
  [ "$(gh repo view "$NEW_REPO" --json isPrivate --jq '.isPrivate' 2>/dev/null)" = "true" ]
}

# Evidence for the claim in the assertion below it, rather than trust in what
# `gh repo create` is documented to do. A repository created without
# `--add-readme` has no commit and no default branch, so the orphan branch the
# transport pushed is the only branch there is. A `main` sitting beside it would
# mean this scenario had been asserting the ordinary already-populated case all
# along, which is what the rest of the tier covers.
only_the_orphan_branch() {
  local branches
  branches=$(gh api "repos/$NEW_REPO/branches" --jq '[.[].name] | sort | join(",")' 2>/dev/null)
  note "branches on $NEW_REPO: $branches"
  [ "$branches" = "deaddrop-data" ]
}

# A real request and response through the invented repository. Generous timeouts
# throughout: a round trip over a GitHub-backed workspace is tens of seconds on
# a good day, and a stingy bound here would report a product failure for a slow
# afternoon.
life_serves_content() {
  local port pid body
  port=$(free_port)
  pid=$(start_connect "$LIFE/reader" "creator/site" "$port" "$LIFE/connect.log" 300000)
  body=$(curl -s --max-time 305 "http://127.0.0.1:$port/index.txt" 2>/dev/null)
  stop_peer "$pid"
  [ "$body" = "served-from-a-repository-that-did-not-exist" ]
}

scenario "a repository that is not there"

note "this scenario invents $NEW_REPO, which does not exist yet"

UP_ATTEMPTS=60
write_config "$LIFE/refuser" "refuser" "$(life_transport "$LIFE/refuser/work" false)" "" "$LIFE_POLLING"
REFUSER_PID=$(start_peer "$LIFE/refuser" "$LIFE/refuser.log")

# A runtime that will not start is a runtime nobody can ask what is wrong, and a
# missing repository is a typo far more often than it is an outage.
ON_FAIL="$LIFE/refuser.log"
can "start a runtime pointed at a repository that does not exist, so it can be asked why" \
  wait_up "$LIFE/refuser" "$REFUSER_PID"

can "get a verdict on the transport rather than a runtime that never answers" \
  wait_for 30 2 life_settled "$LIFE/refuser"
ON_FAIL=""

missing_status=$(life_field "$LIFE/refuser" status)
missing_message=$(life_field "$LIFE/refuser" message)

cannot "use a repository that is not there: it reports '$missing_status', not health" \
  [ "$missing_status" = "unavailable" ]

can "tell a missing repository from a broken call, and say which setting allows creating it" \
  missing_message_names_the_fix

stop_peer "$REFUSER_PID"

scenario "creating the repository a workspace lives in"

write_config "$LIFE/creator" "creator" "$(life_transport "$LIFE/creator/work" true)" \
  "{ \"name\": \"site\", \"type\": \"static\", \"directory\": \"$LIFE_STATIC\" }" "$LIFE_POLLING"
CREATOR_PID=$(start_peer "$LIFE/creator" "$LIFE/creator.log")
wait_up "$LIFE/creator" "$CREATOR_PID" >/dev/null

ON_FAIL="$LIFE/creator.log"
can "create the repository the workspace names and come up usable against it" \
  wait_for 60 3 life_usable "$LIFE/creator"
ON_FAIL=""

# `ddrop init` never passes `private`, so this asserts the default in
# GitHubStore.resolve rather than anything the config said. Getting it wrong
# publishes a workspace to the world on its owner's first command.
cannot "create it public: a workspace repository is private unless you ask for otherwise" \
  repo_is_private

# The second peer is forbidden from creating anything, which is what makes this
# evidence that the repository is really there rather than that both peers
# papered over its absence the same way. It is also what docs/testing.md tells a
# second machine to do.
write_config "$LIFE/reader" "reader" "$(life_transport "$LIFE/reader/work" false)" "" "$LIFE_POLLING"
READER_PID=$(start_peer "$LIFE/reader" "$LIFE/reader.log")
wait_up "$LIFE/reader" "$READER_PID" >/dev/null

ON_FAIL="$LIFE/reader.log"
can "join the new repository from a peer that is not allowed to create one" \
  wait_for 60 3 life_usable "$LIFE/reader"
ON_FAIL=""

# The whole bootstrap, end to end: an orphan branch pushed to a repository with
# no commits, discovered by another machine, and read through.
ON_FAIL="$LIFE/connect.log $LIFE/creator.log $LIFE/reader.log"
can "serve a request through a repository that had no commits at all until now" \
  life_serves_content
ON_FAIL=""

can "show that it really did start from nothing: the orphan branch is the only branch on it" \
  only_the_orphan_branch

stop_peer "$CREATOR_PID"
stop_peer "$READER_PID"

note "$NEW_REPO was created by this run and is still there"
note "remove it with: gh auth refresh -h github.com -s delete_repo && gh repo delete $NEW_REPO --yes"
