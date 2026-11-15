#!/usr/bin/env bash
# Fails when any non-merge commit in BASE..HEAD lacks a "Signed-off-by: <author name> <author email>"
# trailer that matches the commit author. See https://developercertificate.org/.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <base-sha> <head-sha>" >&2
  exit 2
fi
base="$1"
head="$2"

failed=0
checked=0
for sha in $(git rev-list --no-merges "${base}..${head}"); do
  checked=$((checked + 1))
  author_name="$(git log -1 --format='%an' "$sha")"
  author_email="$(git log -1 --format='%ae' "$sha")"
  expected="Signed-off-by: ${author_name} <${author_email}>"
  if git log -1 --format='%B' "$sha" | grep -qiF -- "$expected"; then
    echo "ok   ${sha:0:12} ${author_name} <${author_email}>"
  else
    echo "FAIL ${sha:0:12} missing '${expected}'"
    failed=$((failed + 1))
  fi
done

echo "checked ${checked} commit(s), ${failed} without a matching sign-off"
if [ "$failed" -ne 0 ]; then
  echo "Fix with: git rebase --signoff ${base} && git push --force-with-lease" >&2
  exit 1
fi
