#!/usr/bin/env bash
#
# Reject-case tests for the migration-metadata gate (#445).
#
# tools/scripts/check-migration-rollback.ts is the only thing standing between
# a new migration and a `breaking`/`release`/`down()` that
# packages/server/api/src/app/database/rollback-migrations.ts silently mis-reads
# at rollback time — see the "Why the metadata matters" section of #445. This
# pins its `validateMigrationInstance()` reject/accept cases so the gate cannot
# be quietly weakened.
#
# Runs from the `Lint + Unit Tests` job (_verify.yml), after install: the
# checker needs `semver` and ts-node from node_modules, so it cannot join the
# pure-shell suite that runs before any install.
#
#   tools/ci/test-check-migration-rollback.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${here}/../.." && pwd)"

cd "$repo_root" || exit 1
npx ts-node --project tools/tsconfig.tools.json tools/ci/check-migration-rollback-cases.ts
