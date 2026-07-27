#!/bin/bash
# Docker is the process supervisor. One process per container, `exec`ed so it is
# PID 1's only child: a Node process that dies takes the container with it, and
# `restart:` policies, `docker ps` and `docker events` report the crash instead
# of it being restarted in place and hidden from the operator (#51).
set -uo pipefail

APP_SCRIPT='packages/server/api/dist/src/bootstrap.js'
WORKER_SCRIPT='packages/server/worker/dist/src/bootstrap.js'

export AP_PORT="${AP_PORT:-80}"
AP_CONTAINER_TYPE="${AP_CONTAINER_TYPE:-}"

echo "AP_CONTAINER_TYPE: ${AP_CONTAINER_TYPE:-<unset>}"
echo "AP_PORT: $AP_PORT"

if [ -n "${AP_PM2_INSTANCES:-}" ] && [ "${AP_PM2_INSTANCES}" != '1' ]; then
    echo "WARNING: AP_PM2_INSTANCES=${AP_PM2_INSTANCES} is ignored — PM2 is no longer part of this image."
    echo 'WARNING: To use more than one CPU for the API, run several APP containers behind a load balancer.'
fi

# Unset used to mean WORKER_AND_APP, which started both processes in one
# container. Defaulting to APP instead would quietly give an install with no
# worker — the exact silent half-stack this image is being fixed to stop
# producing — so the launcher refuses to guess.
if [ -z "$AP_CONTAINER_TYPE" ] || [ "$AP_CONTAINER_TYPE" = 'WORKER_AND_APP' ]; then
    echo "FATAL: AP_CONTAINER_TYPE must be APP or WORKER (got '${AP_CONTAINER_TYPE:-<unset>}')." >&2
    echo 'FATAL: WORKER_AND_APP has been removed — the API and the worker run as separate containers.' >&2
    echo 'FATAL: Use the bundled docker-compose.yml, or the installer: curl -fsSL https://flow.aiqadam.org/run.sh | sh' >&2
    exit 1
fi

export AP_CONTAINER_TYPE

if [ -z "${AP_WORKER_TOKEN:-}" ] && [ -n "${AP_JWT_SECRET:-}" ]; then
    echo 'Auto-generating AP_WORKER_TOKEN...'
    # Passed as a command-prefix assignment so the secret never reaches argv,
    # where any process in the container could read it out of /proc.
    AP_WORKER_TOKEN=$(AP_JWT_SECRET="$AP_JWT_SECRET" node -e "
        const jwt = require('jsonwebtoken');
        const crypto = require('crypto');
        const token = jwt.sign(
            { id: crypto.randomUUID(), type: 'WORKER' },
            process.env.AP_JWT_SECRET,
            { expiresIn: '100y', keyid: '1', algorithm: 'HS256', issuer: 'activepieces' }
        );
        process.stdout.write(token);
    ")
    # `set -e` is deliberately off here, so a failed mint would otherwise export
    # an empty token and hand the worker a variable that only looks present.
    if [ -z "$AP_WORKER_TOKEN" ]; then
        echo 'FATAL: failed to mint AP_WORKER_TOKEN from AP_JWT_SECRET.' >&2
        exit 1
    fi
    export AP_WORKER_TOKEN
fi

case "$AP_CONTAINER_TYPE" in
    APP)
        echo 'Starting Qadam Flow API (APP mode)'
        exec node --enable-source-maps "$APP_SCRIPT"
        ;;
    WORKER)
        echo 'Starting Qadam Flow worker (WORKER mode)'
        exec node --enable-source-maps "$WORKER_SCRIPT"
        ;;
    *)
        echo "FATAL: unknown AP_CONTAINER_TYPE '${AP_CONTAINER_TYPE}' (expected APP or WORKER)" >&2
        exit 1
        ;;
esac
