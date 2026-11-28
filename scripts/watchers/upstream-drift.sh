#!/usr/bin/env bash
# Upstream drift watcher: how far this fork's main is behind upstream claude-mem.
#
# Prints a Markdown report on stdout. The first line is machine-readable:
#   STATUS=current   fork main contains upstream main
#   STATUS=behind    upstream has commits the fork does not
#   STATUS=diverged  no shared history found (the report says why)
#
# Read-only: fetches into refs/watcher/* and never changes branches, the
# working tree or any remote.
#
# Env:
#   UPSTREAM_URL  default https://github.com/thedotmack/claude-mem.git
#   FORK_REMOTE   default origin
#   FORK_BRANCH   default main
set -euo pipefail

UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/thedotmack/claude-mem.git}"
FORK_REMOTE="${FORK_REMOTE:-origin}"
FORK_BRANCH="${FORK_BRANCH:-main}"
FORK_REF="refs/watcher/fork-${FORK_BRANCH}"
UPSTREAM_REF="refs/watcher/upstream-main"
MAX_OVERLAP_LIST=40

git fetch --quiet "$FORK_REMOTE" "+refs/heads/${FORK_BRANCH}:${FORK_REF}"
git fetch --quiet --depth=200 "$UPSTREAM_URL" "+refs/heads/main:${UPSTREAM_REF}"

# Shallow clones may not reach the commit the fork branched from. Deepen
# both sides until they share history, then give up with a clear status.
base=""
for deepen in 0 500 1500 4000 unshallow; do
  if [ "$deepen" = "unshallow" ]; then
    if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
      git fetch --quiet --unshallow "$FORK_REMOTE" "+refs/heads/${FORK_BRANCH}:${FORK_REF}" || true
    fi
    git fetch --quiet --unshallow "$UPSTREAM_URL" "+refs/heads/main:${UPSTREAM_REF}" 2>/dev/null \
      || git fetch --quiet "$UPSTREAM_URL" "+refs/heads/main:${UPSTREAM_REF}"
  elif [ "$deepen" != "0" ]; then
    git fetch --quiet --deepen="$deepen" "$UPSTREAM_URL" "+refs/heads/main:${UPSTREAM_REF}"
    if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
      git fetch --quiet --deepen="$deepen" "$FORK_REMOTE" "+refs/heads/${FORK_BRANCH}:${FORK_REF}" || true
    fi
  fi
  if base="$(git merge-base "$FORK_REF" "$UPSTREAM_REF" 2>/dev/null)"; then
    break
  fi
  base=""
done

fork_sha="$(git rev-parse --short=12 "$FORK_REF")"
upstream_sha="$(git rev-parse --short=12 "$UPSTREAM_REF")"
version_at() {
  git show "$1:package.json" 2>/dev/null \
    | sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
}
fork_version="$(version_at "$FORK_REF")"
upstream_version="$(version_at "$UPSTREAM_REF")"

if [ -z "$base" ]; then
  echo "STATUS=diverged"
  echo
  echo "## Upstream drift: no shared history"
  echo
  echo "Could not find a common commit between \`${FORK_REMOTE}/${FORK_BRANCH}\` (\`${fork_sha}\`, v${fork_version:-?}) and upstream \`main\` (\`${upstream_sha}\`, v${upstream_version:-?}) even after fetching full history. The fork may have been re-created or force-pushed. Compare by hand before merging anything."
  exit 0
fi

behind="$(git rev-list --count "${FORK_REF}..${UPSTREAM_REF}")"
ahead="$(git rev-list --count "${UPSTREAM_REF}..${FORK_REF}")"

if [ "$behind" = "0" ]; then
  echo "STATUS=current"
  echo
  echo "## Upstream drift: up to date"
  echo
  echo "\`${FORK_REMOTE}/${FORK_BRANCH}\` (\`${fork_sha}\`, v${fork_version:-?}) contains upstream \`main\` (\`${upstream_sha}\`). Fork-only commits: ${ahead}."
  exit 0
fi

# Releases upstream has shipped that the fork does not have yet, by tag name.
releases="$(git ls-remote --tags --refs "$UPSTREAM_URL" 2>/dev/null \
  | awk '{print $2}' | sed 's#^refs/tags/##' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V \
  | awk -v cur="v${fork_version}" '
      function cmp(a, b,   x, y, i) {
        sub(/^v/, "", a); sub(/^v/, "", b)
        split(a, x, "."); split(b, y, ".")
        for (i = 1; i <= 3; i++) { if (x[i] + 0 != y[i] + 0) return (x[i] + 0 > y[i] + 0) ? 1 : -1 }
        return 0
      }
      cur == "v" || cmp($0, cur) > 0' || true)"
release_count="$(printf '%s\n' "$releases" | grep -c . || true)"

# Files both sides changed since they split: the likely merge conflicts.
fork_files="$(git diff --name-only "$base" "$FORK_REF" | sort -u)"
upstream_files="$(git diff --name-only "$base" "$UPSTREAM_REF" | sort -u)"
overlap="$(comm -12 <(printf '%s\n' "$fork_files") <(printf '%s\n' "$upstream_files") | grep . || true)"
overlap_count="$(printf '%s\n' "$overlap" | grep -c . || true)"
upstream_file_count="$(printf '%s\n' "$upstream_files" | grep -c . || true)"

echo "STATUS=behind"
echo
echo "## Upstream drift: ${behind} commits behind"
echo
echo "| | Commit | Version |"
echo "|---|---|---|"
echo "| Fork \`${FORK_REMOTE}/${FORK_BRANCH}\` | \`${fork_sha}\` | v${fork_version:-?} |"
echo "| Upstream \`main\` | \`${upstream_sha}\` | v${upstream_version:-?} |"
echo
echo "- **Behind:** ${behind} upstream commits, touching ${upstream_file_count} files."
echo "- **Fork-only commits:** ${ahead}."
echo "- **New upstream releases (${release_count}):** $(printf '%s\n' "$releases" | grep . | paste -sd ' ' - | sed 's/ /, /g')"
if [ "$overlap_count" = "0" ]; then
  echo "- **Files changed on both sides:** none, so updating should merge cleanly."
else
  echo "- **Files changed on both sides (${overlap_count}), likely merge conflicts:**"
  printf '%s\n' "$overlap" | head -n "$MAX_OVERLAP_LIST" | sed 's/^/  - `/; s/$/`/'
  if [ "$overlap_count" -gt "$MAX_OVERLAP_LIST" ]; then
    echo "  - …and $((overlap_count - MAX_OVERLAP_LIST)) more"
  fi
fi
