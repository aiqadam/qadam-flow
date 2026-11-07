#!/bin/bash
# =============================================================================
# qadam-flow — Debian prebuild (copy-out: the repo tree is never written)
# =============================================================================
# Runs the npm/npx toolchain inside a disposable copy of the repo and stages
# the runtime payload dpkg-buildpackage packages, WITHOUT bun:
#
#     build/
#       package-lock.json   REFRESH_LOCK=1 product — commit it (see step 3)
#       source/             full disposable copy of the repo root (no .git,
#                           build, node_modules, dist, .turbo, .env*)
#       deb/                final artifacts (filled by the dpkg-buildpackage
#                           step; see debian/README.md for the full chain)
#
# Every step writes OVER build/source and never the repo working tree. Even
# the repo's package.json manifests are not transformed in place here (see
# scripts/workspace-to-file.cjs — the derivation happens inside the copy):
#
#   1. copy the repo root into build/source (tar pipe; cache/artifact-free),
#   2. derive npm-compatible manifests inside the copy: `overrides` mirrored
#      from `resolutions`, direct deps the overrides redirect dropped (npm
#      EOVERRIDE — the rollup case), workspace:* specs -> file: in members,
#   3. package-lock.json, three-state:
#        REFRESH_LOCK=1             -> regenerate from the registry inside the
#                                      copy; product build/package-lock.json,
#                                      commit it to the repo root (the only
#                                      bootstrap step that is a git operation
#                                      and it is yours, not this script's),
#        committed package-lock.json -> use it verbatim (reproducible build),
#        neither                    -> fail: npm ci on the derived tree would
#                                      silently re-resolve the registry,
#   4. npm ci (full install — the .deb ships this exact node_modules, so the
#      bundled-qadam metadata later reflects the shipped tree; a prod-only
#      prune is a later optimization, see the header of debian/README.md),
#   5. npx turbo build: web, engine, api, worker, all bundled qadams,
#   6. the three manifests Docker writes: packages/qadams/dist-index.json
#      (#419), packages/server/api/dist/src/migration-manifest.json, and
#      packages/qadams/bundled-qadams-metadata.json (#598),
#   7. restore the REPO manifests over the copy — the staged payload then
#      carries the original workspace:* spelling and nothing parses dep specs
#      outside installs,
#   8. stage into build/source/debian/prebuild/usr in the exact layout
#      debian/qadam-flow-common.install picks up.
#
# Local run order — the one-shot driver at the repo root does all of it:
#     REFRESH_LOCK=1 bash build-deb.sh
#     cp build/package-lock.json package-lock.json && git add package-lock.json
#     bash build-deb.sh              <- later runs: committed lock, reproducible
#
# Run order on the buildbot: the same entrypoint, one step (see the knixbbot
# yaml): bash ./build-deb.sh "$DEB_VERSION"
# debian/rules override_dh_auto_build fails loudly when the stage is missing.
# A rerun wipes build/ (fresh copy, fresh node_modules) — fully idempotent.
# =============================================================================
# =============================================================================

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/build"
SRC="$BUILD/source"
LOCK_OUT="$BUILD/package-lock.json"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
log()  { echo -e "${CYAN}[PREBUILD]${NC} $1"; }
fail() { echo -e "${RED}[FATAL]${NC} $1" >&2; exit 1; }

command -v node >/dev/null || fail "node is not installed"
command -v npm  >/dev/null || fail "npm is not installed"
command -v tar  >/dev/null || fail "tar is not installed"
command -v git  >/dev/null || fail "git is not installed (the copy-out is the index's file list)"
# Native deps compile HERE and ship inside the .deb: they must match the
# runtime ABI the packages target — debian/control requires nodejs >= 24,
# and isolated-vm 7.0.1 hard-requires it (EBADENGINE + a compile error under
# node 22). Same constraint the Docker build satisfies via node 24.
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 24 ] || fail "node >= 24 required, running $(node --version) — isolated-vm 7.0.1 does not compile under older ABIs (e.g. nvm use 24)"
test -f "$ROOT/package.json"     || fail "package.json missing in $ROOT"
test -d "$ROOT/packages/qadams"  || fail "packages/qadams missing"
test "$SRC" != "$ROOT"           || fail "internal error: the source copy is the repo root"
cd "$ROOT"

# --- 0b. run mode + phase stamps -----------------------------------------------------
# fresh  (default): clean-room build — build/ is wiped, every phase runs.
# resume (build-deb.sh --resume): iteration mode. The tar becomes an overlay
# (tracked files re-extracted over the copy; carried state — node_modules,
# .turbo, dist — survives, so turbo's cache stays warm), and every phase after
# it consults a build/.phase stamp first. A stamp encodes the phase's INPUT
# hashes; it skips only when those hashes are unchanged, never on elapsed
# time or exit status. Falls back to fresh only when build/source does not
# exist at all; a tree without stamps is stamped from scratch. Delete
# build/.phase (or just run --fresh) whenever the state is in doubt.
MODE="${DEB_BUILD_MODE:-fresh}"
case "$MODE" in fresh|resume) ;; *) fail "unknown DEB_BUILD_MODE '$MODE' (fresh|resume)";; esac
PHASES="$BUILD/.phase"
if [ "$MODE" = resume ] && [ ! -d "$SRC" ]; then
    log "resume requested but build/source does not exist — building fresh"
    MODE=fresh
fi
if [ "$MODE" = resume ] && [ ! -d "$PHASES" ]; then
    log "resume: no stamps yet — carrying build/source as-is and stamping phases as they run"
fi
# skip_phase <name> -- 0 => the phase may be skipped ($1: its current input hash)
skip_phase() {
    [ "$MODE" = resume ] || return 1
    [ -f "$PHASES/$1.ok" ] || return 1
    [ "$(cat "$PHASES/$1.inputs" 2>/dev/null)" = "$2" ] || return 1
}
# keep_stamp <name> -- record $2 as the phase's input fingerprint on success
keep_stamp() {
    mkdir -p "$PHASES"
    printf '%s\n' "$2" > "$PHASES/$1.inputs"
    : > "$PHASES/$1.ok"
}
# input_hash -- sha256 over (pathNUL contentNUL) of every tracked manifest-level
# build input: the same selection the copy-out will extract, read from DISK,
# no mtimes involved. Changes iff the derived manifests would change.
input_hash() {
    (cd "$ROOT" && git ls-files -z | tr '\0' '\n' \
        | grep -E '(^|/)package\.json$|^\.npmrc$|^bunfig\.toml$|^bun\.lock$' \
        | sort \
        | while IFS= read -r f; do printf '%s\0' "$f"; cat "$f"; printf '\0'; done \
        | sha256sum | cut -d' ' -f1)
}

# The vendored .npmrc interpolates ${NPM_TOKEN}; the bot has no token (it
# exists to publish). Modern npm no longer throws on an undefined interpolant
# (the placeholder is shipped literally), but a missing token becomes a
# registry-side rejection on the first registry-touching command — setting a
# stable sentinel keeps public packuments flowing; if the registry ever
# started gating on it, the bot would export a real token instead.
export NPM_TOKEN="${NPM_TOKEN:-debian-build-placeholder}"

echo "version  : $(node -p 'require("./package.json").version')"
echo "node/npm : $(node --version) / $(npm --version)"

# --- 0. build inputs are committed ----------------------------------------------
# The payload ships the repo's package.json manifests verbatim (step 7) and
# the staged .npmrc/bunfig/debian/ files ride along with them; anything
# locally-modified in those paths would silently diverge from what the
# buildbot would build from the same commit. NUL-delimited status (no
# porcelain quoting for odd paths), filtered to the build inputs. Local only
# (the bot's checkout is a clobbered clone).
if test -d "$ROOT/.git"; then
    DIRTY=$(git -C "$ROOT" status --porcelain=v1 -z -- package.json packages .npmrc bunfig.toml bun.lock debian \
        | tr '\0' '\n' \
        | grep -E 'package\.json$|\.npmrc$|bunfig\.toml$|bun\.lock$|[[:space:]]debian/' || true)
    if [ -n "$DIRTY" ]; then
        echo "$DIRTY" >&2
        fail "build inputs are modified/untracked in the repo — commit them first"
    fi
fi

# --- 1. copy-out ---------------------------------------------------------------
# Tracked files only, via the index — byte-for-byte what a fresh clone (the
# buildbot's clobbered checkout) holds: untracked local state — caches, dist,
# .turbo, .env.prod, dev-run data, working notes — never crosses into the
# copy, and the dpkg source tree inherits the same hygiene by construction.
# Tar pipe from the NUL-delimited ls-files list (no rsync dependency).
# GNU tar ≥ 1.35 rejects options placed after operands (`--exclude` after
# `-T -` errored out with "has no effect"), hence the exclude-first order.
# One exclusion remains on top of the index: env files — tracked or not, build
# inputs never vary by host and nothing in the build reads them (npm ci and
# the turbo build are env-free phases).
# In resume mode the same pipe becomes an overlay (no rm): carried state
# (node_modules, .turbo, dist) survives so the warm turbo cache is reused.
# The manifest-level files are the one exception: while the derive stamp says
# the copy ALREADY carries the derived npm shape, re-copying the repo's
# pristine bun-canonical manifests over it would make every following phase
# (npm regen/ci) read `workspace:*` and die — so they ride along only when
# the derive is actually going to run. A file deleted from git since the
# last run lingers in the copy until the next fresh build — tolerable for
# iteration, wrong for release, which is what --fresh is for.
MANIFEST_RE='(^|/)package\.json$|^\.npmrc$|^bunfig\.toml$|^bun\.lock$'
DERIVE_STAMP="$(input_hash)|$(sha256sum scripts/workspace-to-file.cjs scripts/debian-tsconfig-paths.cjs | cut -d' ' -f1 | tr '\n' '+')"

# Derivation-state guard: the derived npm shape must actually be IN the copy
# once a derive stamp claims it — the root manifest carries layered overrides
# (never the case in the pristine, bun-canonical repo shape) and .npmrc holds
# the npm-only allow-script policy. A stale or half-migrated copy forces the
# derive to run so a stamp can never mask missing derivation work.
derive_state_ok() {
    [ -f "$SRC/package.json" ] || return 1
    local n
    n=$(node -p "Object.keys(require('$SRC/package.json').overrides ?? {}).length" 2>/dev/null) || return 1
    [ "$n" -ge 1000 ] || return 1
    grep -q '^allow-scripts' "$SRC/.npmrc" 2>/dev/null
}

# --- 1a. purge disposable dh staging state -------------------------------------
# dpkg-buildpackage leaves untracked state under build/source/debian/ (the
# package trees, dh logs, .debhelper). The purge must run BEFORE the copy-out
# extract, not after it: dh's per-package build dir is named like a tracked
# file (debian/qadam-flow-worker is both the launcher script and dh's worker
# staging directory), so a stale dir from the previous dpkg run blocks the
# extraction of the tracked file outright ("Cannot open: File exists") — and
# stale package trees would likewise make dh_install die with
# "mkdir ...: File exists". Everything purged here is rebuilt on demand —
# debian/prebuild by the staging step below, package trees by dh, the rest
# by debhelper. Kept as an explicit list: the names must match
# debian/control's binary packages plus debhelper's droppings; a broader
# catch-all purge would eat tracked files that share a directory's name.
log "purging stale dh staging state under debian/"
for entry in .debhelper debhelper-build-stamp prebuild qadam-flow \
             qadam-flow-common qadam-flow-worker tmp files '*.debhelper.log'; do
    [ -e "$SRC/debian/$entry" ] || continue
    rm -rf "$SRC/debian/$entry"
    # dh's staging dir and a tracked file can share a name (the worker
    # script) — restore the tracked copy so the extract only overwrites it
    if [ -n "$(git -C "$ROOT" ls-files "debian/$entry" | head -1)" ]; then
        git -C "$ROOT" show "HEAD:debian/$entry" > "$SRC/debian/$entry"
    fi
done
ok "dh staging clean"

log "copying repo into $SRC (tracked files; $MODE mode)"
if [ "$MODE" = fresh ]; then
    rm -rf "$BUILD"
    mkdir -p "$SRC"
    git -C "$ROOT" ls-files -z | tar --exclude='.env*' -cf - --null -T - | tar -xf - -C "$SRC"
else
    mkdir -p "$SRC"
    if [ -d "$SRC/node_modules" ] && skip_phase derive "$DERIVE_STAMP" && derive_state_ok; then
        log "copy-out overlay (carrying node_modules/.turbo/dist; manifest files left as derived)"
        git -C "$ROOT" ls-files -z \
            | grep -zvE "$MANIFEST_RE" \
            | tar --exclude='.env*' -cf - --null -T - \
            | tar -xf - -C "$SRC"
    else
        if [ -d "$SRC/node_modules" ]; then
            log "copy-out overlay (full — derivation inputs changed)"
        else
            log "copy-out overlay (full — no installed state to carry)"
        fi
        git -C "$ROOT" ls-files -z | tar --exclude='.env*' -cf - --null -T - | tar -xf - -C "$SRC"
    fi
fi

# The copy is the build input: assert cleanliness anyway. Fresh mode excludes
# every known cache/artifact class outright; resume mode deliberately carries
# them (they are the state the stamps gate). What stays forbidden in BOTH
# modes is private repo state the tar must never carry.
for junk in .git build .env.dev .env.prod; do
    test ! -e "$SRC/$junk" || fail "copy-out failed: $SRC/$junk must not exist"
done
if [ "$MODE" = fresh ]; then
    for junk in node_modules .turbo dist \
                packages/shared/node_modules packages/server/api/node_modules; do
        test ! -e "$SRC/$junk" || fail "copy-out failed: $SRC/$junk must not exist"
    done
    ok "copy-out clean"
else
    ok "copy-out overlay complete"
fi

# --- 2. derive npm-compatible manifests inside the copy ------------------------
# The repo is bun-canonical (workspace:* / resolutions); npm rejects both.
# The derivation is mechanical and happens ONLY inside build/source — the
# repo working tree stays pristine (see the header of workspace-to-file.cjs).
# Inputs: the tracked manifest-level files (input_hash) plus both derivation
# helpers read from disk — the cjs scripts are uncommitted working files, so
# they are hashed explicitly rather than through the index.
if skip_phase derive "$DERIVE_STAMP" && derive_state_ok; then
    log "derive: inputs unchanged and the copy holds the derived shape — skipping"
else
    log "deriving npm manifests (overrides<-resolutions, workspace:*->file:)"
    node scripts/workspace-to-file.cjs apply "$SRC"
    keep_stamp derive "$DERIVE_STAMP"
fi

# --- 3. package-lock.json — three-state ----------------------------------------
# A COMMITTED package-lock.json is the source of truth on the npm path (bun
# users ignore it): the buildbot never silently adopts a fresh registry
# state. The lock maps the DERIVED npm shape (overrides + file: links), so
# regenerating it is deliberately tied to a REFRESH_LOCK run and a commit.
#
# Resume nuance: the copy's lock may be a previous REFRESH_LOCK run's output
# whose commit is still pending (the lock commit stays a git operation). The
# stamp is over the copy's lock CONTENT plus the derived-manifest inputs, so
# a skipped phase means "the previously installed tree already matches these
# inputs" — in that state keeping the working lock is exactly right.
LOCK_STAMP="(derived: $DERIVE_STAMP)|repair:$(sha256sum scripts/debian-lock-repair.cjs | cut -d' ' -f1)|$(sha256sum "$SRC/package-lock.json" 2>/dev/null | cut -d' ' -f1)"
if [ "${REFRESH_LOCK:-0}" != "1" ] && skip_phase lock "$LOCK_STAMP"; then
    log "lock: the copy's package-lock.json is current — skipping"
else
    if [ "${REFRESH_LOCK:-0}" = "1" ]; then
        log "REFRESH_LOCK=1 — regenerating package-lock.json (npm install --package-lock-only, cold)"
        # npm seeds its ideal tree from an installed node_modules even in
        # --package-lock-only mode, and does not reconcile the current
        # overrides against it — so a tree from a previous run (built before
        # an override change) silently shadows the new resolution. A stale
        # lock fragments the same reconciliation path and (with this tree's
        # override set) aborts mid-placement with "Invalid Version: " in
        # arborist's dedupe — so the regen runs cold: no tree, no lock.
        rm -rf "$SRC/node_modules"
        rm -f "$SRC/package-lock.json"
        (cd "$SRC" && npm install --package-lock-only --ignore-scripts --no-fund --no-audit)
        cp -f "$SRC/package-lock.json" "$LOCK_OUT"
        ok "lock regenerated -> build/package-lock.json"
        echo "commit it to the repo root: cp build/package-lock.json package-lock.json && git add package-lock.json"
    elif [ -f "$ROOT/package-lock.json" ]; then
        cp -f "$ROOT/package-lock.json" "$SRC/package-lock.json"
        log "using committed package-lock.json (REFRESH_LOCK=1 to regenerate)"
    elif [ "$MODE" = resume ] && [ -f "$SRC/package-lock.json" ]; then
        log "resume: keeping the copy's working package-lock.json (commit build/package-lock.json for release use)"
    else
        fail "package-lock.json is not committed — run REFRESH_LOCK=1 $(basename "$0") once, commit build/package-lock.json to the repo root, then rerun"
    fi
    # Correctness gate for whichever lock the branch produced, before it is
    # stamped or installed: npm's --package-lock-only can emit EMPTY
    # placeholder nodes (a later `npm ci` aborts in arborist's canDedupe
    # with "Invalid Version: ") and can leave a dependency declared by a
    # nested node with no lock node to satisfy it (observed: arrify under
    # gcloud-pubsub's nested google-auth-library — the vendored tree then
    # failed require('arrify') at manifest-load time). The repair is
    # idempotent and audited; see scripts/debian-lock-repair.cjs.
    log "lock repair/audit"
    node scripts/debian-lock-repair.cjs "$SRC" "$BUILD"
    LOCK_STAMP="(derived: $DERIVE_STAMP)|repair:$(sha256sum scripts/debian-lock-repair.cjs | cut -d' ' -f1)|$(sha256sum "$SRC/package-lock.json" | cut -d' ' -f1)"
    keep_stamp lock "$LOCK_STAMP"
fi

# --- 4. full dependency install -------------------------------------------------
# REDISMS_DISABLE_POSTINSTALL=1 matches the Docker build: the redis client's
# postinstall musl/glibc probe must not run on Debian (redis comes from the
# system package).
# Stamp: the lock stamp rides transitively (derive inputs + lock content) and
# the npmrc content plus the running node version anchor the installed tree —
# switching interpreters between runs cannot reuse it.
CI_STAMP="(lock: $LOCK_STAMP)|npmrc:$(sha256sum "$SRC/.npmrc" 2>/dev/null | cut -d' ' -f1)|node:$(node --version)"
if [ -d "$SRC/node_modules" ] && skip_phase ci "$CI_STAMP"; then
    log "ci: the installed node_modules match these inputs — skipping"
    ok "node_modules ready (resume)"
else
    log "npm ci (full workspace install)"
    (cd "$SRC" && REDISMS_DISABLE_POSTINSTALL=1 npm ci --no-fund --no-audit)
    keep_stamp ci "$CI_STAMP"
    ok "node_modules ready"
fi

# --- 4b. native builders ------------------------------------------------------------
# Two holes the npm-script policy leaves open on Linux (the .deb ships this
# node_modules, so a skipped or failed native build would break the payload
# while `npm ci` still exits 0):
#   1. isolated-vm 7.0.1 ships prebuilds only for darwin-arm64 — on Linux the
#      install-script compile MUST run, and its `timer.h` misses
#      `#include <cstdint>`, which gcc 16 rejects (`uint32_t` not declared —
#      only timer.h/timer.cc fail, the rest of the TU set is clean). The
#      Dockerfile builds it under the image's older toolchain, so upstream
#      never needed the include. Patch the vendored header (idempotent) and
#      compile directly with node-gyp: node-gyp-build's CLI swallows compile
#      errors and exits 0, so going around it is also what makes this honest.
#   2. Everything else approved in ALLOW_SCRIPTS loads through linux prebuilds
#      or pure-JS fallbacks (bcrypt ships linux-x64 glibc/musl prebuilds, ssh2
#      has a JS fallback, cpu-features compiles via its own script); the
#      require-check below covers the two the payload cannot start without.
# Fail-closed: missing binding == broken payload == no .deb.
log "native builders (isolated-vm timer.h patch + direct compile + load check)"
IVM="$SRC/node_modules/isolated-vm"
IVM_H="$IVM/src/lib/timer.h"
test -d "$IVM" || fail "isolated-vm is missing from the install (engine sandbox dependency)"
# The smoke check gates the phase on every run: an existing binding that loads
# (isolated-vm Isolate + bcrypt + ssh2) means the compile may be skipped —
# the .deb only cares that the binding works, and a load test is stronger
# evidence than a stamp.
native_smoke() {
    (cd "$SRC" && node -e "\
  const ivm = require('isolated-vm');\
  const iso = new ivm.Isolate();\
  iso.dispose();\
  require('bcrypt');\
  require('ssh2');\
  console.log('native bindings load OK');\
")
}
if [ -s "$IVM/build/Release/isolated_vm.node" ] && native_smoke >/dev/null 2>&1; then
    ok "native bindings already built and load OK — skipping compile"
else
    grep -q '#include <cstdint>' "$IVM_H" \
        || sed -i '0,/#include <memory>/s//#include <cstdint>\n#include <memory>/' "$IVM_H"
    grep -q '#include <cstdint>' "$IVM_H" || fail "isolated-vm timer.h patch did not apply"
    (cd "$IVM" && rm -rf build && ../../node_modules/.bin/node-gyp rebuild --release -j max) \
        || fail "isolated-vm native compile failed — see the gyp output above"
    test -s "$IVM/build/Release/isolated_vm.node" || fail "isolated_vm.node was not produced"
    native_smoke || fail "a required native binding (isolated-vm/bcrypt/ssh2) does not load"
    ok "native builders ready"
fi

# --- 4c. tsconfig paths store (bun layout vs npm hoisting) -------------------------
# Package-local node_modules entries that bun's layout provides but npm's
# hoisting removes are rebuilt as links, with every tsconfig paths mapping
# verified resolvable — grep-greenlight in scripts/debian-tsconfig-paths.cjs.
log "tsconfig paths store (rebuild package-local node_modules links)"
node "$ROOT/scripts/debian-tsconfig-paths.cjs" "$SRC"
test $? -eq 0 || fail "tsconfig paths store repair failed"
ok "tsconfig paths ready"

# --- 5. build --------------------------------------------------------------------
log "npx turbo build (web, engine, api, worker, all bundled qadams)"
(cd "$SRC" && npx turbo run build --filter=web --filter=@aiqadam/engine --filter=api \
    --filter=worker --filter='@aiqadam/qadam-*')
test -f "$SRC/packages/server/api/dist/src/bootstrap.js"     || fail "api build output missing"
test -f "$SRC/packages/server/worker/dist/src/bootstrap.js"  || fail "worker build output missing"
test -d "$SRC/dist/packages/web"                             || fail "web build output missing"
test -d "$SRC/dist/packages/engine"                          || fail "engine build output missing"
ok "builds verified"

# --- 6. manifests (exact Dockerfile commands) -------------------------------------
(cd "$SRC" && npx tsx packages/server/engine/src/scripts/write-qadam-dist-index.ts packages/qadams)
test -s "$SRC/packages/qadams/dist-index.json" || fail "dist-index.json was not written"

(cd "$SRC" && node -e "\
  const {getMigrations} = require('./packages/server/api/dist/src/app/database/postgres-connection');\
  const names = getMigrations().map(M => new M().name);\
  process.stdout.write(JSON.stringify(names));\
" > packages/server/api/dist/src/migration-manifest.json)
test -s "$SRC/packages/server/api/dist/src/migration-manifest.json" || fail "migration-manifest.json was not written"

(cd "$SRC" && node packages/server/api/dist/src/scripts/write-bundled-qadams-manifest.js packages/qadams)
test -s "$SRC/packages/qadams/bundled-qadams-metadata.json" || fail "bundled-qadams-metadata.json was not written"
ok "manifests ready"

# --- 7. payload manifests ----------------------------------------------------------
# The .deb ships the repo's OWN manifests (bun-canonical workspace:*): copy
# them verbatim over the derived ones left inside the copy before staging,
# then byte-verify every one of them (tracked package.json files only —
# node_modules/dist trees hold thousands of vendored package.jsons).
log "restoring repo manifests over the copy (payload ships workspace:* specs)"
cp -f "$ROOT/package.json" "$SRC/package.json"
# the derived .npmrc carried the npm-only allow-scripts approvals; the payload
# ships the repo's own one (the ${NPM_TOKEN} interpolation form)
cp -f "$ROOT/.npmrc" "$SRC/.npmrc"
cmp -s "$ROOT/.npmrc" "$SRC/.npmrc" || fail "payload .npmrc differs from the repo"
(cd "$ROOT" && find packages \( -path '*/node_modules/*' -o -path '*/dist/*' \) -prune \
    -o -name 'package.json' -type f -print0) \
    | while IFS= read -r -d '' f; do
        cp -f "$ROOT/$f" "$SRC/$f" \
            || { echo "payload manifest restore failed: $f" >&2; exit 1; }
        cmp -s "$ROOT/$f" "$SRC/$f" \
            || { echo "payload manifest differs from the repo: $f" >&2; exit 1; }
    done \
    || fail "payload manifest restore failed"

# --- 8. stage ----------------------------------------------------------------------
STAGE="$SRC/debian/prebuild/usr"
TREE="$STAGE/lib/qadam-flow"
log "staging payload into build/source/debian/prebuild/usr"
rm -rf "$SRC/debian/prebuild"
mkdir -p "$TREE" "$STAGE/share/qadam-flow" "$STAGE/local/etc"

cp -a "$SRC/node_modules" "$TREE/node_modules"
cp -a "$SRC/packages" "$TREE/packages"
# dist ships WITHOUT the web build — Debian FHS puts the frontend under
# /usr/share/qadam-flow/web and dh_link symlinks dist/packages/web to it.
cp -a "$SRC/dist" "$TREE/dist"
rm -rf "$TREE/dist/packages/web"
cp -a "$SRC/dist/packages/web" "$STAGE/share/qadam-flow/web"

for f in package.json bun.lock bunfig.toml .npmrc LICENSE NOTICE; do
    test -f "$SRC/$f" || fail "root file missing in the copy: $f"
    install -m 0644 "$SRC/$f" "$TREE/$f"
done

# Docker ships the sandbox config file itself at /usr/local/etc/isolate (the
# isolate binary's compiled-in config path; see debian/rules'
# override_dh_usrlocal for why dh can't handle this one natively). install is
# used instead of cp so the staged shape cannot depend on whether the target
# path happens to exist: the copy must always be this one FILE, named this way.
install -m 0644 "$SRC/packages/server/api/src/assets/default.cf" "$STAGE/local/etc/isolate"

# Close the loop: the tree debian/rules expects is reachable and complete.
test -f "$STAGE/lib/qadam-flow/packages/server/api/dist/src/bootstrap.js" \
    || fail "staged tree incomplete (bootstrap.js missing)"

ok "staged $(du -sh "$SRC/debian/prebuild" | cut -f1) under build/source/debian/prebuild"
echo
echo "Next:"
echo "  bash build-deb.sh  — dpkg-buildpackage + artifact assembly + lintian"
