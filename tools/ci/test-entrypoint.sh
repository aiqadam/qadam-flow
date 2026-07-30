#!/usr/bin/env bash
# Exercises docker-entrypoint.sh against a stub `node`, with no image build and
# no running stack. Guards the behaviour #51 was about: a Node process that dies
# must take the container down instead of being restarted in place and hidden,
# and the launcher must refuse to start a half-stack rather than guess.
set -uo pipefail

ENTRYPOINT="${1:-$(cd "$(dirname "$0")/../.." && pwd)/docker-entrypoint.sh}"
[ -x "$ENTRYPOINT" ] || { echo "FAIL: $ENTRYPOINT is not executable"; exit 1; }

# Captured before the stub shadows `node`, so the stub can still syntax-check
# the payload it is handed with the real interpreter.
REAL_NODE="$(command -v node)"
export REAL_NODE
[ -x "$REAL_NODE" ] || { echo 'FAIL: node not found'; exit 1; }

STUB_DIR="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR"' EXIT
mkdir -p "$STUB_DIR/bin"

# `node -e` stands in for the inline token minting; `node <script>` stands in for
# the API or worker process, whose behaviour comes from FAKE_APP / FAKE_WORKER.
cat > "$STUB_DIR/bin/node" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = '-e' ]; then
    case "$2" in
        *jwt.sign*)
            if [ -n "${FAKE_MINT_FAILS:-}" ]; then
                echo 'stub-node: mint failed' >&2
                exit 1
            fi
            # Record what the real node would have been able to see. The secret
            # must arrive through the environment, never on the command line,
            # where anything in the container could read it out of /proc.
            if [ -n "${AP_JWT_SECRET:-}" ] && grep -qa -- "$AP_JWT_SECRET" "/proc/$$/cmdline"; then
                echo 'stub-node: SECRET-ON-ARGV' >&2
            else
                echo 'stub-node: secret-not-on-argv' >&2
            fi
            case "$2" in
                *"algorithm: 'HS256'"*) : ;;
                *) echo 'stub-node: mint payload lost its algorithm' >&2 ;;
            esac
            # The issuer is the one string in the mint payload with no other guard: a typo
            # is valid JS, syntax-checks clean, and takes every worker offline at runtime
            # because the server will not recognise the token. Added with #8, which changed
            # this value — an unguarded rename is exactly how that would ship.
            case "$2" in
                *"issuer: 'qadam-flow'"*) : ;;
                *) echo 'stub-node: mint payload lost its issuer' >&2 ;;
            esac
            case "$2" in
                *"type: 'WORKER'"*) : ;;
                *) echo 'stub-node: mint payload lost its principal type' >&2 ;;
            esac
            # A payload the real node could not run must not read as a mint.
            # It goes through a real .js file: `node --check` reopens the path it
            # is given (so a process substitution's pipe fails) and refuses a
            # file whose extension it does not recognise.
            payload_file="$(mktemp --suffix=.js)"
            printf '%s' "$2" > "$payload_file"
            if ! "$REAL_NODE" --check "$payload_file" 2>/dev/null; then
                rm -f "$payload_file"
                echo 'stub-node: mint payload is not valid JavaScript' >&2
                exit 97
            fi
            rm -f "$payload_file"
            printf 'stub-worker-token'
            exit 0
            ;;
        *) echo "stub-node: unexpected -e payload" >&2; exit 98 ;;
    esac
fi

script="${!#}"
case "$script" in
    *api*)    behaviour="${FAKE_APP:-sleep}"; name=app ;;
    *worker*) behaviour="${FAKE_WORKER:-sleep}"; name=worker ;;
    *)        echo "stub-node: unexpected script $script" >&2; exit 99 ;;
esac

token_state=unset
[ -n "${AP_WORKER_TOKEN:-}" ] && token_state=set
[ "${AP_WORKER_TOKEN:-}" = 'stub-worker-token' ] && token_state=minted
echo "stub-node: ${name} started (AP_CONTAINER_TYPE=${AP_CONTAINER_TYPE:-unset} token=${token_state})"

case "$behaviour" in
    sleep)
        trap 'echo "stub-node: ${name} got SIGTERM"; exit 143' TERM
        while true; do sleep 0.2 & wait $!; done
        ;;
    exit:*)
        sleep "$(echo "$behaviour" | cut -d: -f3)"
        echo "stub-node: ${name} exiting $(echo "$behaviour" | cut -d: -f2)"
        exit "$(echo "$behaviour" | cut -d: -f2)"
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
    if [ "$2" = 'true' ]; then
        echo "PASS  $1"
        PASS=$((PASS + 1))
    else
        echo "FAIL  $1"
        FAIL=$((FAIL + 1))
    fi
}

echo "=== docker-entrypoint.sh ==="
echo "Entrypoint: $ENTRYPOINT"
echo ""

echo "--- an unset AP_CONTAINER_TYPE must not be guessed ---"
out=$(env -u AP_CONTAINER_TYPE timeout 20 "$ENTRYPOINT" 2>&1)
check "unset type exits 1" 1 $?
assert "the error names the valid values" \
    "$(grep -q 'must be APP or WORKER' <<<"$out" && echo true || echo false)"
assert "nothing was started" \
    "$(grep -q 'stub-node' <<<"$out" && echo false || echo true)"

echo "--- the removed WORKER_AND_APP mode is refused, not silently downgraded ---"
out=$(AP_CONTAINER_TYPE=WORKER_AND_APP timeout 20 "$ENTRYPOINT" 2>&1)
check "WORKER_AND_APP exits 1" 1 $?
assert "the error says the mode was removed" \
    "$(grep -q 'WORKER_AND_APP has been removed' <<<"$out" && echo true || echo false)"
assert "the error points at a supported install" \
    "$(grep -q 'docker-compose.yml' <<<"$out" && echo true || echo false)"
assert "no process was started" \
    "$(grep -q 'stub-node' <<<"$out" && echo false || echo true)"

echo "--- an unknown value is refused ---"
AP_CONTAINER_TYPE=NONSENSE timeout 20 "$ENTRYPOINT" >/dev/null 2>&1
check "unknown type exits 1" 1 $?

echo "--- APP mode: a crash propagates ---"
AP_CONTAINER_TYPE=APP FAKE_APP='exit:7:0.2' timeout 20 "$ENTRYPOINT" >/dev/null 2>&1
check "APP crash exit code passes through" 7 $?

echo "--- WORKER mode: a crash propagates ---"
AP_CONTAINER_TYPE=WORKER FAKE_WORKER='exit:9:0.2' timeout 20 "$ENTRYPOINT" >/dev/null 2>&1
check "WORKER crash exit code passes through" 9 $?

echo "--- each mode passes its own container type to the process ---"
out=$(AP_CONTAINER_TYPE=APP FAKE_APP='exit:0:0.2' timeout 20 "$ENTRYPOINT" 2>&1)
assert "the API sees AP_CONTAINER_TYPE=APP" \
    "$(grep -q 'app started (AP_CONTAINER_TYPE=APP' <<<"$out" && echo true || echo false)"
out=$(AP_CONTAINER_TYPE=WORKER FAKE_WORKER='exit:0:0.2' timeout 20 "$ENTRYPOINT" 2>&1)
assert "the worker sees AP_CONTAINER_TYPE=WORKER" \
    "$(grep -q 'worker started (AP_CONTAINER_TYPE=WORKER' <<<"$out" && echo true || echo false)"

echo "--- the worker is given a token minted from AP_JWT_SECRET ---"
out=$(AP_CONTAINER_TYPE=WORKER AP_JWT_SECRET=shhh FAKE_WORKER='exit:0:0.2' timeout 20 "$ENTRYPOINT" 2>&1)
check "WORKER exits cleanly" 0 $?
assert "the worker received a minted token" \
    "$(grep -q 'worker started .*token=minted' <<<"$out" && echo true || echo false)"
assert "the secret never reaches the log" \
    "$(grep -q 'shhh' <<<"$out" && echo false || echo true)"
assert "the secret never reaches the mint process's argv" \
    "$(grep -q 'SECRET-ON-ARGV' <<<"$out" && echo false || echo true)"
assert "the mint still signs an HS256 WORKER token" \
    "$(grep -qE 'mint payload lost its' <<<"$out" && echo false || echo true)"
assert "the mint payload is valid JavaScript" \
    "$(grep -q 'not valid JavaScript' <<<"$out" && echo false || echo true)"

echo "--- a mint that produces nothing must not start a tokenless worker ---"
out=$(AP_CONTAINER_TYPE=WORKER AP_JWT_SECRET=shhh FAKE_MINT_FAILS=1 FAKE_WORKER='sleep' timeout 20 "$ENTRYPOINT" 2>&1)
check "a failed mint exits 1" 1 $?
assert "no worker was started without a token" \
    "$(grep -q 'worker started' <<<"$out" && echo false || echo true)"

echo "--- a preset AP_WORKER_TOKEN is not overwritten ---"
out=$(AP_CONTAINER_TYPE=WORKER AP_WORKER_TOKEN=preset AP_JWT_SECRET=shhh FAKE_WORKER='exit:0:0.2' timeout 20 "$ENTRYPOINT" 2>&1)
assert "the preset token survived" \
    "$(grep -q 'worker started .*token=set' <<<"$out" && echo true || echo false)"

echo "--- SIGTERM reaches the process, because it is exec'd ---"
term_log="$STUB_DIR/term.log"
AP_CONTAINER_TYPE=APP FAKE_APP='sleep' timeout 20 "$ENTRYPOINT" >"$term_log" 2>&1 &
entrypoint_pid=$!
sleep 1
kill -TERM "$entrypoint_pid"
wait "$entrypoint_pid"
check "SIGTERM exits 143" 143 $?
assert "the process actually started, so this log is evidence" \
    "$(grep -q 'stub-node: app started' "$term_log" && echo true || echo false)"
assert "the process handled the signal itself" \
    "$(grep -q 'app got SIGTERM' "$term_log" && echo true || echo false)"

echo ""
echo "=== Results ==="
echo "Passed: $PASS"
echo "Failed: $FAIL"
[ "$FAIL" -eq 0 ]
