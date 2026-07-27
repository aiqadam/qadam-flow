#!/usr/bin/env bash
# Exercises docker-entrypoint.sh against a stub `node`, with no image build and
# no running stack. Guards the behaviour #51 was about: a Node process that dies
# must take the container down instead of being restarted in place and hidden.
set -uo pipefail

ENTRYPOINT="${1:-$(cd "$(dirname "$0")/.." && pwd)/docker-entrypoint.sh}"
[ -x "$ENTRYPOINT" ] || { echo "FAIL: $ENTRYPOINT is not executable"; exit 1; }

STUB_DIR="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR"' EXIT
mkdir -p "$STUB_DIR/bin"

# Two roles: `node -e <code>` stands in for the entrypoint's inline helpers
# (token minting, reading the persisted secret), and `node <script>` stands in
# for the app and worker children, driven by FAKE_APP / FAKE_WORKER.
cat > "$STUB_DIR/bin/node" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = '-e' ]; then
    code="$2"
    if [[ "$code" == *'jwt.sign'* ]]; then
        printf 'stub-worker-token'
        exit 0
    fi
    if [[ "$code" == *'settings.json'* ]]; then
        settings="$3/settings.json"
        [ -f "$settings" ] || exit 1
        secret="$(sed -n 's/.*"JWT_SECRET"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$settings")"
        [ -n "$secret" ] || exit 1
        printf '%s' "$secret"
        exit 0
    fi
    echo "stub-node: unexpected -e payload" >&2
    exit 98
fi

script="${!#}"
case "$script" in
    *api*)    behaviour="${FAKE_APP:-sleep}"; name=app ;;
    *worker*) behaviour="${FAKE_WORKER:-sleep}"; name=worker ;;
    *)        echo "stub-node: unexpected script $script" >&2; exit 99 ;;
esac

echo "stub-node: ${name} started (AP_CONTAINER_TYPE=${AP_CONTAINER_TYPE:-unset} AP_WORKER_TOKEN=${AP_WORKER_TOKEN:-unset})"
trap 'echo "stub-node: ${name} got SIGTERM"; exit 143' TERM

case "$behaviour" in
    sleep)
        while true; do sleep 0.2 & wait $!; done
        ;;
    exit:*)
        code="$(echo "$behaviour" | cut -d: -f2)"
        delay="$(echo "$behaviour" | cut -d: -f3)"
        sleep "$delay" & wait $!
        echo "stub-node: ${name} exiting ${code}"
        exit "$code"
        ;;
esac
STUB
chmod +x "$STUB_DIR/bin/node"
export PATH="$STUB_DIR/bin:$PATH"

PASS=0
FAIL=0

check() {
    local name="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        echo "PASS  $name (exit $actual)"
        PASS=$((PASS + 1))
    else
        echo "FAIL  $name (expected exit $expected, got $actual)"
        FAIL=$((FAIL + 1))
    fi
}

assert() {
    local name="$1" condition="$2"
    if [ "$condition" = 'true' ]; then
        echo "PASS  $name"
        PASS=$((PASS + 1))
    else
        echo "FAIL  $name"
        FAIL=$((FAIL + 1))
    fi
}

echo "=== docker-entrypoint.sh supervision ==="
echo "Entrypoint: $ENTRYPOINT"
echo ""

echo "--- unknown AP_CONTAINER_TYPE must refuse to start ---"
AP_CONTAINER_TYPE=NONSENSE "$ENTRYPOINT" >/dev/null 2>&1
check "unknown type exits 1" 1 $?

echo "--- APP mode: a crash propagates ---"
AP_CONTAINER_TYPE=APP FAKE_APP='exit:7:0.2' "$ENTRYPOINT" >/dev/null 2>&1
check "APP crash exit code passes through" 7 $?

echo "--- WORKER mode: a crash propagates ---"
AP_CONTAINER_TYPE=WORKER FAKE_WORKER='exit:9:0.2' "$ENTRYPOINT" >/dev/null 2>&1
check "WORKER crash exit code passes through" 9 $?

echo "--- WORKER_AND_APP: the app dying takes the container down ---"
out=$(AP_WORKER_TOKEN=preset AP_CONTAINER_TYPE=WORKER_AND_APP \
      FAKE_APP='exit:5:0.3' FAKE_WORKER='sleep' "$ENTRYPOINT" 2>&1)
check "app crash brings the container down with its code" 5 $?
assert "the surviving worker was signalled" \
    "$(grep -q 'stub-node: worker got SIGTERM' <<<"$out" && echo true || echo false)"

echo "--- WORKER_AND_APP: the worker dying takes the container down ---"
AP_WORKER_TOKEN=preset AP_CONTAINER_TYPE=WORKER_AND_APP \
    FAKE_APP='sleep' FAKE_WORKER='exit:6:0.3' "$ENTRYPOINT" >/dev/null 2>&1
check "worker crash brings the container down with its code" 6 $?

echo "--- WORKER_AND_APP: a child exiting 0 is still a failure ---"
AP_WORKER_TOKEN=preset AP_CONTAINER_TYPE=WORKER_AND_APP \
    FAKE_APP='exit:0:0.3' FAKE_WORKER='sleep' "$ENTRYPOINT" >/dev/null 2>&1
check "clean child exit still fails the container" 1 $?

echo "--- WORKER_AND_APP: SIGTERM is a graceful stop, not a crash ---"
stop_log="$STUB_DIR/stop.log"
AP_WORKER_TOKEN=preset AP_CONTAINER_TYPE=WORKER_AND_APP \
    FAKE_APP='sleep' FAKE_WORKER='sleep' "$ENTRYPOINT" >"$stop_log" 2>&1 &
entrypoint_pid=$!
sleep 1.5
kill -TERM "$entrypoint_pid"
wait "$entrypoint_pid"
check "SIGTERM exits 0" 0 $?
assert "the children actually started, so this log is evidence" \
    "$(grep -q 'stub-node: app started' "$stop_log" && echo true || echo false)"
assert "a graceful stop did not log FATAL" \
    "$(grep -q 'FATAL' "$stop_log" && echo false || echo true)"
assert "both children were signalled on stop" \
    "$([ "$(grep -c 'got SIGTERM' "$stop_log")" = '2' ] && echo true || echo false)"

echo "--- single container: the worker token comes from the API's persisted secret ---"
config_dir="$STUB_DIR/config"
mkdir -p "$config_dir"
printf '{"ENCRYPTION_KEY":"x","JWT_SECRET":"persisted-secret"}' >"$config_dir/settings.json"
out=$(AP_CONTAINER_TYPE=WORKER_AND_APP AP_CONFIG_PATH="$config_dir" \
      FAKE_APP='sleep' FAKE_WORKER='exit:4:0.2' "$ENTRYPOINT" 2>&1)
check "the worker starts once the secret is readable" 4 $?
assert "the worker received a minted token" \
    "$(grep -q 'worker started .*AP_WORKER_TOKEN=stub-worker-token' <<<"$out" && echo true || echo false)"

echo "--- single container: a secret that never appears fails instead of hanging ---"
empty_dir="$STUB_DIR/empty"
mkdir -p "$empty_dir"
start=$SECONDS
out=$(AP_CONTAINER_TYPE=WORKER_AND_APP AP_CONFIG_PATH="$empty_dir" AP_JWT_SECRET_WAIT_SECONDS=3 \
      FAKE_APP='sleep' FAKE_WORKER='sleep' "$ENTRYPOINT" 2>&1)
rc=$?
elapsed=$((SECONDS - start))
check "gives up instead of hanging" 1 $rc
assert "respected the wait cap (${elapsed}s)" "$([ "$elapsed" -le 8 ] && echo true || echo false)"
assert "said why it gave up" \
    "$(grep -q 'FATAL: no AP_WORKER_TOKEN' <<<"$out" && echo true || echo false)"

echo "--- single container: a dead API ends the wait early ---"
start=$SECONDS
AP_CONTAINER_TYPE=WORKER_AND_APP AP_CONFIG_PATH="$empty_dir" AP_JWT_SECRET_WAIT_SECONDS=60 \
    FAKE_APP='exit:3:1' FAKE_WORKER='sleep' "$ENTRYPOINT" >/dev/null 2>&1
rc=$?
elapsed=$((SECONDS - start))
check "fails when the API is gone" 1 $rc
assert "exited early rather than waiting out the 60s cap (${elapsed}s)" \
    "$([ "$elapsed" -le 10 ] && echo true || echo false)"

echo ""
echo "=== Results ==="
echo "Passed: $PASS"
echo "Failed: $FAIL"
[ "$FAIL" -eq 0 ]
