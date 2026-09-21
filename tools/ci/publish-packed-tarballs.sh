#!/usr/bin/env bash
#
# Publish pre-packed npm tarballs, in a declared order, from a directory that npm must not
# treat as a project.
#
#   tools/ci/publish-packed-tarballs.sh <directory>
#
# This is the second half of the split #486 asked for. The first half —
# `pack-framework-packages`, in .github/workflows/_publish-framework-packages.yml — installs,
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

published=0
while IFS= read -r filename || [ -n "$filename" ]; do
  [ -n "$filename" ] || continue
  echo "publish-packed-tarballs: publishing ${filename} to ${NPM_DIST_TAG}"
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
  # this loop is reading from.
  ( cd "$directory" && npm publish "./${filename}" \
      --registry https://registry.npmjs.org/ \
      --access public --tag "$NPM_DIST_TAG" --provenance < /dev/null )
  published=$((published + 1))
done < "$manifest"

# The failure class this script's header names is a green-looking PARTIAL publish. `set -e`
# aborts on a failing `npm publish`, but nothing else asserted that the loop got all the way
# through the manifest it validated.
if [ "$published" -ne "$count" ]; then
  echo "::error::publish-packed-tarballs: declared ${count} package(s) but published ${published} — refusing to report success on a partial publish." >&2
  exit 1
fi

echo "publish-packed-tarballs: published ${published} package(s) to ${NPM_DIST_TAG}"
