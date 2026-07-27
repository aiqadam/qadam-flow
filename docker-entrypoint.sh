#!/bin/bash
# Docker is the process supervisor here. A Node process that dies must take the
# container down with it, so that `restart:` policies, `docker ps` and
# `docker events` surface the crash instead of it being restarted in place and
# hidden from the operator (#51).
set -uo pipefail

export AP_CONTAINER_TYPE="${AP_CONTAINER_TYPE:-WORKER_AND_APP}"
export AP_PORT="${AP_PORT:-80}"

APP_SCRIPT='packages/server/api/dist/src/bootstrap.js'
WORKER_SCRIPT='packages/server/worker/dist/src/bootstrap.js'

APP_PID=''
WORKER_PID=''
STOPPING=0
JWT_SECRET_WAIT_SECONDS="${AP_JWT_SECRET_WAIT_SECONDS:-120}"

echo "AP_CONTAINER_TYPE: $AP_CONTAINER_TYPE"
echo "AP_PORT: $AP_PORT"

if [ -n "${AP_PM2_INSTANCES:-}" ] && [ "${AP_PM2_INSTANCES}" != '1' ]; then
    echo "WARNING: AP_PM2_INSTANCES=${AP_PM2_INSTANCES} is ignored — PM2 is no longer part of this image."
    echo 'WARNING: To use more than one CPU for the API, run several APP containers behind a load balancer.'
fi

mint_worker_token() {
    AP_WORKER_TOKEN=$(AP_JWT_SECRET="$1" node -e "
        const jwt = require('jsonwebtoken');
        const crypto = require('crypto');
        const token = jwt.sign(
            { id: crypto.randomUUID(), type: 'WORKER' },
            process.env.AP_JWT_SECRET,
            { expiresIn: '100y', keyid: '1', algorithm: 'HS256', issuer: 'activepieces' }
        );
        process.stdout.write(token);
    ")
    export AP_WORKER_TOKEN
}

# In single-container mode with no AP_JWT_SECRET in the environment, the API
# generates the secret on first boot and persists it to settings.json under
# AP_CONFIG_PATH — which happens after this script has already started. Read it
# back from there so the worker can be given a token at all; without this the
# worker dies on a required-variable error and only the API survives (#51).
read_persisted_jwt_secret() {
    local config_path="${AP_CONFIG_PATH:-}"
    if [ -z "$config_path" ]; then
        return 1
    fi
    node -e "
        const fs = require('fs');
        const path = require('path');
        try {
            const settings = JSON.parse(fs.readFileSync(path.join(process.argv[1], 'settings.json'), 'utf8'));
            if (typeof settings.JWT_SECRET === 'string' && settings.JWT_SECRET.length > 0) {
                process.stdout.write(settings.JWT_SECRET);
                process.exit(0);
            }
        }
        catch (error) { /* not written yet */ }
        process.exit(1);
    " "$config_path" 2>/dev/null
}

# `kill -0` succeeds against a zombie, so ask /proc for the state instead: once
# the API is dead the secret can never appear and waiting for it is pointless.
app_alive() {
    local state
    state="$(awk '{print $3}' "/proc/${APP_PID}/stat" 2>/dev/null)" || return 1
    [ -n "$state" ] && [ "$state" != 'Z' ]
}

# Bounded on both ends: it gives up after the timeout, and it gives up early if
# the API process is gone.
await_persisted_jwt_secret() {
    local waited=0 secret
    while [ "$waited" -lt "$JWT_SECRET_WAIT_SECONDS" ]; do
        secret="$(read_persisted_jwt_secret)"
        if [ -n "$secret" ]; then
            printf '%s' "$secret"
            return 0
        fi
        if ! app_alive; then
            return 1
        fi
        sleep 1
        waited=$((waited + 1))
    done
    return 1
}

stop_children() {
    STOPPING=1
    kill -TERM "$APP_PID" "$WORKER_PID" 2>/dev/null
}

run_both() {
    local status secret

    # The API child keeps the APP container type PM2 used to hand it, while the
    # worker child inherits WORKER_AND_APP — `system.ts` reads both as "runs a worker".
    AP_CONTAINER_TYPE=APP node --enable-source-maps "$APP_SCRIPT" &
    APP_PID=$!
    trap stop_children TERM INT

    if [ -z "${AP_WORKER_TOKEN:-}" ]; then
        echo 'Waiting for the API to persist its JWT secret before starting the worker...'
        secret="$(await_persisted_jwt_secret)"
        if [ -z "$secret" ] && [ "$STOPPING" -eq 1 ]; then
            wait "$APP_PID" 2>/dev/null
            return 0
        fi
        if [ -z "$secret" ]; then
            echo "FATAL: no AP_WORKER_TOKEN and no JWT secret at \${AP_CONFIG_PATH}/settings.json after ${JWT_SECRET_WAIT_SECONDS}s — the worker cannot start. Set AP_JWT_SECRET (or AP_WORKER_TOKEN) explicitly." >&2
            kill -TERM "$APP_PID" 2>/dev/null
            wait "$APP_PID" 2>/dev/null
            return 1
        fi
        mint_worker_token "$secret"
    fi

    node --enable-source-maps "$WORKER_SCRIPT" &
    WORKER_PID=$!

    status=0
    wait -n || status=$?

    if [ "$STOPPING" -eq 1 ]; then
        wait "$APP_PID" 2>/dev/null
        wait "$WORKER_PID" 2>/dev/null
        return 0
    fi

    echo "FATAL: a Qadam Flow process exited (status ${status}) — stopping the container so Docker can restart it" >&2
    kill -TERM "$APP_PID" "$WORKER_PID" 2>/dev/null
    wait "$APP_PID" 2>/dev/null
    wait "$WORKER_PID" 2>/dev/null

    # A child that dies on its own is a failure even when its status is 0: the
    # container is no longer running everything it was started to run.
    if [ "$status" -eq 0 ]; then
        return 1
    fi
    return "$status"
}

if [ -z "${AP_WORKER_TOKEN:-}" ] && [ -n "${AP_JWT_SECRET:-}" ]; then
    echo 'Auto-generating AP_WORKER_TOKEN...'
    mint_worker_token "$AP_JWT_SECRET"
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
    WORKER_AND_APP)
        echo 'Starting Qadam Flow API and worker (WORKER_AND_APP mode)'
        run_both
        ;;
    *)
        echo "FATAL: unknown AP_CONTAINER_TYPE '${AP_CONTAINER_TYPE}' (expected APP, WORKER or WORKER_AND_APP)" >&2
        exit 1
        ;;
esac
