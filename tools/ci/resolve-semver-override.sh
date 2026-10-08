#!/usr/bin/env bash
#
# Resolves the `semver-override` label (ADR-0001: a maintainer-only bypass of gate 2) into the
# verdict tools/ci/check-changeset-levels.mjs reads as SEMVER_OVERRIDE:
#
#   absent             the PR does not carry the label
#   granted:<login>    the most recent `labeled` event for it was by a repository admin or maintainer
#   denied:<reason>    it carries the label but that cannot be established (applied by someone with
#                      a lower role, or the API could not be read) — fail closed
#
# GitHub cannot restrict who applies a label (anyone with triage can), so "maintainer-only" is
# enforced here, at the point the label is consumed, from the issue events (who applied it) and
# the collaborator permission API (what role they hold). The label stays on the PR, so every use
# is visible there and in the gate's own log.
#
# Env: REPO (owner/name), PR_NUMBER, HAS_LABEL (true/false, from the event payload), GH_TOKEN.
# Prints the verdict on stdout; always exits 0 — the gate decides what a verdict means.
#
# Tested by tools/ci/test-resolve-semver-override.sh against a stub `gh`.

set -uo pipefail

LABEL='semver-override'

if [ "${HAS_LABEL:-false}" != 'true' ]; then
  echo 'absent'
  exit 0
fi

if [ -z "${REPO:-}" ] || [ -z "${PR_NUMBER:-}" ]; then
  echo 'denied:the PR number or repository is unknown, so who applied the label cannot be checked'
  exit 0
fi

actor="$(gh api --paginate "repos/${REPO}/issues/${PR_NUMBER}/events" \
  --jq ".[] | select(.event == \"labeled\" and .label.name == \"${LABEL}\") | .actor.login" 2>/dev/null | tail -n 1)"
if [ -z "$actor" ]; then
  echo "denied:no 'labeled' event for ${LABEL} could be read, so who applied it is unknown"
  exit 0
fi
case "$actor" in
  *[!A-Za-z0-9-]*) echo "denied:unexpected login '${actor}'"; exit 0 ;;
esac

role="$(gh api "repos/${REPO}/collaborators/${actor}/permission" --jq '.role_name' 2>/dev/null)"
case "$role" in
  admin|maintain) echo "granted:${actor}" ;;
  '') echo "denied:the role of @${actor}, who applied ${LABEL}, could not be read" ;;
  *) echo "denied:applied by @${actor}, who is ${role}, not admin or maintain" ;;
esac
