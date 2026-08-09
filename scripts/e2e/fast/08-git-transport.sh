# The git transport, against a local bare repository.
#
# This is the closest thing to a real cross-machine test that needs no network
# and no account: two peers, one repository, real clones, real commits, real
# pushes and fetches. The live tier runs the same shape against GitHub; what is
# here is everything about the transport that does not need a remote host.
#
# Two properties in this file exist because breaking them has already shipped:
#
#   - `git push` exits 0 and prints "Everything up-to-date" when HEAD no longer
#     carries the commit it was told to publish, which happens whenever a second
#     process shares the clone. Reading the exit code as proof of publication
#     lost 10 of 50 requests on a live run and reported no error at all.
#   - A git working tree holds no dead-drop bookkeeping. `git add --all` stages
#     everything under the prefix and `walk` serves everything that is not
#     `.git` or `README.md`, so a lock file or a nested clone placed inside
#     `workDir` gets committed into the data branch and served as an object.

GT="$WORK/git-transport"
REMOTE="$GT/origin.git"
STATIC="$GT/site"
mkdir -p "$GT" "$STATIC"
echo "carried-by-git" > "$STATIC/index.txt"

git init --bare --quiet --initial-branch=main "$REMOTE" 2>/dev/null \
  || git init --bare --quiet "$REMOTE"

# The transport needs an identity to commit with. A checkout here has none if
# the machine has no global git config, which is exactly the state CI starts in.
git -C "$REMOTE" config user.name "dead-drop e2e" 2>/dev/null
git -C "$REMOTE" config user.email "e2e@example.invalid" 2>/dev/null

fetches_content() { # $1 = client dir, $2 = log name
  local port pid body
  port=$(free_port)
  pid=$(start_connect "$1" "keeper/site" "$port" "$GT/$2" 120000)
  body=$(curl -s --max-time 130 "http://127.0.0.1:$port/index.txt" 2>/dev/null)
  stop_peer "$pid"
  [ "$body" = "carried-by-git" ]
}

git_transport_healthy() { # $1 = peer dir
  case "$(dd_json "$1" 'j.transports?.[0]?.status' transport health)" in
    healthy|degraded) return 0 ;;
    *) return 1 ;;
  esac
}

# Everything the data branch contains, one path per line.
branch_contents() {
  git -C "$REMOTE" ls-tree -r --name-only deaddrop-data 2>/dev/null
}

# Only dead-drop's own object namespace and the README it writes to explain
# itself. Anything else means a file leaked into the working tree and got
# committed: the ownership lock and the per-runtime clones both live beside
# `workDir` rather than inside it for exactly this reason.
# `git grep` over the branch reads the committed blobs themselves, which is the
# same view anyone who clones the repository gets.
branch_is_ciphertext() {
  ! git -C "$REMOTE" grep -q "carried-by-git" deaddrop-data 2>/dev/null
}

branch_holds_only_objects() {
  local stray
  stray=$(branch_contents | grep -v '^ws/' | grep -v '^README.md$')
  [ -z "$stray" ] || note "unexpected paths on the data branch: $(printf '%s' "$stray" | tr '\n' ' ')"
  [ -z "$stray" ]
}

KEEPER_WORK="$GT/keeper-work"
write_config "$GT/keeper" "keeper" "$(git_transport "$REMOTE" "$KEEPER_WORK")" \
  "{ \"name\": \"site\", \"type\": \"static\", \"directory\": \"$STATIC\" }"
write_config "$GT/reader" "reader" "$(git_transport "$REMOTE" "$GT/reader-work")"

UP_ATTEMPTS=60
KEEPER_PID=$(start_peer "$GT/keeper" "$GT/keeper.log")
READER_PID=$(start_peer "$GT/reader" "$GT/reader.log")

scenario "a git repository as the medium"

ON_FAIL="$GT/keeper.log"
can "start a peer whose transport is a git repository it clones for itself" \
  wait_up "$GT/keeper" "$KEEPER_PID"
ON_FAIL="$GT/reader.log"
can "point a second peer at the same repository" wait_up "$GT/reader" "$READER_PID"
ON_FAIL=""

ON_FAIL="$GT/keeper.log"
can "report the git transport as usable once it has resolved the remote" \
  wait_for 30 2 git_transport_healthy "$GT/keeper"
ON_FAIL=""

ON_FAIL="$GT/keeper.log $GT/reader.log"
can "run a full request and response through commits and pushes" \
  fetches_content "$GT/reader" "reader-connect.log"
ON_FAIL=""

# The whole point of using a repository people already have: they can look at
# it. What they must not find is anything dead-drop needed for its own
# bookkeeping, because everything in the tree is served as an object.
cannot "find dead-drop's own bookkeeping committed into the data branch" \
  branch_holds_only_objects

cannot "read the traffic by cloning the repository: the objects are ciphertext" \
  branch_is_ciphertext

scenario "two runtimes pointed at one working directory"

# `ddrop connect` builds its runtime from the same config file as the running
# peer, so it inherits the same `workDir` by ordinary use rather than by
# mistake. A git working tree has exactly one writer, so the second runtime has
# to notice and clone somewhere else instead of fighting over the checkout.
SECOND_PID=$(start_connect "$GT/keeper" "keeper/site" "$(free_port)" "$GT/second.log" 60000)
sleep 5

can "start a second runtime from the same config without it corrupting the first" \
  wait_for 20 1 quietly dd "$GT/keeper" status

cannot "hand two runtimes the same git working tree" \
  [ -d "$KEEPER_WORK.peers" ]
note "the second runtime cloned into $(basename "$KEEPER_WORK").peers/$(ls "$KEEPER_WORK.peers" 2>/dev/null | head -1)"

# The separate clone must live beside the working directory, never inside it.
cannot "put the extra clone inside the working tree, where it would be committed and served" \
  [ ! -d "$KEEPER_WORK/.peers" ]

cannot "leave the ownership lock inside the working tree either" \
  [ ! -e "$KEEPER_WORK/.owner" ]

can "still see a clean data branch after a second runtime joined" \
  branch_holds_only_objects

stop_peer "$SECOND_PID"
stop_peer "$KEEPER_PID"
stop_peer "$READER_PID"
