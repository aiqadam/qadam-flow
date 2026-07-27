#!/usr/bin/env bash
#
# Tests for run.sh's .env reconciliation (#141).
#
# run.sh is what every new user executes via `curl -fsSL … | sh`, and it had no
# automated coverage at all. The cases below are the .env shapes a real install
# arrives in — pre-fix files with no QADAM_FLOW_PORT line, hand-written files
# with no trailing newline, CRLF files from Windows/WSL editors — each of which
# silently corrupted the file or produced a stack published on one port while
# the app believed it was on another.
#
# Run from the `Lint + Unit Tests` job, which is unconditional, so this can
# never be skipped by the docs-only path filter. Pure shell, no install needed.
#
#   tools/ci/test-run-sh.sh
#
# The subject is POSIX sh, so each case is driven through `dash` when available
# rather than bash — the interpreter `curl … | sh` actually gets on Debian and
# Ubuntu hosts.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
runsh="${here}/../../run.sh"

sut="$(command -v dash || command -v sh)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

export QADAM_FLOW_SOURCE_ONLY=1
export NO_COLOR=1

pass=0
fail=0

fail_case() {
  fail=$((fail + 1))
  printf 'FAIL  %s\n' "$1"
  shift
  for line in "$@"; do
    printf '        %s\n' "$line"
  done
}

# fixture <name> ; .env content on stdin (omit for no .env at all)
fixture() {
  work="$tmp/$1"
  mkdir -p "$work"
  cat > "$work/.env"
}

# drive <name> <explicit:yes|no> <port> — runs reconcile_port over the fixture.
# Leaves: $effective_port, $stdout_log, $stderr_log, $envfile
drive() {
  work="$tmp/$1"
  envfile="$work/.env"
  stdout_log="$work/.stdout"
  stderr_log="$work/.stderr"
  "$sut" -c '
    . "$1"
    cd "$2" || exit 1
    PORT_EXPLICIT=$3
    QADAM_FLOW_PORT=$4
    reconcile_port
    printf "EFFECTIVE_PORT=%s\n" "$QADAM_FLOW_PORT" >&3
  ' _ "$runsh" "$work" "$2" "$3" \
    3>"$work/.port" >"$stdout_log" 2>"$stderr_log"
  effective_port="$(sed -n 's/^EFFECTIVE_PORT=//p' "$work/.port")"
}

expect_port() {
  if [ "$effective_port" = "$1" ]; then
    pass=$((pass + 1))
  else
    fail_case "$2" "want effective port '$1', got '$effective_port'"
  fi
}

expect_env_line() {
  if grep -qxF "$1" "$envfile"; then
    pass=$((pass + 1))
  else
    fail_case "$2" "expected an exact line '$1' in .env" "actual .env:" "$(cat "$envfile")"
  fi
}

expect_no_env_match() {
  if grep -q "$1" "$envfile"; then
    fail_case "$2" "did not expect /$1/ in .env" "actual .env:" "$(cat "$envfile")"
  else
    pass=$((pass + 1))
  fi
}

expect_warn() {
  if grep -qF "$1" "$stderr_log"; then
    pass=$((pass + 1))
  else
    fail_case "$2" "expected a warning containing '$1'" "actual stderr: $(cat "$stderr_log")"
  fi
}

expect_log() {
  if grep -qF "$1" "$stdout_log"; then
    pass=$((pass + 1))
  else
    fail_case "$2" "expected a log line containing '$1'" "actual stdout: $(cat "$stdout_log")"
  fi
}

expect_no_warn() {
  if [ -s "$stderr_log" ]; then
    fail_case "$1" "expected no warning, got: $(cat "$stderr_log")"
  else
    pass=$((pass + 1))
  fi
}

digest() { cksum < "$1" | awk '{print $1 "-" $2}'; }

echo "== finding 1: a .env with no trailing newline must not be corrupted =="

# The append branch is the branch every pre-fix .env takes, and hand-written
# .env files (docs/install/options/docker-compose.mdx tells users to write one)
# routinely lack a final newline.
mkdir -p "$tmp/no-final-newline"
printf 'AP_ENVIRONMENT=prod\nAP_FRONTEND_URL=http://localhost:8080' > "$tmp/no-final-newline/.env"
drive no-final-newline yes 9500
expect_env_line 'QADAM_FLOW_PORT=9500' 'no-final-newline: port line is on its own line'
expect_env_line 'AP_FRONTEND_URL=http://localhost:9500' 'no-final-newline: frontend url intact and repointed'
expect_no_env_match 'localhost:8080QADAM_FLOW_PORT' 'no-final-newline: no glued line'
expect_port 9500 'no-final-newline'

# Same shape, but the appended var is the only write (no AP_FRONTEND_URL to fix).
mkdir -p "$tmp/no-final-newline-bare"
printf 'AP_TELEMETRY_ENABLED=false' > "$tmp/no-final-newline-bare/.env"
drive no-final-newline-bare yes 9001
expect_env_line 'AP_TELEMETRY_ENABLED=false' 'no-final-newline-bare: last original line survives'
expect_env_line 'QADAM_FLOW_PORT=9001' 'no-final-newline-bare: appended on its own line'

# A file that already ends in a newline must not gain a blank line.
fixture final-newline-present <<'ENV'
AP_ENVIRONMENT=prod
ENV
drive final-newline-present yes 9002
if [ "$(grep -c '^$' "$envfile")" = 0 ]; then
  pass=$((pass + 1))
else
  fail_case 'final-newline-present: no spurious blank line' "$(cat -A "$envfile")"
fi

echo "== finding 5: CRLF line endings must not leak into the port =="

# Notepad / a Windows editor on a WSL checkout produces CRLF. An unstripped \r
# ends up in the health-check URL, so the poll can never succeed and the script
# reports a 3-minute timeout on a stack that is actually healthy.
mkdir -p "$tmp/crlf"
printf 'QADAM_FLOW_PORT=9000\r\nAP_FRONTEND_URL=http://localhost:9000\r\n' > "$tmp/crlf/.env"
drive crlf no 8080
expect_port 9000 'crlf: adopted port has no trailing CR'
if [ "$effective_port" = "$(printf '9000\r')" ]; then
  fail_case 'crlf: port must be stripped of CR' 'effective port still carries \r'
fi

echo "== finding 5: a port adopted from .env is validated =="

for bad in abc 0 70000; do
  mkdir -p "$tmp/bad-$bad"
  printf 'QADAM_FLOW_PORT=%s\n' "$bad" > "$tmp/bad-$bad/.env"
  out="$("$sut" -c '
    . "$1"
    cd "$2" || exit 1
    PORT_EXPLICIT=no
    QADAM_FLOW_PORT=8080
    reconcile_port
    validate_port "QADAM_FLOW_PORT in .env"
    echo REACHED_END
  ' _ "$runsh" "$tmp/bad-$bad" 2>&1)"
  status=$?
  if [ "$status" -ne 0 ] && ! printf '%s' "$out" | grep -q REACHED_END; then
    pass=$((pass + 1))
  else
    fail_case "adopted invalid port '$bad' must abort" "status=$status output=$out"
  fi
done

echo "== an explicitly supplied invalid port is rejected =="

for bad in abc 0 70000 -1 '8080 '; do
  out="$("$sut" -c '
    . "$1"
    QADAM_FLOW_PORT=$2
    validate_port
    echo REACHED_END
  ' _ "$runsh" "$bad" 2>&1)"
  status=$?
  if [ "$status" -ne 0 ] && ! printf '%s' "$out" | grep -q REACHED_END; then
    pass=$((pass + 1))
  else
    fail_case "explicit invalid port '$bad' must abort" "status=$status output=$out"
  fi
done

for good in 1 80 8080 9123 65535; do
  if "$sut" -c '. "$1"; QADAM_FLOW_PORT=$2; validate_port' _ "$runsh" "$good" 2>/dev/null; then
    pass=$((pass + 1))
  else
    fail_case "valid port '$good' must be accepted"
  fi
done

echo "== finding 2: rewriting .env must not widen its mode =="

fixture mode <<'ENV'
QADAM_FLOW_PORT=8080
AP_JWT_SECRET=secret
ENV
chmod 600 "$tmp/mode/.env"
before_mode="$(stat -c '%a' "$tmp/mode/.env")"
drive mode yes 9300
after_mode="$(stat -c '%a' "$envfile")"
if [ "$before_mode" = 600 ] && [ "$after_mode" = 600 ]; then
  pass=$((pass + 1))
else
  fail_case 'mode: 0600 .env must stay 0600 across a rewrite' "before=$before_mode after=$after_mode"
fi
if [ -e "$tmp/mode/.env.tmp" ]; then
  fail_case 'mode: no .env.tmp left behind'
else
  pass=$((pass + 1))
fi

echo "== finding 4: reconcile repairs a half-applied state (idempotent) =="

# A hand edit (or a run interrupted between the two writes) that moved the port
# but not the URL must be finished, not skipped by an early return.
fixture half-applied <<'ENV'
QADAM_FLOW_PORT=9500
AP_FRONTEND_URL=http://localhost:8080
ENV
drive half-applied yes 9500
expect_env_line 'QADAM_FLOW_PORT=9500' 'half-applied: port left alone'
expect_env_line 'AP_FRONTEND_URL=http://localhost:9500' 'half-applied: stale url repaired'

# Running the identical command again must change nothing.
first="$(digest "$envfile")"
drive half-applied yes 9500
if [ "$first" = "$(digest "$envfile")" ]; then
  pass=$((pass + 1))
else
  fail_case 'half-applied: second identical run must be a no-op'
fi

echo "== a pre-fix .env is left byte-for-byte alone when no port is requested =="

fixture legacy <<'ENV'
QADAM_FLOW_IMAGE=ghcr.io/aiqadam/qadam-flow:latest
AP_ENVIRONMENT=prod
AP_FRONTEND_URL=http://localhost:8080
AP_POSTGRES_PASSWORD=x
ENV
legacy_digest="$(digest "$tmp/legacy/.env")"
drive legacy no 8080
if [ "$legacy_digest" = "$(digest "$envfile")" ]; then
  pass=$((pass + 1))
else
  fail_case 'legacy: .env must be untouched' "$(cat "$envfile")"
fi
expect_no_env_match 'QADAM_FLOW_PORT' 'legacy: no port line invented'
expect_port 8080 'legacy'
expect_no_warn 'legacy: a consistent pre-fix install is not nagged'

echo "== finding 6: a pre-fix .env whose URL disagrees with 8080 is flagged =="

# The population the removed docs Note created: they hand-edited 8080:80 in the
# compose file (which fetch_compose has always reverted) and set
# AP_FRONTEND_URL=http://localhost:9000. Warn rather than silently moving a
# running stack's published port.
fixture legacy-mismatch <<'ENV'
AP_ENVIRONMENT=prod
AP_FRONTEND_URL=http://localhost:9000
ENV
mismatch_digest="$(digest "$tmp/legacy-mismatch/.env")"
drive legacy-mismatch no 8080
expect_port 8080 'legacy-mismatch: published port is not moved silently'
expect_warn 'QADAM_FLOW_PORT=9000' 'legacy-mismatch: warning names the fix'
if [ "$mismatch_digest" = "$(digest "$envfile")" ]; then
  pass=$((pass + 1))
else
  fail_case 'legacy-mismatch: .env must not be edited on a diagnostic'
fi

echo "== adopt / rewrite / no-op =="

fixture adopt <<'ENV'
QADAM_FLOW_PORT=9123
AP_FRONTEND_URL=http://localhost:9123
ENV
drive adopt no 8080
expect_port 9123 'adopt: .env port wins when nothing was requested'
expect_no_warn 'adopt'

fixture rewrite <<'ENV'
QADAM_FLOW_PORT=9123
AP_FRONTEND_URL=http://localhost:9123
ENV
drive rewrite yes 9999
expect_env_line 'QADAM_FLOW_PORT=9999' 'rewrite: port updated'
expect_env_line 'AP_FRONTEND_URL=http://localhost:9999' 'rewrite: url updated'
expect_port 9999 'rewrite'

fixture noop <<'ENV'
QADAM_FLOW_PORT=9123
AP_FRONTEND_URL=http://localhost:9123
ENV
noop_digest="$(digest "$tmp/noop/.env")"
drive noop yes 9123
if [ "$noop_digest" = "$(digest "$envfile")" ]; then
  pass=$((pass + 1))
else
  fail_case 'noop: re-requesting the current port must not rewrite .env'
fi
expect_no_warn 'noop'

echo "== repointing AP_FRONTEND_URL is announced =="

# The stock shape does not prove the operator did not choose it — http://localhost:3000 is what
# someone running a local proxy would have. Rewriting it is the accepted cost of shape-based
# rewritability, but it must not be silent.
fixture announce <<'ENV'
QADAM_FLOW_PORT=9000
AP_FRONTEND_URL=http://localhost:3000
ENV
drive announce yes 9000
expect_env_line 'AP_FRONTEND_URL=http://localhost:9000' 'announce: url repointed'
expect_log 'repointing AP_FRONTEND_URL from http://localhost:3000' 'announce: the rewrite is logged'

# A no-override run must not reach the rewrite at all, so nothing is logged.
fixture announce-no-override <<'ENV'
QADAM_FLOW_PORT=9000
AP_FRONTEND_URL=http://localhost:3000
ENV
no_override_digest="$(digest "$tmp/announce-no-override/.env")"
drive announce-no-override no 8080
if [ "$no_override_digest" = "$(digest "$envfile")" ]; then
  pass=$((pass + 1))
else
  fail_case 'announce-no-override: a no-override run must not rewrite the url'
fi
if grep -q repointing "$stdout_log"; then
  fail_case 'announce-no-override: nothing to announce' "$(cat "$stdout_log")"
else
  pass=$((pass + 1))
fi

echo "== a freshly generated .env is 0600 whatever the umask =="

# The secrets must never exist on disk world-readable: `: > .env` creates the file
# empty, chmod tightens it, and the heredoc then truncates that same inode.
for mask in 022 077 000; do
  gen_dir="$tmp/genmode-$mask"
  mkdir -p "$gen_dir"
  gen_mode="$("$sut" -c '
    umask "$3"
    . "$1"
    cd "$2" || exit 1
    QADAM_FLOW_PORT=8080
    QADAM_FLOW_IMAGE=test-image
    generate_env >/dev/null
    stat -c "%a" .env
  ' _ "$runsh" "$gen_dir" "$mask" 2>/dev/null)"
  if [ "$gen_mode" = 600 ]; then
    pass=$((pass + 1))
  else
    fail_case "generate_env under umask $mask must produce a 0600 .env" "got mode '$gen_mode'"
  fi
  # And the secrets really are in there, i.e. the mode is not 600 because the write failed.
  if grep -q '^AP_JWT_SECRET=[0-9a-f]\{64\}$' "$gen_dir/.env"; then
    pass=$((pass + 1))
  else
    fail_case "generate_env under umask $mask must still write the secrets"
  fi
done

echo "== a customised AP_FRONTEND_URL survives a port change =="

for url in https://flow.example.com http://flow.example.com:8080 https://abc.ngrok-free.app http://localhost:8080/base; do
  name="custom-$(printf '%s' "$url" | tr -c 'a-zA-Z0-9' '-')"
  mkdir -p "$tmp/$name"
  printf 'QADAM_FLOW_PORT=8080\nAP_FRONTEND_URL=%s\n' "$url" > "$tmp/$name/.env"
  drive "$name" yes 8443
  expect_env_line "AP_FRONTEND_URL=$url" "custom url preserved: $url"
  expect_warn 'customised' "custom url warned: $url"
  expect_env_line 'QADAM_FLOW_PORT=8443' "custom url: port still applied: $url"
done

echo "== an .env with no AP_FRONTEND_URL at all =="

fixture no-url <<'ENV'
AP_TELEMETRY_ENABLED=false
ENV
drive no-url yes 9400
expect_env_line 'QADAM_FLOW_PORT=9400' 'no-url: port appended'
expect_no_warn 'no-url: absent url is not a customisation'

echo "== is_stock_localhost_url =="

stock() {
  if "$sut" -c '. "$1"; is_stock_localhost_url "$2"' _ "$runsh" "$2" 2>/dev/null; then
    got=yes
  else
    got=no
  fi
  if [ "$got" = "$1" ]; then
    pass=$((pass + 1))
  else
    fail_case "is_stock_localhost_url('$2') want=$1 got=$got"
  fi
}

stock yes 'http://localhost:8080'
stock yes 'http://localhost:1'
stock no  'http://localhost:'
stock no  'http://localhost:8080/'
stock no  'http://localhost:80x0'
stock no  'https://localhost:8080'
stock no  'http://127.0.0.1:8080'
stock no  'http://localhost'
stock no  ''
stock no  'http://flow.example.com'

echo "== set_env_value writes exactly one line per key =="

fixture duplicate <<'ENV'
QADAM_FLOW_PORT=8080
AP_FRONTEND_URL=http://localhost:8080
ENV
drive duplicate yes 9600
if [ "$(grep -c '^QADAM_FLOW_PORT=' "$envfile")" = 1 ] \
  && [ "$(grep -c '^AP_FRONTEND_URL=' "$envfile")" = 1 ]; then
  pass=$((pass + 1))
else
  fail_case 'duplicate: each key must appear once' "$(cat "$envfile")"
fi

# A commented-out assignment must not be treated as the live value.
fixture commented <<'ENV'
#QADAM_FLOW_PORT=7000
AP_FRONTEND_URL=http://localhost:8080
ENV
drive commented no 8080
expect_port 8080 'commented: a commented port is not adopted'

echo "== finding 3: the hardcoded-8080 guard fires on an adopted port =="

# An operator on an older QADAM_FLOW_REF gets a compose file that still hardcodes
# 8080:80. When the port comes from .env rather than the environment, the guard
# has to see the adopted value or the stack boots on 8080 while the health check
# polls elsewhere — the exact failure this change exists to remove.
mkdir -p "$tmp/old-compose"
printf 'QADAM_FLOW_PORT=9123\n' > "$tmp/old-compose/.env"
printf "services:\n  app:\n    ports:\n      - '8080:80'\n" > "$tmp/old-compose/docker-compose.yml"
out="$("$sut" -c '
  . "$1"
  cd "$2" || exit 1
  PORT_EXPLICIT=no
  QADAM_FLOW_PORT=8080
  reconcile_port
  check_compose_port
  echo REACHED_END
' _ "$runsh" "$tmp/old-compose" 2>&1)"
if ! printf '%s' "$out" | grep -q REACHED_END && printf '%s' "$out" | grep -q 'hardcodes port 8080'; then
  pass=$((pass + 1))
else
  fail_case 'old-compose: guard must abort on a port adopted from .env' "output=$out"
fi

# A parameterised compose file must pass the same guard.
mkdir -p "$tmp/new-compose"
printf 'QADAM_FLOW_PORT=9123\n' > "$tmp/new-compose/.env"
printf "services:\n  app:\n    ports:\n      - '\${QADAM_FLOW_PORT:-8080}:80'\n" > "$tmp/new-compose/docker-compose.yml"
if "$sut" -c '
  . "$1"
  cd "$2" || exit 1
  PORT_EXPLICIT=no
  QADAM_FLOW_PORT=8080
  reconcile_port
  check_compose_port
' _ "$runsh" "$tmp/new-compose" >/dev/null 2>&1; then
  pass=$((pass + 1))
else
  fail_case 'new-compose: parameterised mapping must satisfy the guard'
fi

# Structural, because the ordering bug lives in main() and main() pulls images.
# reconcile_port can replace QADAM_FLOW_PORT with a value from .env, so anything
# that inspects the port has to run after generate_env, not before it.
#
# The patterns are anchored at ^ deliberately: an unanchored "  $token" also
# matches the token inside a comment, so a comment mentioning both names after
# generate_env was enough to make this check pass on a file with the pre-fix
# order restored. Being the only shape-only check in this file, it has to be the
# least maskable one.
main_body="$(sed -n '/^main() {/,/^}/p' "$runsh")"
line_of() { printf '%s\n' "$main_body" | grep -n "^  $1\b" | head -1 | cut -d: -f1; }
gen_line="$(line_of generate_env)"
for after in validate_port check_compose_port; do
  after_line="$(printf '%s\n' "$main_body" | grep -n "^  $after\b" | tail -1 | cut -d: -f1)"
  if [ -n "$gen_line" ] && [ -n "$after_line" ] && [ "$after_line" -gt "$gen_line" ]; then
    pass=$((pass + 1))
  else
    fail_case "main(): $after must be called after generate_env" \
      "generate_env at line $gen_line, $after at line $after_line"
  fi
done

echo
echo "passed: ${pass}   failed: ${fail}"
if [ "$fail" -ne 0 ]; then
  echo "run.sh tests FAILED — the installer is not trustworthy until this is green."
  exit 1
fi
echo "run.sh tests passed (interpreter: ${sut})."
