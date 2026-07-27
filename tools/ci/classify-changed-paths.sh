#!/usr/bin/env bash
#
# Reduce a list of changed paths to a single docs_only verdict (#132).
#
#   tools/ci/classify-changed-paths.sh <file with one path per line>
#
# Prints exactly one line on stdout: "docs_only=true" or "docs_only=false".
# Per-path verdicts and warnings go to stderr so the caller can capture the
# verdict without parsing diagnostics.
#
# Fails closed. docs_only=true requires ALL of:
#   - the list file exists and is readable
#   - it contains at least one path
#   - no path is empty
#   - the number of paths classified equals the number the file contains
#   - every one of those paths classified as "docs"
#
# The count check is what catches a silent no-op loop. The original version of
# this logic read `git diff -z` output out of a shell variable, and because
# bash discards NUL bytes in command substitutions the loop classified nothing
# and reported docs_only=true on a diff under packages/. Do not remove it.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./classify-path.sh
. "${here}/classify-path.sh"

emit() {
  echo "docs_only=$1"
  exit 0
}

file="${1:-}"

if [ -z "$file" ] || [ ! -r "$file" ]; then
  echo "::warning::Changed-path list missing or unreadable; running the full pipeline." >&2
  emit false
fi

# `grep -c ''` prints 0 and exits 1 on an empty file, so capture the count and
# normalise separately -- `$(grep -c '' f || echo 0)` yields the two-line string
# "0\n0", which makes every later `[ -eq ]` an integer-expression *error* rather
# than false, and an erroring guard is a skipped guard.
expected="$(grep -c '' "$file" 2>/dev/null)" || expected=0

case "$expected" in
  '' | *[!0-9]*)
    echo "::warning::Could not count changed paths; running the full pipeline." >&2
    emit false
    ;;
esac

if [ "$expected" -eq 0 ]; then
  echo "::warning::Empty changed-path list; running the full pipeline." >&2
  emit false
fi

docs_only=true
classified=0

while IFS= read -r path; do
  if [ -z "$path" ]; then
    echo "::warning::Empty path in changed-path list; running the full pipeline." >&2
    emit false
  fi
  classified=$((classified + 1))
  verdict="$(classify_path "$path")"
  echo "  ${verdict}: ${path}" >&2
  if [ "$verdict" != docs ]; then
    docs_only=false
  fi
done < "$file"

if [ "$classified" -ne "$expected" ]; then
  echo "::warning::Classified ${classified} of ${expected} paths; running the full pipeline." >&2
  emit false
fi

echo "Classified ${classified}/${expected} paths." >&2
emit "$docs_only"
