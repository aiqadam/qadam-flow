#!/bin/sh
# Assert that flow.aiqadam.org still serves a loader for this repository.
#
# WHY THIS EXISTS. The install commands in README.md and docs/install/options/docker.mdx
# point at flow.aiqadam.org, which is a different repository (aiqadam/flow.aiqadam.org,
# GitHub Pages). Nothing in this repo can see what that site serves, so a file that is
# missing, stale, or replaced reaches users with no signal here at all.
#
# That is not hypothetical. docs/install/options/docker.mdx has told users to run
# `curl -fsSL https://flow.aiqadam.org/doctor.sh | sh` since #221 merged, and that URL has
# returned 404 the whole time — doctor.sh was never published to the site. It was found by
# hand while verifying #30, because no check anywhere would have reported it.
#
# WHAT IT PROVES. Only that each URL serves a POSIX shell script carrying this repo's
# loader marker. It deliberately does not execute anything it downloads, and it cannot tell
# you whether the ref that loader targets is a good one — that is a decision, not a fact.
#
# WHY IT IS NOT A REQUIRED CHECK. It depends on a third-party host being reachable, so a
# network blip would block unrelated PRs. It runs on a schedule instead: a broken entry
# point is caught within a day, and no PR is ever held up by DNS.

set -eu

SITE_URL=${SITE_URL:-https://flow.aiqadam.org}
# Keep in sync with the marker comment in the loader files themselves.
LOADER_MARKER='# qadam-flow-loader:'

failures=0

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }

check_script() {
    name=$1
    url="${SITE_URL}/${name}"
    body=$(mktemp) || { fail "${name}: could not create a temporary file"; return; }

    # curl's own exit code is the authority on whether the fetch succeeded — `-f` already
    # turns an HTTP >= 400 into a failure. %{http_code} is read only to word the error, and
    # is never itself the pass condition: it is empty or 000 for a transport that has no
    # HTTP status, and treating an absent measurement as a 200 is how a check passes on
    # nothing at all.
    # `|| rc=$?` rather than a bare assignment followed by `rc=$?`: under `set -e` a failing
    # command substitution exits the script outright, which would abandon the remaining
    # entry points and report curl's exit code as the whole run's verdict — the first
    # broken URL would hide every one after it.
    rc=0
    status=$(curl -fsSL -o "$body" -w '%{http_code}' --max-time 30 "$url" 2>/dev/null) || rc=$?

    if [ "$rc" -ne 0 ]; then
        case "$status" in
            # No HTTP status came back: DNS, TLS, a timeout, or a missing file on a
            # non-HTTP transport. "The site is down" and "the file is missing" need
            # different fixes, so do not collapse them into one message.
            ''|000) fail "${name}: ${url} could not be reached at all (curl exit ${rc})" ;;
            *)      fail "${name}: ${url} returned HTTP ${status} — the file is not published" ;;
        esac
        rm -f "$body"
        return
    fi

    if ! head -n 1 "$body" | grep -q '^#!/bin/sh'; then
        fail "${name}: ${url} is served but is not a POSIX shell script (an HTML error page would look like this)"
        rm -f "$body"
        return
    fi

    if ! grep -q "$LOADER_MARKER" "$body"; then
        fail "${name}: ${url} is a shell script but carries no '${LOADER_MARKER}' marker — the site is serving a copy of the script rather than a loader for it, which is the drift this check exists to catch"
        rm -f "$body"
        return
    fi

    pass "${name}: ${url} serves a loader for this repository"
    rm -f "$body"
}

for script in "$@"; do
    check_script "$script"
done

printf '\n'
if [ "$failures" -ne 0 ]; then
    printf '%s check(s) failed. The install entry point is broken for users.\n' "$failures" >&2
    printf 'Fix it in the site repository: https://github.com/aiqadam/flow.aiqadam.org\n' >&2
    exit 1
fi
printf 'All checked entry points are live.\n'
