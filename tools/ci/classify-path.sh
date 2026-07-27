#!/usr/bin/env bash
#
# Deny-by-default path classifier for the CI docs-only filter (#132).
#
#   tools/ci/classify-path.sh <path>      # one path on argv
#   printf '%s\n' a b | tools/ci/classify-path.sh   # one path per stdin line
#
# Prints "docs" for a path that provably cannot change the outcome of
# `Lint + Unit Tests`, `CE Integration Tests`, or the Docker image build.
# Prints "code" for everything else, INCLUDING every path it does not
# recognise. "code" makes the full pipeline run, so an unrecognised path is
# always safe; "docs" is the only answer that can skip a test suite.
#
# Never invert that default, and never add a wholesale directory arm: the
# reason `docs/**` and `.agents/**` are NOT allowlisted wholesale is that both
# contain executable files today (`docs/scripts/`, `.agents/skills/**/*.sh`,
# `.agents/skills/**/*.py`), and a directory arm would keep waving them
# through on the day one of them gets wired into a workflow.
#
# Covered by tools/ci/classify-path.test.sh, which runs in the unconditional
# `Lint + Unit Tests` job so it can never be skipped by the filter it tests.

set -uo pipefail

classify_path() {
  case "$1" in
    # ---------------------------------------------------------------------
    # Denylist. Evaluated FIRST so it always beats the allowlist below.
    # The ordering is the safety property; do not reorder these arms.
    # ---------------------------------------------------------------------

    # Everything shipped or tested lives here. Also catches
    # packages/server/CLAUDE.md, a symlink that `*.md` would wave through.
    packages | packages/*) echo code ;;

    # A change to the pipeline must be validated by the full pipeline.
    .github | .github/*) echo code ;;

    # Installer, container build, task graph, deps, TS config, env files.
    run.sh | */run.sh) echo code ;;
    *docker-compose* | *Dockerfile* | *docker-entrypoint.sh) echo code ;;
    package.json | */package.json) echo code ;;
    *.lock | *lock.json) echo code ;;
    turbo.json | */turbo.json) echo code ;;
    tsconfig* | */tsconfig*) echo code ;;
    .env* | */.env*) echo code ;;

    # ---------------------------------------------------------------------
    # Allowlist. Extension-based, not directory-based, on purpose.
    # ---------------------------------------------------------------------

    # Prose.
    *.md | *.mdx) echo docs ;;

    # Prose assets: screenshots, logos, screen recordings. A media file
    # cannot change a lint result, a test result, or whether the image
    # builds -- only how a docs page looks.
    *.png | *.jpg | *.jpeg | *.gif | *.svg | *.webp | *.ico | *.avif) echo docs ;;
    *.mp4 | *.webm) echo docs ;;

    # Two named docs-site config files, by exact path rather than by glob.
    # Adding a Mintlify page requires editing the nav, so without these the
    # filter would miss most real docs PRs. INVARIANT THIS DEPENDS ON:
    # neither file is read by any workflow in .github/workflows, and
    # .dockerignore excludes `docs`, so neither reaches the image build.
    # If that ever stops being true, delete these two arms.
    docs/docs.json | docs/openapi.json) echo docs ;;

    # Licence texts (root LICENSE, docs/LICENSE).
    LICENSE | */LICENSE) echo docs ;;

    # ---------------------------------------------------------------------
    # Everything else is code by definition. This arm is the whole design.
    # ---------------------------------------------------------------------
    *) echo code ;;
  esac
}

# Only run the CLI when executed, not when sourced as a library.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  if [ "$#" -gt 1 ]; then
    echo "usage: $0 [path]   (or one path per line on stdin)" >&2
    exit 2
  fi
  if [ "$#" -eq 1 ]; then
    classify_path "$1"
  else
    while IFS= read -r line; do
      classify_path "$line"
    done
  fi
fi
