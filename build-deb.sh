#!/bin/bash
# =============================================================================
# qadam-flow — one-shot .deb build driver (repo-root entrypoint)
# =============================================================================
# Composes the full local chain, one command:
#
#     bash build-deb.sh [--fresh|--resume] [DEB_VERSION]
#
#     --fresh (default)  clean-room build: build/ is wiped, every phase runs
#     --resume           iteration mode: build/.phase stamps + input hashes
#                        let the prebuild skip derive/lock/ci/native when
#                        their inputs are unchanged (a source-only fix then
#                        relaunches in minutes instead of half an hour)
#
#     1. bash scripts/debian-prebuild.sh   (copy-out: the npm/npx toolchain
#        runs inside build/source, the repo tree is never written)
#     2. IF DEB_VERSION is given — the buildbot path is exactly this —
#        rewrite the COPY'S debian/changelog top entry to it. python3, not
#        dch: dch spawns an editor and dies without a TTY.
#     3. dpkg-buildpackage -us -uc -b, inside build/source
#        (--buildsystem=none: it only packs the prebuilt stage).
#     4. Assemble every artifact (3 .deb + .changes/.buildinfo) into build/deb.
#     5. lintian --fail-on "${LINTIAN_FAIL_ON:-error}" on the produced .debs.
#
# Environment pass-through (all optional):
#     REFRESH_LOCK=1    the prebuild regenerates package-lock.json into
#                       build/package-lock.json — commit it to the repo root,
#                       see the header of scripts/debian-prebuild.sh
#     DEBSIGN_KEYID     pass-through to dpkg-buildpackage (empty = unsigned;
#                       the aptly publish endpoint signs the RELEASE files)
#     LINTIAN_FAIL_ON   error (default) | warning | info | none
#
# The bootstrap order is manual by design (see debian/README.md "Build model
# copy-out"); the lock commit is a git operation and stays yours:
#     REFRESH_LOCK=1 bash build-deb.sh
#     cp build/package-lock.json package-lock.json && git add package-lock.json
#     bash build-deb.sh            <- from then on the committed lock is used
# =============================================================================

set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
BUILD="$ROOT/build"
SRC="$BUILD/source"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
log()  { echo -e "${CYAN}[DEB]${NC} $1"; }
fail() { echo -e "${RED}[FATAL]${NC} $1" >&2; exit 1; }

# --- 0. arguments ----------------------------------------------------------------
# At most one positional: the DEB version (e.g. 1.1.0~stable.b7). With none,
# the changelog keeps its committed top version — a plain local build.
# --fresh/--resume pick the prebuild's run mode (mutually exclusive); the
# env knobs (REFRESH_LOCK/DEBSIGN_KEYID/LINTIAN_FAIL_ON) are unchanged.
MODE=fresh
POSITIONALS=()
FRESH_SEEN=0
RESUME_SEEN=0
for arg in "$@"; do
    case "$arg" in
        --fresh)           FRESH_SEEN=$((FRESH_SEEN + 1)); ;;
        --resume)          RESUME_SEEN=$((RESUME_SEEN + 1)); ;;
        ''|*[[:space:]]*)  fail "usage: build-deb.sh [--fresh|--resume] [DEB_VERSION] — '$arg' is empty/whitespace"; ;;
        *)                 POSITIONALS+=("$arg"); ;;
    esac
done
[ $((FRESH_SEEN + RESUME_SEEN)) -le 1 ] \
    || fail "usage: build-deb.sh [--fresh|--resume] [DEB_VERSION] — --fresh and --resume are mutually exclusive"
[ "${#POSITIONALS[@]}" -le 1 ] \
    || fail "usage: build-deb.sh [--fresh|--resume] [DEB_VERSION] — at most one DEB_VERSION positional"
[ "$RESUME_SEEN" -eq 1 ] && MODE=resume
export DEB_BUILD_MODE="$MODE"

command -v dpkg-buildpackage >/dev/null || fail "dpkg-buildpackage is not installed"
command -v lintian           >/dev/null || fail "lintian is not installed"
test -f "$ROOT/scripts/debian-prebuild.sh" || fail "scripts/debian-prebuild.sh missing"
cd "$ROOT"

# --- 1. prebuild -------------------------------------------------------------------
log "prebuild: copy-out toolchain into build/source (repo tree untouched)"
bash scripts/debian-prebuild.sh

# --- 2. changelog rewrite — ONLY the copy ------------------------------------------
# The repo's debian/changelog keeps its committed base version; the rewrite
# must come AFTER the prebuild's copy-out (which re-copies the repo one).
if [ "${#POSITIONALS[@]}" -eq 1 ]; then
    log "rewriting build/source/debian/changelog top entry -> ${POSITIONALS[0]}"
    python3 - "$SRC/debian/changelog" "${POSITIONALS[0]}" <<'PY'
import re, sys
path, ver = sys.argv[1], sys.argv[2]
with open(path) as fh:
    lines = fh.readlines()
if not lines:
    sys.exit(f"{path}: empty changelog")
m = re.match(r'^(\S+ \()[^)]+(\)[^\n]*)$', lines[0])
if not m:
    sys.exit(f"{path}: unexpected changelog top entry: {lines[0]!r}")
# lambda (not a r'\g<1>...' replacement) so the version is used literally —
# no backslash/g-escape interpretation of the passed string
lines[0] = m.group(1) + ver + m.group(2) + ("\n" if lines[0].endswith("\n") else "")
with open(path, 'w') as fh:
    fh.writelines(lines)
print("updated", path, "->", ver)
PY
fi

# --- 3. dpkg-buildpackage -------------------------------------------------------------
log "dpkg-buildpackage -us -uc -b (inside build/source)"
( cd "$SRC" && dpkg-buildpackage -us -uc -b )

# --- 4. assemble the artifacts ---------------------------------------------------------
# dpkg-buildpackage drops everything into the parent of build/source = build/;
# move the whole family (3 .deb + .changes + .buildinfo) into build/deb. The
# glob needs [-_]: the master artifacts are `qadam-flow_<v>_<arch>.*` but the
# sub-debs are `qadam-flow-common_...` / `qadam-flow-worker_...` (underscore
# only matches the master's).
log "moving artifacts into build/deb"
mkdir -p "$BUILD/deb"
for f in "$BUILD"/qadam-flow[-_]*; do
    test -e "$f" || fail "no qadam-flow[-_]* artifacts in $BUILD — nothing was built?"
    mv -f "$f" "$BUILD/deb/"
done
DEBCOUNT=$(find "$BUILD/deb" -maxdepth 1 -name '*.deb' | wc -l)
[ "$DEBCOUNT" -eq 3 ] || fail "expected exactly 3 binary debs in build/deb, got $DEBCOUNT"

# --- 5. lintian --------------------------------------------------------------------------
# lintian unpacks the payload into its pool under TMPDIR; /tmp is a small
# tmpfs on many hosts and the 317MB common deb alone unpacks to ~1.5G —
# observed "No space left on device" mid-run — so the pool is pinned into
# the build tree (real disk) and dropped after the check.
log "lintian --fail-on ${LINTIAN_FAIL_ON:-error}"
mkdir -p "$BUILD/tmp"
TMPDIR="$BUILD/tmp" lintian --fail-on "${LINTIAN_FAIL_ON:-error}" "$BUILD"/deb/*.deb
rc=$?
rm -rf "$BUILD/tmp"
[ "$rc" -eq 0 ] || fail "lintian failed (rc=$rc)"

ok "done — artifacts in build/deb:"
ls -la "$BUILD/deb"
