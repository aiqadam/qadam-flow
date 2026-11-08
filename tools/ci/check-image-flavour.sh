#!/bin/sh
# Smoke-checks a built Qadam Flow image for one flavour (#807, ADR-0003):
#
#   tools/ci/check-image-flavour.sh ghcr.io/aiqadam/qadam-flow:1.2.3-slim slim
#
# `fat` must carry every official qadam in its store seed and the community packages on disk; `slim`
# must carry only the core qadams and no community tree. Both must carry the catalogue snapshot for
# every official qadam, because the catalogue is generated before the slim prune.
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
const seedDir = path.join(root, 'version-store-seed')
const catalogueDir = path.join(root, 'catalog', 'v1')

const fail = (message) => {
    console.error(`image-flavour: ${message}`)
    process.exit(1)
}

const qadamDirs = (dir) => {
    if (!fs.existsSync(dir)) {
        return 0
    }
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
}

const core = qadamDirs(path.join(root, 'core'))
const community = qadamDirs(path.join(root, 'community'))
const expected = flavour === 'slim' ? core : core + community

if (core === 0) {
    fail('no core qadams are present')
}
if (flavour === 'slim' && community !== 0) {
    fail(`the slim image ships ${community} community qadam director(ies)`)
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

if (!fs.existsSync(path.join(catalogueDir, 'index.json'))) {
    fail('the catalogue snapshot index is missing')
}
const catalogueQadams = qadamDirs(path.join(catalogueDir, 'qadams'))
if (catalogueQadams < core) {
    fail(`the catalogue snapshot covers ${catalogueQadams} qadam(s), fewer than the ${core} core qadams`)
}

console.log(`image-flavour: ${flavour} ok (${core} core, ${community} community, ${index.artifacts.length} seed artifacts, ${catalogueQadams} catalogue qadams)`)
JS
)

docker run --rm --network none --entrypoint node "$IMAGE" -e "$SCRIPT" "$FLAVOUR"
