#!/usr/bin/env bash
# Files a site build into the gh-pages storage branch, or takes one out.
#
#   pages-store.sh add    <branch> <default-branch> <dist-dir>
#   pages-store.sh remove <branch> <default-branch>
#
# The default branch's build is the site root; any other branch's goes to
# preview/<branch>/, with "/" and other odd characters turned into "-".
# Two branches pushing at once both write to gh-pages, so a rejected push
# starts over from a fresh copy rather than trying to rebase.
set -euo pipefail

action=$1
branch=$2
default=$3
dist=""
if [ "$action" = add ]; then dist=$(realpath "$4"); fi

slug=$(printf '%s' "$branch" | tr -c 'A-Za-z0-9._-' '-' | sed 's/^-*//; s/-*$//')
# PAGES_REMOTE overrides the target, for trying this out against a local repo.
remote="${PAGES_REMOTE:-https://x-access-token:${GH_TOKEN:-}@github.com/${GITHUB_REPOSITORY:-}.git}"
work=$(mktemp -d)

if [ "$action" = remove ] && [ "$branch" = "$default" ]; then
  echo "The default branch is the site itself; not removing it."
  exit 0
fi

update() {
  rm -rf "$work/store"
  if git ls-remote --exit-code --heads "$remote" gh-pages >/dev/null 2>&1; then
    git clone --quiet --depth 1 --branch gh-pages "$remote" "$work/store"
  else
    git init --quiet -b gh-pages "$work/store"
    git -C "$work/store" remote add origin "$remote"
  fi
  cd "$work/store"

  if [ "$action" = add ] && [ "$branch" = "$default" ]; then
    # The root belongs to the default branch; the previews stay.
    find . -mindepth 1 -maxdepth 1 ! -name .git ! -name preview -exec rm -rf {} +
    cp -R "$dist"/. .
    message="Site from $branch at ${GITHUB_SHA:0:7}"
  elif [ "$action" = add ]; then
    rm -rf "preview/$slug"
    mkdir -p "preview/$slug"
    cp -R "$dist"/. "preview/$slug/"
    message="Preview of $branch at ${GITHUB_SHA:0:7}"
  else
    rm -rf "preview/$slug"
    message="Remove the preview of $branch"
  fi

  git add -A
  if git diff --cached --quiet; then
    echo "Nothing changed."
    return 0
  fi
  git -c user.name="github-actions[bot]" -c user.email="41898299+github-actions[bot]@users.noreply.github.com" \
    commit --quiet -m "$message"
  git push --quiet origin gh-pages
  echo "$message"
}

# Run outside an if, with errexit switched on inside the subshell: within
# a condition bash ignores set -e, and a rejected push would then count as
# success.
for attempt in 1 2 3 4 5 6 7 8; do
  set +e
  (set -e; update)
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then exit 0; fi
  echo "Updating gh-pages failed (attempt $attempt); starting over from a fresh copy."
  sleep $((attempt * 2 + RANDOM % 6)) # jittered, so racing runs fall out of step
done
exit 1
