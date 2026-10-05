#!/usr/bin/env bash
#
# Build and run the privileged sandbox/SSRF integration test container.
# Requires a local Docker daemon. See packages/server/worker/test/e2e/README.md.

set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
    echo "docker is required to run the sandbox e2e suite. Install Docker Desktop or similar." >&2
    exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCKERFILE="$ROOT/packages/server/worker/test/e2e/Dockerfile"
IMAGE="activepieces-sandbox-e2e:local"

# The Dockerfile uses `RUN --mount=type=cache`, which needs BuildKit and therefore the buildx
# plugin. Detect it up front so a daemon without it fails with an actionable message instead of
# BuildKit's own "buildx component is missing or broken".
if ! docker buildx version >/dev/null 2>&1; then
    echo "docker buildx is required to run the sandbox e2e suite (the Dockerfile uses RUN --mount=type=cache)." >&2
    echo "Install the buildx plugin: https://docs.docker.com/go/buildx/" >&2
    exit 1
fi

echo "=> Building image $IMAGE"
DOCKER_BUILDKIT=1 docker build -f "$DOCKERFILE" -t "$IMAGE" "$ROOT"

echo "=> Running sandbox e2e suite (privileged)"
# --privileged is required because isolate needs CAP_SYS_ADMIN for mount namespaces
# and iptables-lockdown needs CAP_NET_ADMIN. We drop other ambient bits by default.
exec docker run --rm \
    --privileged \
    --network bridge \
    -e E2E_LOG_LEVEL="${E2E_LOG_LEVEL:-warn}" \
    "$IMAGE" "$@"
