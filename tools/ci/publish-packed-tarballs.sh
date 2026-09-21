#!/usr/bin/env bash
#
# Publish pre-packed npm tarballs, in a declared order, from a directory that npm must not
# treat as a project.
#
#   tools/ci/publish-packed-tarballs.sh <directory>
#
# This is the second half of the split #486 asked for. The first half —
# `pack-framework-packages`, in .github/workflows/_pack-framework-packages.yml — installs,
# builds, runs every pre-publish check and produces the tarballs; this half runs in the job
# that holds the publish token and does nothing but upload bytes it did not produce. Three
# properties come out of that separation, and each is asserted here rather than left to the
# job's shape:
#
#   ORDER. `pack-framework-packages` emits shared, then framework, then common — the
#   dependency order, so a registry client racing the tail never sees a dependent published
#   ahead of what it depends on. A `*.tgz` glob would sort `aiqadam-qadams-common` FIRST,
#   exactly backwards. publish-order.txt is what carries the order across the job boundary,
#   so this script reads it and never globs.
#
#   NO PROJECT CONFIG. npm resolves its project config from `localPrefix` — the nearest
#   ancestor holding a package.json or a node_modules, falling back to the cwd when the walk
#   finds none — and reads `${localPrefix}/.npmrc`, which OUTRANKS the userconfig
#   `actions/setup-node` generates from `registry-url`. The repo-root .npmrc carries
#   `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`, so publishing from anywhere inside the
#   checkout would shadow setup-node's auth line with one naming an environment variable this
#   job does not set. Measured, not assumed: with a userconfig saying `save-exact=false`, npm
#   answers `false` from a neutral directory and `true` (the repo's own .npmrc) from the repo
#   root.
#
#   It takes BOTH guards below to hold that property, and neither is sufficient alone. The
#   `npm prefix` check catches a package.json or node_modules in an ANCESTOR. It cannot
#   catch a config file in the tarball directory itself: with nothing above it, localPrefix
#   falls back to that very directory, so a planted `.npmrc` there is read as project config
#   while `npm prefix` still answers the directory and the check passes. That case is closed
#   by the sweep instead.
#
#   NOTHING UNDECLARED. The tarballs arrive as a workflow artifact, so every entry in that
#   directory is artifact-controlled. Anything that is neither the manifest nor a file a
#   manifest line names is refused — not just a stray `.tgz`, but a planted `.npmrc`,
#   `package.json` or `node_modules`, which is what makes the paragraph above true rather
#   than half-true.
#
# WHAT THIS DOES NOT CHECK: that the tarballs are the right ones. Artifact integrity between
# two jobs of the same run is GitHub's, not ours. The value here is that the token-holding
# step neither builds nor installs anything — see #486 for the `node_modules/.bin/npm` shim
# that shape removes.
set -euo pipefail

PUBLISH_ORDER_FILENAME="publish-order.txt"
NPM_DIST_TAG="${NPM_DIST_TAG:-latest}"

# RATE LIMITING. npm publishes no number for its publish rate limit, and #476's first run found
# one the hard way: 23 packages into a 239-entry manifest the registry answered
#   npm error code E429
#   npm error 429 Too Many Requests - PUT https://registry.npmjs.org/@aiqadam%2fqadam-baserow
# and `set -e` took the job down with 216 packages unpublished. Nothing here could resume it —
# the loop was a bare `npm publish` per line — so recovery meant another approved dispatch that
# would publish another ~20 and stop again. At a 239-package manifest that is not a tail case,
# it is the expected outcome.
#
# Two knobs, because a 429 needs two different answers. RETRY gets the CURRENT package published
# once the window clears. THROTTLE stops the remaining two hundred from walking into the same
# wall: the loop starts unpaced, and the first 429 is what teaches it a pace, which it doubles
# again every time the registry pushes back after that. A limit nobody documents is one you can
# only find by being pushed off it, so the script finds it at run time rather than carrying a
# guessed constant that would be wrong on the day npm changes it.
NPM_PUBLISH_MAX_ATTEMPTS="${NPM_PUBLISH_MAX_ATTEMPTS:-6}"
NPM_PUBLISH_RETRY_BASE_SECONDS="${NPM_PUBLISH_RETRY_BASE_SECONDS:-30}"
NPM_PUBLISH_RETRY_MAX_SECONDS="${NPM_PUBLISH_RETRY_MAX_SECONDS:-600}"
NPM_PUBLISH_THROTTLE_SECONDS="${NPM_PUBLISH_THROTTLE_SECONDS:-0}"
NPM_PUBLISH_THROTTLE_ON_LIMIT_SECONDS="${NPM_PUBLISH_THROTTLE_ON_LIMIT_SECONDS:-10}"
# The ceiling is a wall-clock budget as much as a pace. 120s across a 239-entry manifest is about
# eight hours, and a GitHub-hosted job is killed at six — so a run that escalates all the way to
# the cap will not finish the manifest, and is not meant to. It ends on the timeout with a few
# hundred packages published and the rest untouched, and the next dispatch resumes: the pack step
# skips versions already on the registry, so a re-run packs only what is left. Raising this does
# not buy a completed run, it buys a longer one that also does not complete.
NPM_PUBLISH_THROTTLE_MAX_SECONDS="${NPM_PUBLISH_THROTTLE_MAX_SECONDS:-120}"

# Same pattern publish-npm-package.ts enforced before the split moved the publish off that
# path. Not exploitable here — the value reaches `npm publish --tag` as a quoted argv element,
# never through a shell string — but losing a check in a refactor is how it stops being one.
case "$NPM_DIST_TAG" in
  [a-z]*) [ -z "${NPM_DIST_TAG//[a-z0-9-]/}" ] || { echo "::error::publish-packed-tarballs: refusing invalid npm dist-tag '${NPM_DIST_TAG}'" >&2; exit 1; } ;;
  *) echo "::error::publish-packed-tarballs: refusing invalid npm dist-tag '${NPM_DIST_TAG}'" >&2; exit 1 ;;
esac

directory="${1:-}"
if [ -z "$directory" ]; then
  echo "usage: tools/ci/publish-packed-tarballs.sh <directory>" >&2
  exit 2
fi
if [ ! -d "$directory" ]; then
  echo "::error::publish-packed-tarballs: no such directory: ${directory}" >&2
  exit 1
fi

directory="$(cd "$directory" && pwd)"
manifest="${directory}/${PUBLISH_ORDER_FILENAME}"

# Absent, not empty. Empty is the normal "all three were already published at their current
# version" outcome; absent means the pack job never wrote one or the artifact did not arrive,
# and publishing nothing because a file is missing is the failure this distinction exists for.
if [ ! -f "$manifest" ]; then
  echo "::error::publish-packed-tarballs: ${PUBLISH_ORDER_FILENAME} not found in ${directory} — the pack job writes it even when it packs nothing, so its absence means the artifact is incomplete." >&2
  exit 1
fi

resolved_prefix="$(cd "$directory" && npm prefix)"
if [ "$resolved_prefix" != "$directory" ]; then
  echo "::error::publish-packed-tarballs: npm resolves its project prefix to ${resolved_prefix}, not ${directory} — a package.json or node_modules above the tarballs would let a project .npmrc outrank the registry auth config. Download the artifact outside the checkout." >&2
  exit 1
fi

declared=""
count=0
while IFS= read -r filename || [ -n "$filename" ]; do
  [ -n "$filename" ] || continue
  case "$filename" in
    */*|*\\*|.*)
      echo "::error::publish-packed-tarballs: refusing manifest entry '${filename}' — entries must be plain file names." >&2
      exit 1
      ;;
  esac
  if [ ! -f "${directory}/${filename}" ]; then
    echo "::error::publish-packed-tarballs: ${PUBLISH_ORDER_FILENAME} names ${filename}, which is not in ${directory}." >&2
    exit 1
  fi
  declared="${declared}${filename}"$'\n'
  count=$((count + 1))
done < "$manifest"

# dotglob so a planted `.npmrc` is seen; nullglob so an empty directory is not a literal `*`.
# bash never yields `.` or `..` from a glob, so the loop sees real entries only.
shopt -s dotglob nullglob
for present in "${directory}"/*; do
  base="$(basename "$present")"
  if [ "$base" = "$PUBLISH_ORDER_FILENAME" ]; then
    continue
  fi
  if ! printf '%s' "$declared" | grep -Fxq -- "$base"; then
    echo "::error::publish-packed-tarballs: ${base} is present but named by no ${PUBLISH_ORDER_FILENAME} entry — refusing to publish from a directory carrying anything the pack job did not declare." >&2
    exit 1
  fi
done
shopt -u dotglob nullglob

if [ "$count" -eq 0 ]; then
  echo "publish-packed-tarballs: nothing to publish — every package was already at its published version."
  exit 0
fi

# npm's exit status says only that the publish failed, so the three outcomes that need different
# handling have to be told apart by the text it printed.
#
# ONLY npm's own error lines are read, and that restriction is the whole correctness of this
# function rather than tidiness. `npm publish` prints the TARBALL CONTENTS before it attempts the
# PUT — one `npm notice <size> <path>` line per file in the package — and everything npm writes
# to either stream lands in this log. An earlier version grepped the whole file, reasoning it was
# safe because it matched npm's markers rather than loose prose. app-sec demonstrated otherwise
# end to end: ship a doc named `Cannot publish over.md`, fail the first attempt with a 429 and
# the second with a real 403, and the 403 classifies as `conflict`, is counted as the retry's own
# lost response, and the run exits 0 reporting `published 1 package(s)` having published nothing.
# That is precisely the green-looking partial publish this file's header names as its reason to
# exist, and the retry loop is what made it reachable — before it, `set -e` ended the run on any
# failing publish, so no failure could be counted as a success. File paths inside a package are
# contributor-controlled input; npm's `npm error` lines are not.
#
# `rate-limited` and `lost-response` are both retried, and the loop paces itself after either —
# but they are NOT the same class and the conflict handler below turns on the difference. A 429
# is the registry declining to process the PUT, so nothing was written and a later conflict on
# the same name@version was not put there by us. A 5xx or a dropped connection says only that we
# never learned the outcome, which is the one case where a conflict on the retry is our own
# earlier PUT coming back to us.
#
# Each test is a HERESTRING, never `printf ... | grep -q`. Under this script's `set -o pipefail`
# the pipeline form is wrong whenever the match is early and the log is long: `grep -q` exits at
# the first hit, `printf` takes SIGPIPE on the next write, and the pipeline's status becomes 141
# even though grep matched. Reproduced directly — 20k `npm error` padding lines after an
# `npm error code E429` first line gives status 141 and the branch is skipped, so a genuine 429
# classifies as `fatal` and the run stops instead of retrying. It needs the log to outrun the
# pipe buffer (~64 KB), which is why it is latent rather than live; a herestring has no pipeline
# and no status to poison.
classify_failure() { # attempt-log -> rate-limited | lost-response | conflict | fatal
  local errors
  errors="$(grep -E '^npm (error|ERR!)' "$1" || true)"
  if grep -qE '(^|[^[:alnum:]])E429([^[:alnum:]]|$)|429 Too Many Requests' <<< "$errors"; then
    echo rate-limited
  elif grep -qE '(^|[^[:alnum:]])(E5[0-9][0-9]|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN)([^[:alnum:]]|$)' <<< "$errors"; then
    echo lost-response
  elif grep -qE 'EPUBLISHCONFLICT|[Cc]annot publish over' <<< "$errors"; then
    echo conflict
  else
    # Includes the case where npm printed no `npm error` line at all — a publish that failed
    # without one is not a class this loop knows how to retry.
    echo fatal
  fi
}

retry_sleep_seconds() { # attempt-number
  local attempt="$1" seconds="$NPM_PUBLISH_RETRY_BASE_SECONDS" i=1
  while [ "$i" -lt "$attempt" ]; do
    seconds=$((seconds * 2))
    if [ "$seconds" -ge "$NPM_PUBLISH_RETRY_MAX_SECONDS" ]; then
      echo "$NPM_PUBLISH_RETRY_MAX_SECONDS"
      return 0
    fi
    i=$((i + 1))
  done
  echo "$seconds"
}

attempt_log="$(mktemp)"
trap 'rm -f "$attempt_log"' EXIT

published=0
processed=0
preexisting=""
throttle_seconds="$NPM_PUBLISH_THROTTLE_SECONDS"
paced=0
while IFS= read -r filename || [ -n "$filename" ]; do
  [ -n "$filename" ] || continue

  # Between publishes, never before the first: an unpaced run that never trips a 429 must stay
  # exactly as fast as it was before this loop grew a throttle.
  if [ "$paced" -eq 1 ] && [ "$throttle_seconds" -gt 0 ]; then
    sleep "$throttle_seconds"
  fi
  paced=1

  attempt=1
  # Reset per package: only a failure on THIS name@version can make a conflict on it ours.
  lost_response=0
  while :; do
    echo "publish-packed-tarballs: publishing ${filename} to ${NPM_DIST_TAG} (attempt ${attempt})"
    # --provenance builds its attestation from this job's GitHub Actions environment and the
    # tarball's own digest (libnpmpublish reads GITHUB_REPOSITORY / GITHUB_SHA / GITHUB_REF /
    # GITHUB_WORKFLOW_REF and hashes the tarball bytes), never from a working tree — which is
    # why it still works here with no checkout. It requires `id-token: write` on the job and
    # `--access public`; both are set where this runs.
    # --registry is passed for the same reason --access and --tag are: `npm publish` flattens the
    # TARBALL's own `publishConfig` into its options, filtered only by keys already set as CLI
    # flags. The tarball is artifact-supplied data crossing a job boundary, so an embedded
    # `publishConfig.registry` would otherwise choose where the token is sent. None of the three
    # packages declares one; this makes that structural rather than circumstantial.
    # stdin from /dev/null so nothing npm might prompt for can consume the rest of the manifest
    # this loop is reading from. Output is captured rather than streamed because the retry
    # decision below is read out of it; both halves are echoed straight back out.
    if ( cd "$directory" && npm publish "./${filename}" \
        --registry https://registry.npmjs.org/ \
        --access public --tag "$NPM_DIST_TAG" --provenance < /dev/null ) > "$attempt_log" 2>&1; then
      cat "$attempt_log"
      published=$((published + 1))
      processed=$((processed + 1))
      break
    fi
    cat "$attempt_log" >&2

    failure_class="$(classify_failure "$attempt_log")"
    case "$failure_class" in
      conflict)
        # The registry already holds this exact name@version. Which of two very different things
        # that means depends entirely on whether WE put it there, and the only evidence for that
        # is what the EARLIER attempts on this same package failed with.
        #
        # After a 5xx or a dropped connection it is the benign one: the PUT may well have landed
        # and only its response was lost, which is the ordinary way a retried non-idempotent
        # request ends. Counting that as published is what makes the retry above safe to have.
        #
        # After a 429 — or on the first attempt — it is not. A 429 is the registry declining to
        # process the request, so nothing of ours was written; and the pack step refuses to pack
        # a version already on the registry. Either that check read a stale packument, or a
        # version under the official scope was published by something that is not this pipeline.
        # An earlier version of this code took `attempt > 1` as proof of a lost response, which
        # accepted exactly that case silently. The loop keeps going (the other packages are the
        # deliverable, and no outcome here can change bytes already on the registry), but the run
        # ends red with the names listed. Disambiguating is a packument read away: if
        # `npm view <name>@<version> dist.tarball` resolves to a publish from this run's commit,
        # it was ours after all.
        if [ "$lost_response" -eq 1 ]; then
          echo "publish-packed-tarballs: ${filename} was already on the registry, and an earlier attempt on it failed without an answer — that attempt landed before its response was lost. Counting it as published."
          published=$((published + 1))
          processed=$((processed + 1))
          break
        fi
        echo "::warning::publish-packed-tarballs: ${filename} is already on the registry at this version, and nothing in this run can have put it there. Continuing with the rest of the manifest; the run will fail at the end." >&2
        preexisting="${preexisting}${filename}"$'\n'
        processed=$((processed + 1))
        break
        ;;
      rate-limited | lost-response)
        if [ "$failure_class" = lost-response ]; then
          lost_response=1
        fi
        if [ "$attempt" -ge "$NPM_PUBLISH_MAX_ATTEMPTS" ]; then
          echo "::error::publish-packed-tarballs: the registry is still refusing ${filename} after ${attempt} attempts. Re-dispatch to resume — the pack step skips versions already published, so a re-run picks up where this stopped." >&2
          exit 1
        fi
        # The pace this run settles on. Doubling from the configured starting point rather than
        # from zero means a manifest that trips the limit twice ends up slower than one that
        # trips it once, which is the only signal available about how far over the line it is.
        if [ "$throttle_seconds" -lt "$NPM_PUBLISH_THROTTLE_ON_LIMIT_SECONDS" ]; then
          throttle_seconds="$NPM_PUBLISH_THROTTLE_ON_LIMIT_SECONDS"
        else
          throttle_seconds=$((throttle_seconds * 2))
        fi
        if [ "$throttle_seconds" -gt "$NPM_PUBLISH_THROTTLE_MAX_SECONDS" ]; then
          throttle_seconds="$NPM_PUBLISH_THROTTLE_MAX_SECONDS"
        fi
        backoff="$(retry_sleep_seconds "$attempt")"
        echo "publish-packed-tarballs: the registry pushed back on ${filename} (${failure_class}); waiting ${backoff}s before attempt $((attempt + 1)), and pacing the rest of the manifest at ${throttle_seconds}s between publishes."
        sleep "$backoff"
        attempt=$((attempt + 1))
        ;;
      *)
        echo "::error::publish-packed-tarballs: ${filename} failed to publish for a reason that retrying will not fix. Stopping here rather than working down the rest of the manifest." >&2
        exit 1
        ;;
    esac
  done
done < "$manifest"

# The failure class this script's header names is a green-looking PARTIAL publish. Every exit
# path above is already non-zero, but nothing else asserted that the loop got all the way through
# the manifest it validated.
if [ "$processed" -ne "$count" ]; then
  echo "::error::publish-packed-tarballs: declared ${count} package(s) but got through ${processed} — refusing to report success on a partial publish." >&2
  exit 1
fi

if [ -n "$preexisting" ]; then
  echo "::error::publish-packed-tarballs: the whole manifest was processed, but these were already on the registry at the packed version and were NOT published by this run:" >&2
  printf '%s' "$preexisting" | sed 's/^/::error::  /' >&2
  echo "::error::Check who published them before treating this as a stale-packument read." >&2
  exit 1
fi

echo "publish-packed-tarballs: published ${published} package(s) to ${NPM_DIST_TAG}"
