#!/usr/bin/env bash
#
# Tests for tools/ci/resolve-semver-override.sh against a stub `gh` that answers from canned
# files: the label is honoured only when its LAST application was by an admin or maintainer, and
# every way of not knowing that is a denial, never a grant. Pure shell.
#
#   tools/ci/test-resolve-semver-override.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="${here}/resolve-semver-override.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

# Stub gh: `gh api [--paginate] <path> --jq <filter>`. Events come from $STUB_EVENTS (one
# "<label> <login>" per line, in order); roles from $STUB_ROLES ("<login> <role>" lines). A path
# listed in $STUB_FAIL makes the call fail.
cat > "$tmp/bin/gh" <<'STUB'
#!/usr/bin/env bash
path=''
for arg in "$@"; do case "$arg" in repos/*) path="$arg" ;; esac; done
if [ -n "${STUB_FAIL:-}" ] && [[ "$path" == *"$STUB_FAIL"* ]]; then exit 1; fi
case "$path" in
  */events)
    while read -r label login; do [ "$label" = 'semver-override' ] && echo "$login"; done < "$STUB_EVENTS" ;;
  */permission)
    login="${path%/permission}"; login="${login##*/}"
    awk -v l="$login" '$1 == l { print $2 }' "$STUB_ROLES" ;;
esac
STUB
chmod +x "$tmp/bin/gh"

printf 'binalirustamov admin\nkeeper maintain\ncontributor write\ntriager triage\n' > "$tmp/roles"
export STUB_ROLES="$tmp/roles" PATH="$tmp/bin:$PATH" REPO='aiqadam/qadam-flow' PR_NUMBER='1'

pass=0
fail=0
case_() {
  local label="$1" want="$2" events="$3" got
  shift 3
  printf '%b' "$events" > "$tmp/events"
  got="$(env STUB_EVENTS="$tmp/events" "$@" "$script")"
  case "$got" in
    "$want"*) pass=$((pass + 1)) ;;
    *) fail=$((fail + 1)); printf 'FAIL  %s\n        want: %s…\n        got:  %s\n' "$label" "$want" "$got" ;;
  esac
}

case_ 'no label on the PR' 'absent' '' HAS_LABEL=false
case_ 'applied by an admin' 'granted:binalirustamov' 'feature binalirustamov\nsemver-override binalirustamov\n' HAS_LABEL=true
case_ 'applied by a maintainer' 'granted:keeper' 'semver-override keeper\n' HAS_LABEL=true
case_ 'applied by a writer' 'denied:applied by @contributor, who is write' 'semver-override contributor\n' HAS_LABEL=true
case_ 'applied by a triager' 'denied:applied by @triager, who is triage' 'semver-override triager\n' HAS_LABEL=true
case_ 'the LAST application counts: maintainer, removed, re-applied by a writer' 'denied:applied by @contributor' 'semver-override keeper\nsemver-override contributor\n' HAS_LABEL=true
case_ 'events unreadable' 'denied:' 'semver-override keeper\n' HAS_LABEL=true STUB_FAIL=/events
case_ 'role unreadable' 'denied:the role of @keeper' 'semver-override keeper\n' HAS_LABEL=true STUB_FAIL=/permission
case_ 'label present but no labeled event found' 'denied:' 'feature keeper\n' HAS_LABEL=true
case_ 'a non-collaborator (no role)' 'denied:' 'semver-override stranger\n' HAS_LABEL=true
case_ 'no PR number' 'denied:' 'semver-override keeper\n' HAS_LABEL=true PR_NUMBER=

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
