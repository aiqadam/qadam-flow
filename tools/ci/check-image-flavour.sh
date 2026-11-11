#!/bin/sh
# Smoke-checks a built Qadam Flow image for one flavour (#807, ADR-0003):
#
#   tools/ci/check-image-flavour.sh ghcr.io/aiqadam/qadam-flow:1.2.3-slim slim
#
# `fat` must carry every official qadam's community package on disk; `slim` must carry only the
# core qadams on disk, plus the four community qadams the server itself statically depends on
# (facebook-leads / intercom / slack for app-event-routing's webhook parsing, telegram-bot for the
# long-polling event puller — see the Dockerfile's slim-prune step), and no other community tree.
#
# Neither the qadam-version-store seed nor the catalogue snapshot (#778) is checked here: neither
# image carries one yet (see the Dockerfile's "NOT wired up here" comment, #807).
#
# The image is pulled first, so this also proves the tag resolves to a manifest for this platform.

set -eu

IMAGE=${1:-}
FLAVOUR=${2:-}

case "$FLAVOUR" in
  fat|slim) ;;
  *) echo "usage: check-image-flavour.sh <image> <fat|slim>" >&2; exit 2 ;;
esac
[ -n "$IMAGE" ] || { echo "usage: check-image-flavour.sh <image> <fat|slim>" >&2; exit 2; }

# A PR build is loaded locally and never pushed; a published manifest is pulled. Checking locally
# first keeps the same script usable for both.
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker pull "$IMAGE" >/dev/null
fi

label=$(docker inspect --format '{{ index .Config.Labels "org.aiqadam.qadam-flavour" }}' "$IMAGE")
if [ "$label" != "$FLAVOUR" ]; then
  echo "image-flavour: expected label org.aiqadam.qadam-flavour=${FLAVOUR}, got '${label}'" >&2
  exit 1
fi

SCRIPT=$(cat <<'JS'
const fs = require('node:fs')
const path = require('node:path')

const flavour = process.argv[1]
const root = '/usr/src/app/packages/qadams'

const fail = (message) => {
    console.error(`image-flavour: ${message}`)
    process.exit(1)
}

const qadamDirNames = (dir) => {
    if (!fs.existsSync(dir)) {
        return []
    }
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

// The server's own direct dependencies (Dockerfile, #807, code-quality review) — kept in `:slim`
// even though they're community qadams, because the server process itself requires them to boot.
const ALWAYS_BUNDLED_COMMUNITY = ['facebook-leads', 'intercom', 'slack', 'telegram-bot']

const core = qadamDirNames(path.join(root, 'core')).length
const communityNames = qadamDirNames(path.join(root, 'community'))
const community = communityNames.length
const expected = flavour === 'slim' ? core : core + community

if (core === 0) {
    fail('no core qadams are present')
}
if (flavour === 'slim') {
    const unexpected = communityNames.filter((name) => !ALWAYS_BUNDLED_COMMUNITY.includes(name))
    if (unexpected.length > 0) {
        fail(`the slim image ships unexpected community qadam director(ies): ${unexpected.join(', ')}`)
    }
    const missing = ALWAYS_BUNDLED_COMMUNITY.filter((name) => !communityNames.includes(name))
    if (missing.length > 0) {
        fail(`the slim image is missing the server's own community qadam dependenc(ies): ${missing.join(', ')}`)
    }
}
if (flavour === 'fat' && community === 0) {
    fail('the fat image ships no community qadams')
}

let index
try {
    index = JSON.parse(fs.readFileSync(path.join(seedDir, 'archive-index.json'), 'utf8'))
}
catch (error) {
    fail(`cannot read the store seed index (${error?.code ?? error?.message})`)
}
if (index?.formatVersion !== 1 || !Array.isArray(index.artifacts)) {
    fail('the store seed index is not a version-1 archive index')
}
if (index.artifacts.length !== expected) {
    fail(`the ${flavour} store seed has ${index.artifacts.length} artifact(s), expected ${expected}`)
}
for (const artifact of index.artifacts) {
    if (typeof artifact?.name !== 'string' || typeof artifact?.file !== 'string') {
        fail('the store seed index has an artifact without name or file')
    }
    if (!fs.existsSync(path.join(seedDir, artifact.file))) {
        fail(`the store seed is missing ${artifact.file}`)
    }
}

console.log(`image-flavour: ${flavour} ok (${core} core, ${community} community, ${index.artifacts.length} seed artifacts)`)
JS
)

docker run --rm --network none --entrypoint node "$IMAGE" -e "$SCRIPT" "$FLAVOUR"
