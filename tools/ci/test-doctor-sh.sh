#!/usr/bin/env bash
#
# Tests for doctor.sh — the diagnostic users run when their install is broken.
#
# The parts exercised here are the ones that decide what a user is told, and
# they are testable with no docker and no stack: argument handling, .env parsing
# and the verdicts drawn from it, the pass/warn/fail arithmetic that becomes the
# exit code, and the no-colour path.
#
# One case is worth calling out. doctor.sh's output is meant to be pasted into a
# GitHub issue, so "reports secrets by presence and shape, never by value" is a
# hard requirement rather than a nicety — and it is the kind of requirement that
# a later well-meaning edit ("print the value so they can check it") silently
# repeals. The `secrets` block below fails if any fixture secret appears in the
# output at all.
#
# The stack-dependent checks (workers, version gate, postgres/redis
# reachability) cannot run here: they need a live compose project. They were
# validated by hand against a real stack with induced failures — see the PR that
# introduced this file.
#
# Run from the `Lint + Unit Tests` job, which is unconditional, so this can
# never be skipped by the docs-only path filter. Pure shell, no install needed.
#
#   tools/ci/test-doctor-sh.sh
#
# The subject is POSIX sh, so each case is driven through `dash` when available
# rather than bash — the interpreter `curl … | sh` actually gets on Debian and
# Ubuntu hosts. Every case runs under `timeout`, so a regression that hangs
# fails the job instead of stalling it for six hours.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
doctorsh="${here}/../../doctor.sh"

sut="$(command -v dash || command -v sh)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

CASE_TIMEOUT=30

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

ok() { pass=$((pass + 1)); }

# run_sut <sh snippet> [args...] — sources doctor.sh, then runs the snippet.
# Stdout, stderr and status land in $out, $errout, $status.
run_sut() {
  snippet="$1"
  shift
  out="$(timeout "$CASE_TIMEOUT" "$sut" -c "
    . \"\$1\"
    shift
    $snippet
  " _ "$doctorsh" "$@" 2>"$tmp/.stderr")"
  status=$?
  errout="$(cat "$tmp/.stderr")"
  if [ "$status" -eq 124 ]; then
    fail_case "a case timed out after ${CASE_TIMEOUT}s — doctor.sh hangs" "snippet: $snippet"
  fi
}

expect_status() {
  if [ "$status" = "$1" ]; then ok; else fail_case "$2" "want status $1, got $status" "output: $out" "stderr: $errout"; fi
}

expect_out() {
  if printf '%s' "$out" | grep -qF -- "$1"; then ok; else fail_case "$2" "expected stdout to contain '$1'" "actual: $out"; fi
}

expect_not_out() {
  if printf '%s' "$out" | grep -qF -- "$1"; then fail_case "$2" "did not expect '$1' in stdout" "actual: $out"; else ok; fi
}

# ---------------------------------------------------------------------------
echo "== the script is sourceable without doing anything =="
# Every case below depends on this: with QADAM_FLOW_SOURCE_ONLY=1 the file must
# define its helpers and stop, never reaching docker.
run_sut 'printf "SOURCED\n"'
expect_status 0 'sourcing doctor.sh must not run main()'
expect_out SOURCED 'sourcing doctor.sh must not run main()'

if ! grep -q 'QADAM_FLOW_SOURCE_ONLY' "$doctorsh"; then
  fail_case 'doctor.sh must keep the QADAM_FLOW_SOURCE_ONLY guard'
else
  ok
fi

# ---------------------------------------------------------------------------
echo "== argument handling =="

for helpflag in -h --help; do
  out="$(env -u QADAM_FLOW_SOURCE_ONLY timeout "$CASE_TIMEOUT" "$sut" "$doctorsh" "$helpflag" 2>&1)"
  status=$?
  expect_status 0 "$helpflag must exit 0"
  expect_out 'Usage: doctor.sh' "$helpflag must print usage"
  expect_out 'Exit codes' "$helpflag must document the exit codes"
done

out="$(env -u QADAM_FLOW_SOURCE_ONLY timeout "$CASE_TIMEOUT" "$sut" "$doctorsh" --wat 2>&1)"
status=$?
expect_status 2 'an unknown argument must exit 2, not run a diagnosis'
expect_out 'unknown argument: --wat' 'an unknown argument must name itself'

# The help path must not require an install directory — it is what a confused
# user reaches for first, and preflight would die before printing anything.
out="$(env -u QADAM_FLOW_SOURCE_ONLY QADAM_FLOW_DIR=/nonexistent-install \
  timeout "$CASE_TIMEOUT" "$sut" "$doctorsh" --help 2>&1)"
status=$?
expect_status 0 '--help must work with no install directory'
expect_out 'Usage: doctor.sh' '--help must print usage with no install directory'

# ---------------------------------------------------------------------------
echo "== .env parsing =="

mkdir -p "$tmp/crlf"
printf 'AP_JWT_SECRET=abc\r\nAP_ENVIRONMENT=prod\r\n' > "$tmp/crlf/.env"
run_sut 'cd "$1" || exit 1; printf "[%s]\n" "$(env_value AP_ENVIRONMENT)"' "$tmp/crlf"
expect_out '[prod]' 'CRLF: the carriage return must be stripped'

mkdir -p "$tmp/dup"
printf 'AP_ENVIRONMENT=dev\nAP_ENVIRONMENT=prod\n' > "$tmp/dup/.env"
run_sut 'cd "$1" || exit 1; printf "[%s]\n" "$(env_value AP_ENVIRONMENT)"' "$tmp/dup"
expect_out '[prod]' 'duplicate keys: the last assignment wins, as docker compose reads it'

mkdir -p "$tmp/nonl"
printf 'AP_ENVIRONMENT=prod' > "$tmp/nonl/.env"
run_sut 'cd "$1" || exit 1; printf "[%s]\n" "$(env_value AP_ENVIRONMENT)"' "$tmp/nonl"
expect_out '[prod]' 'a file with no trailing newline is still read'

mkdir -p "$tmp/noenv"
run_sut 'cd "$1" || exit 1; printf "[%s]\n" "$(env_value AP_ENVIRONMENT)"; printf "ALIVE\n"' "$tmp/noenv"
expect_out '[]' 'a missing .env yields an empty value'
expect_out ALIVE 'a missing .env must not abort under set -e'

# A key that is a prefix of another must not be confused for it.
mkdir -p "$tmp/prefix"
printf 'AP_POSTGRES_PASSWORD=real\nAP_POSTGRES_PASSWORD_FILE=/run/secret\n' > "$tmp/prefix/.env"
run_sut 'cd "$1" || exit 1; printf "[%s]\n" "$(env_value AP_POSTGRES_PASSWORD)"' "$tmp/prefix"
expect_out '[real]' 'AP_POSTGRES_PASSWORD must not pick up AP_POSTGRES_PASSWORD_FILE'

# ---------------------------------------------------------------------------
echo "== shape helpers =="

for placeholder in change-me CHANGE-ME changeme secret password your-secret todo xxx '' 00000000000000000000000000000000; do
  run_sut 'is_placeholder "$1" && printf "YES\n" || printf "NO\n"' "$placeholder"
  expect_out YES "'$placeholder' must be recognised as a placeholder"
done
for real in 53a64aa75e86b9dda31273614c1ba27d s3cr3t-but-real hunter2xyzzy; do
  run_sut 'is_placeholder "$1" && printf "YES\n" || printf "NO\n"' "$real"
  expect_out NO "'$real' must not be flagged as a placeholder"
done

# Mirrors the app's own gate: system-validator.ts tests /^[A-Za-z0-9]{32}$/ and
# refuses to boot otherwise, so the doctor must draw the line in the same place.
run_sut 'is_encryption_key_shape "$1" && printf "YES\n" || printf "NO\n"' 53a64aa75e86b9dda31273614c1ba27d
expect_out YES 'a 32-char alphanumeric encryption key is accepted'
for badkey in 53a64aa75e86b9dda31273614c1ba27 53a64aa75e86b9dda31273614c1ba27dd '53a64aa7-5e86-b9dd-a3127361' ''; do
  run_sut 'is_encryption_key_shape "$1" && printf "YES\n" || printf "NO\n"' "$badkey"
  expect_out NO "encryption key '$badkey' must be rejected"
done

run_sut 'str_gt "$1" "$2" && printf "YES\n" || printf "NO\n"' 2026-07-27T23:14:39 2026-07-27T23:12:39
expect_out YES 'str_gt: a later ISO stamp is greater'
run_sut 'str_gt "$1" "$2" && printf "YES\n" || printf "NO\n"' 2026-07-27T23:12:39 2026-07-27T23:14:39
expect_out NO 'str_gt: an earlier ISO stamp is not greater'
run_sut 'str_gt "$1" "$2" && printf "YES\n" || printf "NO\n"' 2026-07-27T23:14:39 2026-07-27T23:14:39
expect_out NO 'str_gt: equal stamps are not greater'
# Year and month rollovers are where a lexicographic comparison would break if
# the stamps were ever reformatted to something unpadded.
run_sut 'str_gt "$1" "$2" && printf "YES\n" || printf "NO\n"' 2027-01-01T00:00:00 2026-12-31T23:59:59
expect_out YES 'str_gt: a year rollover compares correctly'

run_sut 'num_lt "$1" "$2" && printf "YES\n" || printf "NO\n"' 4 15
expect_out YES 'num_lt: 4 < 15'
run_sut 'num_lt "$1" "$2" && printf "YES\n" || printf "NO\n"' 4 4
expect_out NO 'num_lt: 4 is not < 4'
# The whole point of using awk rather than `[ -lt ]`: restart counts arrive as
# strings from docker inspect and must compare as numbers, not as text.
run_sut 'num_lt "$1" "$2" && printf "YES\n" || printf "NO\n"' 9 10
expect_out YES 'num_lt: 9 < 10 numerically, not lexicographically'

# ---------------------------------------------------------------------------
echo "== exit-code arithmetic: warnings must not fail the run =="

run_sut 'PASS_COUNT=5 WARN_COUNT=0 FAIL_COUNT=0; exit_code && printf "ZERO\n" || printf "NONZERO\n"'
expect_out ZERO 'all-pass exits 0'
run_sut 'PASS_COUNT=5 WARN_COUNT=3 FAIL_COUNT=0; exit_code && printf "ZERO\n" || printf "NONZERO\n"'
expect_out ZERO 'warnings alone must not fail the run'
run_sut 'PASS_COUNT=5 WARN_COUNT=3 FAIL_COUNT=1; exit_code && printf "ZERO\n" || printf "NONZERO\n"'
expect_out NONZERO 'a single failure fails the run'

# The recorders are what feed those counters; a check that reports FAIL but
# forgets to increment would exit 0 on a broken install.
run_sut 'bad x "m" >/dev/null; soft y "m" >/dev/null; pass z "m" >/dev/null; skip w "m" >/dev/null; printf "%s %s %s %s\n" "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT" "$SKIP_COUNT"'
expect_out '1 1 1 1' 'each recorder increments exactly its own counter'

# A failure the reader cannot act on is the state doctor.sh exists to end.
run_sut 'bad workers "it is broken" "docker compose logs worker"'
expect_out '→ docker compose logs worker' 'a failure prints its next command'

# ---------------------------------------------------------------------------
echo "== check_env verdicts =="

good_env() {
  cat <<'ENV'
QADAM_FLOW_PORT=8080
AP_ENVIRONMENT=prod
AP_FRONTEND_URL=http://localhost:8080
AP_DB_TYPE=POSTGRES
AP_POSTGRES_PASSWORD=46cddbf6d445019c08362562
AP_REDIS_TYPE=STANDALONE
AP_ENCRYPTION_KEY=53a64aa75e86b9dda31273614c1ba27d
AP_JWT_SECRET=3ce00e10ba5075b63d0149e4583c71a5cb66b15f87c384042db8a5910c865716
ENV
}

# mk_env <name> ; .env content on stdin. Deliberately split from env_case: a
# function on the right of a pipe runs in a subshell, so the $out/$status it set
# would never reach the assertions — 27 cases "passed" against a stale $out
# before this was split.
mk_env() {
  work="$tmp/env-$1"
  mkdir -p "$work"
  cat > "$work/.env"
  chmod 600 "$work/.env"
}

# env_case <name> <port> — runs check_env over the fixture mk_env wrote.
env_case() {
  work="$tmp/env-$1"
  run_sut 'cd "$1" || exit 1; PUBLISHED_PORT=$2; check_env; printf "COUNTS %s %s %s\n" "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT"' "$work" "$2"
}

good_env | mk_env good
env_case good 8080
expect_out 'PASS  env' 'a healthy .env passes'
expect_out 'COUNTS 1 0 0' 'a healthy .env produces no warnings and no failures'

good_env | sed 's/^AP_ENCRYPTION_KEY=.*/AP_ENCRYPTION_KEY=change-me/' | mk_env placeholder-key
env_case placeholder-key 8080
expect_out 'FAIL  env' 'a placeholder encryption key fails'
expect_out 'placeholder' 'a placeholder encryption key says so'

good_env | sed 's/^AP_ENCRYPTION_KEY=.*/AP_ENCRYPTION_KEY=53a64aa75e86b9dda31273614c1ba27/' | mk_env short-key
env_case short-key 8080
expect_out 'FAIL  env' 'a 31-character encryption key fails, as the app itself would'
expect_out 'exactly 32 alphanumerics' 'the encryption-key failure states the rule'

good_env | sed '/^AP_ENCRYPTION_KEY=/d' | mk_env missing-key
env_case missing-key 8080
expect_out 'AP_ENCRYPTION_KEY is missing' 'a missing encryption key is named'

good_env | sed '/^AP_JWT_SECRET=/d' | mk_env missing-jwt
env_case missing-jwt 8080
expect_out 'AP_JWT_SECRET is missing' 'a missing jwt secret is named'

# The repo's documented footgun: ApEnvironment.TESTING === 'test', while the
# unrelated RunEnvironment.TESTING === 'TESTING'. AP_ENVIRONMENT=TESTING is a
# valid-looking string that silently equals nothing.
good_env | sed 's/^AP_ENVIRONMENT=.*/AP_ENVIRONMENT=TESTING/' | mk_env bad-environment
env_case bad-environment 8080
expect_out 'FAIL  env' 'AP_ENVIRONMENT=TESTING fails'
expect_out 'prod, dev and test' 'the AP_ENVIRONMENT failure lists the valid values'

for goodenv in prod dev test; do
  good_env | sed "s/^AP_ENVIRONMENT=.*/AP_ENVIRONMENT=${goodenv}/" | mk_env "env-${goodenv}"
  env_case "env-${goodenv}" 8080
  expect_out 'COUNTS 1 0 0' "AP_ENVIRONMENT=${goodenv} is accepted"
done

good_env | sed 's/^AP_JWT_SECRET=.*/AP_JWT_SECRET=shortish/' | mk_env weak-jwt
env_case weak-jwt 8080
expect_out 'WARN  env' 'a short jwt secret warns'
expect_not_out 'FAIL  env' 'a short jwt secret does not fail — the app accepts it'

good_env | mk_env port-mismatch
env_case port-mismatch 9000
expect_out 'FAIL  env' 'AP_FRONTEND_URL pointing at an unpublished port fails'
expect_out 'publishes port 9000' 'the port mismatch names the port actually published'

good_env | sed 's|^AP_FRONTEND_URL=.*|AP_FRONTEND_URL=https://flow.example.com|' | mk_env custom-host
env_case custom-host 9000
expect_out 'COUNTS 1 0 0' 'a custom hostname is not compared against the published port'
expect_out 'custom hostname' 'a custom hostname says why it was not checked'

# PGLite has been removed; an old .env carrying it must fail with a message
# that says what to do, not an obscure stack trace from a database connect.
good_env | sed 's/^AP_DB_TYPE=.*/AP_DB_TYPE=PGLITE/' | mk_env pglite
env_case pglite 8080
expect_out 'FAIL  env' 'AP_DB_TYPE=PGLITE is rejected'
expect_out 'PGLite support has been removed' 'the failure says what changed and what to do'

good_env | sed '/^AP_POSTGRES_PASSWORD=/d' | mk_env missing-pg-password
env_case missing-pg-password 8080
expect_out 'FAIL  env' 'POSTGRES without a password fails'

echo "== .env file mode =="

work="$tmp/env-mode"
mkdir -p "$work"
good_env > "$work/.env"
chmod 644 "$work/.env"
run_sut 'cd "$1" || exit 1; PUBLISHED_PORT=8080; check_env; printf "COUNTS %s %s %s\n" "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT"' "$work"
expect_out 'WARN  env' 'a world-readable .env warns'
expect_out 'readable by other users' 'the mode warning says what is wrong'
chmod 600 "$work/.env"
run_sut 'cd "$1" || exit 1; PUBLISHED_PORT=8080; check_env; printf "COUNTS %s %s %s\n" "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT"' "$work"
expect_out 'COUNTS 1 0 0' 'a 0600 .env is not nagged'

# ---------------------------------------------------------------------------
echo "== secrets are reported by presence and shape, never by value =="

# This output is what a user pastes into a public issue. Every branch of
# check_env runs over a fixture whose secrets are recognisable strings, and none
# of them may appear anywhere in stdout or stderr.
secret_enc=aaaabbbbccccddddeeeeffff00001111
secret_jwt=zzzzyyyyxxxxwwwwvvvvuuuuttttssssrrrrqqqqppppoooonnnnmmmm
secret_pg=llllkkkkjjjjiiii
# A distinct value rather than a prefix of $secret_jwt: the short-secret branch
# is the one that has a length to report, so it is the branch most likely to
# grow an "it is only N chars: <value>" edit, and a substring of another fixture
# would not be matched by the leak grep below. (Verified by mutation: printing
# $env_jwt in that warning must turn this block red.)
secret_jwt_weak=qqwwe1r5

for variant in ok badkey badenv weakjwt portmismatch; do
  work="$tmp/secrets-$variant"
  mkdir -p "$work"
  {
    printf 'AP_ENVIRONMENT=prod\n'
    printf 'AP_FRONTEND_URL=http://localhost:8080\n'
    printf 'AP_DB_TYPE=POSTGRES\n'
    printf 'AP_POSTGRES_PASSWORD=%s\n' "$secret_pg"
    case "$variant" in
      badkey)  printf 'AP_ENCRYPTION_KEY=%s\n' "${secret_enc}EXTRA" ;;
      *)       printf 'AP_ENCRYPTION_KEY=%s\n' "$secret_enc" ;;
    esac
    case "$variant" in
      weakjwt) printf 'AP_JWT_SECRET=%s\n' "$secret_jwt_weak" ;;
      *)       printf 'AP_JWT_SECRET=%s\n' "$secret_jwt" ;;
    esac
    case "$variant" in
      badenv) printf 'AP_ENVIRONMENT=TESTING\n' ;;
    esac
  } > "$work/.env"
  chmod 600 "$work/.env"
  case "$variant" in
    portmismatch) probe_port=9999 ;;
    *)            probe_port=8080 ;;
  esac
  run_sut 'cd "$1" || exit 1; PUBLISHED_PORT=$2; check_env' "$work" "$probe_port"
  combined="${out}${errout}"
  for leak in "$secret_enc" "$secret_jwt" "$secret_pg" "$secret_jwt_weak"; do
    if printf '%s' "$combined" | grep -qF -- "$leak"; then
      fail_case "check_env leaked a secret value (variant: $variant)" "output: $combined"
    else
      ok
    fi
  done
done

# ---------------------------------------------------------------------------
echo "== the no-colour path =="

esc="$(printf '\033')"

good_env | mk_env colour-off
env_case colour-off 8080
if printf '%s' "$out" | grep -qF "$esc"; then
  fail_case 'NO_COLOR=1 must produce no escape sequences' "output: $(printf '%s' "$out" | cat -v)"
else
  ok
fi

# Piped output is not a tty, so it must be plain even when NO_COLOR is unset —
# this is the shape every `doctor.sh > report.txt` takes.
work="$tmp/env-colour-tty"
mkdir -p "$work"
good_env > "$work/.env"
chmod 600 "$work/.env"
out="$(env -u NO_COLOR timeout "$CASE_TIMEOUT" "$sut" -c '
  . "$1"
  cd "$2" || exit 1
  PUBLISHED_PORT=8080
  check_env
' _ "$doctorsh" "$work" 2>&1)"
if printf '%s' "$out" | grep -qF "$esc"; then
  fail_case 'a non-tty stdout must produce no escape sequences even without NO_COLOR' "output: $(printf '%s' "$out" | cat -v)"
else
  ok
fi
if printf '%s' "$out" | grep -q 'PASS  env'; then ok; else fail_case 'the non-tty run still has to report' "output: $out"; fi

# ---------------------------------------------------------------------------
echo "== structural: the roster of checks main() runs =="

# Pins the exact set, in order. Removing `check_supervisor` (the pm2 probe, dropped
# once #210 made docker the supervisor) changed no assertion in this file, because
# every check that needs a live stack is unassertable here — a check could be
# deleted and the suite would stay green. This is the assertion that makes the
# roster a deliberate decision instead of a silent one; update it on purpose.
expected_checks='check_env
check_containers
check_restarts
check_api
check_postgres
check_redis
check_workers
check_version
check_queue
check_logs
check_disk'
actual_checks="$(sed -n '/^main() {/,/^}/p' "$doctorsh" | sed -n 's/^  \(check_[a-z_]*\)$/\1/p')"
if [ "$actual_checks" = "$expected_checks" ]; then
  ok
else
  fail_case 'main() runs an unexpected set of checks' \
    "expected:" "$expected_checks" "actual:" "$actual_checks"
fi

# Every check main() calls must exist, and every check_* defined must be called —
# a defined-but-uncalled check is dead code that reads as coverage.
for name in $actual_checks; do
  if grep -q "^${name}() {" "$doctorsh"; then ok; else fail_case "main() calls ${name}, which is not defined"; fi
done
defined_checks="$(sed -n 's/^\(check_[a-z_]*\)() {$/\1/p' "$doctorsh")"
for name in $defined_checks; do
  if printf '%s\n' "$actual_checks" | grep -qx "$name"; then
    ok
  else
    fail_case "${name} is defined but never called from main()"
  fi
done

echo "== structural: ordering main() depends on =="

# check_env compares AP_FRONTEND_URL against PUBLISHED_PORT, which only exists
# after resolve_stack has asked docker what is actually published. Reversed, the
# port check silently compares against an empty string and the most common
# misconfiguration in the tracker stops being detected.
#
# Anchored at ^ deliberately: an unanchored match also hits the name inside a
# comment, which is enough to make a shape-only check pass on a reordered file.
main_body="$(sed -n '/^main() {/,/^}/p' "$doctorsh")"
line_of() { printf '%s\n' "$main_body" | grep -n "^  $1\b" | head -1 | cut -d: -f1; }
resolve_line="$(line_of resolve_stack)"
for after in check_env check_api check_workers; do
  after_line="$(line_of "$after")"
  if [ -n "$resolve_line" ] && [ -n "$after_line" ] && [ "$after_line" -gt "$resolve_line" ]; then
    ok
  else
    fail_case "main(): $after must be called after resolve_stack" \
      "resolve_stack at line $resolve_line, $after at line $after_line"
  fi
done

# load_workers fills WORKER_RECORDS, which both check_workers and check_version
# read. Called late, the version gate silently has nothing to compare.
load_line="$(line_of load_workers)"
for after in check_workers check_version; do
  after_line="$(line_of "$after")"
  if [ -n "$load_line" ] && [ -n "$after_line" ] && [ "$after_line" -gt "$load_line" ]; then
    ok
  else
    fail_case "main(): $after must be called after load_workers" \
      "load_workers at line $load_line, $after at line $after_line"
  fi
done

# check_queue's "jobs waiting and nothing polling" verdict reads FRESH_WORKERS,
# which check_workers computes.
workers_line="$(line_of check_workers)"
queue_line="$(line_of check_queue)"
if [ -n "$workers_line" ] && [ -n "$queue_line" ] && [ "$queue_line" -gt "$workers_line" ]; then
  ok
else
  fail_case 'main(): check_queue must be called after check_workers' \
    "check_workers at line $workers_line, check_queue at line $queue_line"
fi

echo
echo "passed: ${pass}   failed: ${fail}"
if [ "$fail" -ne 0 ]; then
  echo "doctor.sh tests FAILED — a doctor that lies is worse than no doctor."
  exit 1
fi
echo "doctor.sh tests passed (interpreter: ${sut})."
