#!/usr/bin/env bash
# The dead-drop scenario suite.
#
# Unit tests answer "does this function behave". These answer "can a user do
# this, and is it stopped from doing what it should not". Every bug found in
# this project during the 0.2.x series was invisible to the unit suite because
# it only existed once real processes, real sockets, real files and real
# restarts were involved: a config typo produced a silently dead runtime, a
# `git push` that exited 0 published nothing, two runtimes quietly shared one
# working tree. None of those are function-level defects.
#
# Two tiers:
#
#   fast   no network, no credentials, minutes. Runs in CI and before a release.
#   live   a real GitHub repository. Opt-in, needs an account, ~15 minutes.
#
# Usage
#   e2e/run.sh fast
#   e2e/run.sh live <owner/repo>
#   e2e/run.sh all <owner/repo>
#   e2e/run.sh fast --npm 0.2.5      test a published version, not this tree
#   e2e/run.sh fast --only broadcast run scenarios whose file name matches
#   e2e/run.sh --list                show the scenarios in each tier
#
# The live tier writes a `deaddrop-data` branch to the repository you name and
# leaves it there. Use a private throwaway:
#
#   gh repo create <owner>/dead-drop-trial --private

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2E_DIR="$REPO_ROOT/e2e"

TIER=""
REPO=""
FROM_NPM=""
ONLY=""
LIST=0

while [ $# -gt 0 ]; do
  case "$1" in
    fast|live|all) TIER="$1"; shift ;;
    --npm) FROM_NPM="${2:-}"; shift 2 ;;
    --only) ONLY="${2:-}"; shift 2 ;;
    --list) LIST=1; shift ;;
    --help|-h) sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "e2e: unknown option $1" >&2; exit 2 ;;
    */*) REPO="$1"; shift ;;
    *) echo "e2e: unexpected argument $1" >&2; exit 2 ;;
  esac
done

tier_files() { # $1 = tier directory
  local file
  for file in "$E2E_DIR/$1"/*.sh; do
    [ -f "$file" ] || continue
    [ -z "$ONLY" ] || case "${file##*/}" in *"$ONLY"*) ;; *) continue ;; esac
    echo "$file"
  done
}

if [ "$LIST" -eq 1 ]; then
  for tier in fast live; do
    echo "$tier:"
    for file in $(tier_files "$tier"); do
      name="${file##*/}"; name="${name%.sh}"
      echo "  ${name#[0-9][0-9]-}"
    done
  done
  exit 0
fi

if [ -z "$TIER" ]; then
  echo "usage: e2e/run.sh <fast|live|all> [<owner/repo>] [--npm <version>] [--only <name>]" >&2
  exit 2
fi
if { [ "$TIER" = live ] || [ "$TIER" = all ]; } && [ -z "$REPO" ]; then
  echo "e2e: the live tier needs a repository: e2e/run.sh $TIER <owner/repo>" >&2
  exit 2
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/ddrop-e2e-XXXXXX")

# shellcheck source=e2e/lib.sh
. "$E2E_DIR/lib.sh"

trap cleanup EXIT

# Resolving the binary once here is what lets every scenario run unchanged
# against either this working tree or a tarball from the registry. A release is
# verified with the second form; nothing else about the suite changes.
if [ -n "$FROM_NPM" ]; then
  echo "target:   @fyrlabs/dead-drop@$FROM_NPM from the registry"
  mkdir -p "$WORK/pkg"
  ( cd "$WORK/pkg" && npm init -y >/dev/null 2>&1 \
      && npm install "@fyrlabs/dead-drop@$FROM_NPM" >/dev/null 2>&1 ) \
    || { echo "e2e: installing @fyrlabs/dead-drop@$FROM_NPM failed" >&2; exit 1; }
  DDROP="$WORK/pkg/node_modules/.bin/ddrop"
else
  echo "target:   the built tree at $REPO_ROOT"
  DDROP="node $REPO_ROOT/packages/dead-drop/dist/cli/bin.js"
  [ -f "$REPO_ROOT/packages/dead-drop/dist/cli/bin.js" ] \
    || { echo "e2e: dist is missing; run 'npm run build' first" >&2; exit 1; }
fi
export DDROP WORK REPO REPO_ROOT

echo "tier:     $TIER${REPO:+  repository: $REPO}"
echo "work dir: $WORK"
echo "version:  $($DDROP --version 2>/dev/null)"

# One workspace secret for the whole run. Sharing it is what makes these peers
# members of one workspace; nothing else about them is shared.
SECRET=$($DDROP keygen 2>/dev/null | grep '^ddk1_')
[ -n "$SECRET" ] || { echo "e2e: keygen produced no secret" >&2; exit 1; }
export DEADDROP_SECRET="$SECRET"

run_tier() { # $1 = tier directory
  local file
  for file in $(tier_files "$1"); do
    # Each scenario runs in this shell so it can add to the counters, and is
    # responsible for stopping what it starts. The runner kills stragglers
    # between scenarios anyway: a leaked runtime holding a port would otherwise
    # be diagnosed as a product failure three scenarios later.
    # shellcheck disable=SC1090
    . "$file"
    finish_scenario
    kill_tracked
  done
}

# Upper case on purpose. Scenario files are sourced into this shell, so every
# name here is shared with them; a scenario setting `started` for its own timing
# used to overwrite this one and the run reported the duration of its last
# measurement instead of the whole tier.
SUITE_STARTED_AT=$(date +%s)
case "$TIER" in
  fast) run_tier fast ;;
  live) run_tier live ;;
  all)  run_tier fast; run_tier live ;;
esac
finish_scenario
elapsed=$(( $(date +%s) - SUITE_STARTED_AT ))

echo
echo "================================================"
printf '  %s%d passed%s   %s%d failed%s   in %dm%02ds\n' \
  "$C_PASS" "$PASS" "$C_OFF" \
  "$([ "$FAIL" -gt 0 ] && echo "$C_FAIL" || echo "$C_DIM")" "$FAIL" "$C_OFF" \
  $((elapsed / 60)) $((elapsed % 60))
if [ -n "$FAILED_SCENARIOS" ]; then
  echo "  failed scenarios:"
  printf '%s' "$FAILED_SCENARIOS" | tr '|' '\n' | sed '/^$/d;s/^/    - /'
fi
echo "================================================"
[ "$FAIL" -eq 0 ]
