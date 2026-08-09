# Source this from the repository root, in every terminal you use:
#
#     . demo/env.sh
#
# Defines `ddrop` as a shell function over the built CLI, and exports what the
# demo configs reference: the workspace secret all the peers share, and the path
# to the local repository the git variant uses as its remote. The secret is
# generated once into demo/.secret and reused, so terminals two and three do not
# have to be handed it by hand.
#
# A function rather than an alias or a variable on purpose: an alias does not
# exist inside scripts, and `$DDROP start` breaks under zsh, which does not
# word-split an unquoted parameter the way bash does.

if [ ! -f "$PWD/package.json" ] || [ ! -d "$PWD/demo" ]; then
  echo "demo/env.sh: source this from the repository root" >&2
elif [ ! -f "$PWD/packages/dead-drop/dist/cli/bin.js" ]; then
  echo "demo/env.sh: nothing built yet. Run 'npm run build' first." >&2
else
  DDROP_BIN="$PWD/packages/dead-drop/dist/cli/bin.js"
  export DDROP_BIN
  ddrop() { node "$DDROP_BIN" "$@"; }

  if [ ! -s "$PWD/demo/.secret" ]; then
    node "$DDROP_BIN" keygen 2>/dev/null | grep '^ddk1_' >"$PWD/demo/.secret"
    echo "demo: generated a new workspace secret in demo/.secret"
  fi
  DEADDROP_SECRET=$(cat "$PWD/demo/.secret")
  export DEADDROP_SECRET

  # Absolute, because git resolves a relative remote against the clone's own
  # directory -- `workDir` -- and not against the config file or the directory
  # `ddrop start` was run in. Writing `../shared-repo.git` here looks right next
  # to `"workDir": ".deaddrop/git-work"` and sends git looking three levels too
  # deep, which surfaces only as a push failure in the log.
  DEMO_GIT_REMOTE="$PWD/demo/shared-repo.git"
  export DEMO_GIT_REMOTE

  echo "demo: ddrop ready, secret loaded from demo/.secret"
fi
