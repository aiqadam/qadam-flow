#!/bin/sh
# Qadam Flow — install doctor.
#
# Paste this into the shell of the machine running Qadam Flow:
#   curl -fsSL https://flow.aiqadam.org/doctor.sh | sh
#
# It answers one question: is this install actually WORKING, or is it merely
# running? Those are different, and every standard Docker command answers the
# second one. An install whose worker had died stayed `Up`, kept a RestartCount
# of 0, and served `GET /api/v1/flags` with a 200 for as long as anyone cared to
# look — while no flow ever executed. So the rule this script is built on:
#
#   a check that can only report "up" is worthless — every check here has to be
#   able to tell "running" from "doing its job".
#
# It is strictly read-only: it starts nothing, stops nothing, and writes nothing
# (including to .env). Everything it prints is safe to paste into a GitHub issue
# — secrets are reported by presence and shape only, never by value.
#
# Exit codes:
#   0  everything material passed (warnings do not fail the run)
#   1  at least one check FAILed — the install is broken
#   2  the doctor could not run at all (no docker, no install directory, ...)
#
# Environment overrides:
#   QADAM_FLOW_DIR                  — install directory (default: ./qadam-flow)
#   QADAM_FLOW_WORKER_STALE_SECONDS — how long a worker may go without polling
#                                     before it counts as stalled (default: 120)
#
# Targets: macOS (Docker Desktop), Linux (dockerd), Windows via WSL2.
# Scope: the docker compose stack that run.sh installs. The single-container
# `docker run` install from the docs is not a compose project, so `docker
# compose` cannot address it and this script refuses rather than guessing.

set -eu

# ---------- colors -----------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_TEAL=$(printf '\033[38;5;37m')
  C_BOLD=$(printf '\033[1m')
  C_DIM=$(printf '\033[2m')
  C_RED=$(printf '\033[31m')
  C_YELLOW=$(printf '\033[33m')
  C_GREEN=$(printf '\033[32m')
  C_RESET=$(printf '\033[0m')
else
  C_TEAL=''; C_BOLD=''; C_DIM=''; C_RED=''; C_YELLOW=''; C_GREEN=''; C_RESET=''
fi

log()  { printf '%s▸%s %s\n' "$C_TEAL"   "$C_RESET" "$1"; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$1" >&2; }
err()  { printf '%s✗%s %s\n' "$C_RED"    "$C_RESET" "$1" >&2; }
die()  { err "$1"; exit 2; }

# ---------- defaults ---------------------------------------------------------

QADAM_FLOW_DIR=${QADAM_FLOW_DIR:-qadam-flow}

# The app prunes a worker from its own registry after 60s without contact, and an
# idle poll round-trip is a 50s long-poll, so 60s is one missed cycle away from a
# false alarm. 120s is two cycles: quiet enough not to flap, short enough that a
# worker that stopped polling is caught on the first run of the doctor.
QADAM_FLOW_WORKER_STALE_SECONDS=${QADAM_FLOW_WORKER_STALE_SECONDS:-120}

# The log scan describes the present, not the install's history: a stack that had
# a bad hour last week and recovered must not read as broken today.
LOG_WINDOW=10m

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

TAB=$(printf '\t')

# Filled in by preflight / resolve_stack, read by the checks.
PUBLISHED_PORT=''
BASE_URL=''
APP_VERSION=''
WORKER_RECORDS=''
FRESH_WORKERS=0
STALE_WORKERS=0

# ---------- result recording -------------------------------------------------

pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf '%sPASS%s  %-12s %s\n' "$C_GREEN"  "$C_RESET" "$1" "$2"; }
skip() { SKIP_COUNT=$((SKIP_COUNT + 1)); printf '%sSKIP%s  %-12s %s\n' "$C_DIM"    "$C_RESET" "$1" "$2"; }

# Third argument is the command to run next. A failure without one is a failure
# the reader has to go and reproduce by hand, which is the state this script exists to end.
soft() {
  WARN_COUNT=$((WARN_COUNT + 1))
  printf '%sWARN%s  %-12s %s\n' "$C_YELLOW" "$C_RESET" "$1" "$2"
  [ $# -lt 3 ] || printf '      %s→ %s%s\n' "$C_DIM" "$3" "$C_RESET"
}

bad() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf '%sFAIL%s  %-12s %s\n' "$C_RED" "$C_RESET" "$1" "$2"
  [ $# -lt 3 ] || printf '      %s→ %s%s\n' "$C_DIM" "$3" "$C_RESET"
}

note() { printf '      %s%s%s\n' "$C_DIM" "$1" "$C_RESET"; }

exit_code() {
  if [ "$FAIL_COUNT" -gt 0 ]; then
    return 1
  fi
  return 0
}

# ---------- docker plumbing --------------------------------------------------

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  else
    docker-compose "$@"
  fi
}

# `compose exec` on a service with no running container prints a docker error and
# exits non-zero; every caller here wants that treated as "no answer", not as a crash.
dexec() {
  dexec_svc=$1
  shift
  compose exec -T "$dexec_svc" "$@" 2>/dev/null
}

running_ids() {
  compose ps -q "$1" 2>/dev/null || true
}

all_ids() {
  compose ps -aq "$1" 2>/dev/null || true
}

service_list() {
  compose config --services 2>/dev/null || true
}

# ---------- .env reading -----------------------------------------------------

# A .env written on Windows (Notepad, or a WSL user's editor) is CRLF, and an
# unstripped \r would make every shape check below compare against a value one
# invisible character too long.
env_value() {
  [ -f .env ] || return 0
  sed -n "s/^$1=//p" .env | tr -d '\r' | tail -n 1
}

env_present() {
  [ -n "$(env_value "$1")" ]
}

# Values are matched, never printed. The list is the set of strings that ship in
# other projects' example files and that people paste in without reading.
is_placeholder() {
  case "$(printf '%s' "$1" | tr 'A-Z' 'a-z')" in
    ''|change-me|changeme|change_me|changethis|change-this|secret|mysecret|password|passwd \
      |your-secret|your_secret|yoursecret|your-key|your_key|todo|xxx|xxxx|test|example|placeholder \
      |'<your-secret>'|'<secret>'|'<change-me>'|00000000000000000000000000000000) return 0 ;;
  esac
  return 1
}

# The app refuses to boot on anything else: system-validator.ts tests
# /^[A-Za-z0-9]{32}$/ against AP_ENCRYPTION_KEY and throws if it does not match.
is_encryption_key_shape() {
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9]{32}$'
}

str_len() {
  printf '%s' "$1" | wc -c | tr -d ' '
}

# `[` has no string-ordering operator in POSIX, and the ISO-8601 UTC stamps
# compared here sort lexicographically exactly as they sort chronologically.
str_gt() {
  awk -v a="$1" -v b="$2" 'BEGIN { exit !(a > b) }'
}

num_lt() {
  awk -v a="$1" -v b="$2" 'BEGIN { exit !(a + 0 < b + 0) }'
}

# ---------- preflight --------------------------------------------------------

preflight() {
  command -v docker >/dev/null 2>&1 || die "missing dependency: docker — install it and re-run"
  if ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; then
    die "docker compose not found — install Docker Desktop or the docker-compose-plugin package"
  fi
  docker info >/dev/null 2>&1 || die "docker daemon unreachable — start Docker Desktop, or run: sudo systemctl start docker"

  if [ ! -d "$QADAM_FLOW_DIR" ]; then
    die "no install directory at '$QADAM_FLOW_DIR' — run the doctor from the parent of your install, or set QADAM_FLOW_DIR"
  fi
  cd "$QADAM_FLOW_DIR"
  [ -f docker-compose.yml ] || die "$(pwd) has no docker-compose.yml — this doctor only understands the compose install (see https://flow.aiqadam.org/docs/install/options/docker)"
  [ -f .env ] || die "$(pwd) has no .env — compose reads it with env_file, so the stack cannot be running as installed"
}

# The published port is read from docker, not from .env: docker is what is
# actually listening, and a .env that disagrees with it is one of the things this
# script is here to report rather than to trust.
resolve_stack() {
  PUBLISHED_PORT=$(compose port app 80 2>/dev/null | tr -d '\r' | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p' | tail -n 1)
  if [ -z "$PUBLISHED_PORT" ]; then
    PUBLISHED_PORT=$(env_value QADAM_FLOW_PORT)
  fi
  if [ -z "$PUBLISHED_PORT" ]; then
    PUBLISHED_PORT=8080
  fi
  BASE_URL="http://localhost:${PUBLISHED_PORT}"
}

# ---------- checks -----------------------------------------------------------

# What this catches: an .env that boots a stack which then cannot work — a
# placeholder encryption key (every stored connection becomes undecryptable), an
# AP_ENVIRONMENT of `TESTING` instead of `test` (silently disables every
# environment-gated branch), or an AP_FRONTEND_URL pointing at a port nothing is
# published on (every webhook and OAuth redirect URL it builds is dead).
check_env() {
  env_ok=yes

  env_mode=$(stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env 2>/dev/null || echo '')
  case "$env_mode" in
    ''|*00) ;;
    *) soft env ".env is mode ${env_mode} — readable by other users on this host" \
         "chmod 600 $(pwd)/.env" ; env_ok=warned ;;
  esac

  for env_key in AP_ENCRYPTION_KEY AP_JWT_SECRET AP_FRONTEND_URL AP_ENVIRONMENT; do
    if ! env_present "$env_key"; then
      bad env "$env_key is missing from .env" \
        "add it to $(pwd)/.env, then: docker compose up -d"
      env_ok=no
    fi
  done

  env_enc=$(env_value AP_ENCRYPTION_KEY)
  if [ -n "$env_enc" ]; then
    if is_placeholder "$env_enc"; then
      bad env "AP_ENCRYPTION_KEY is a placeholder value" \
        "replace it with: openssl rand -hex 16   (note: existing stored connections become unreadable)"
      env_ok=no
    elif ! is_encryption_key_shape "$env_enc"; then
      bad env "AP_ENCRYPTION_KEY is $(str_len "$env_enc") chars — the app requires exactly 32 alphanumerics and refuses to boot otherwise" \
        "openssl rand -hex 16"
      env_ok=no
    fi
  fi

  env_jwt=$(env_value AP_JWT_SECRET)
  if [ -n "$env_jwt" ]; then
    if is_placeholder "$env_jwt"; then
      bad env "AP_JWT_SECRET is a placeholder value — anyone can mint a valid session token" \
        "replace it with: openssl rand -hex 32   (this signs out every user)"
      env_ok=no
    elif num_lt "$(str_len "$env_jwt")" 32; then
      soft env "AP_JWT_SECRET is only $(str_len "$env_jwt") chars — the app accepts it, but it is brute-forceable" \
        "openssl rand -hex 32"
      [ "$env_ok" = no ] || env_ok=warned
    fi
  fi

  env_environment=$(env_value AP_ENVIRONMENT)
  case "$env_environment" in
    ''|prod|dev|test) ;;
    *) bad env "AP_ENVIRONMENT is '${env_environment}' — the only valid values are prod, dev and test" \
         "set AP_ENVIRONMENT=prod in $(pwd)/.env, then: docker compose up -d"
       env_ok=no ;;
  esac

  if [ "$(env_value AP_DB_TYPE)" = POSTGRES ] || [ -z "$(env_value AP_DB_TYPE)" ]; then
    if ! env_present AP_POSTGRES_PASSWORD; then
      bad env "AP_POSTGRES_PASSWORD is missing while AP_DB_TYPE is POSTGRES" \
        "set it in $(pwd)/.env to match the password the postgres volume was initialised with"
      env_ok=no
    elif is_placeholder "$(env_value AP_POSTGRES_PASSWORD)"; then
      soft env "AP_POSTGRES_PASSWORD is a placeholder value" \
        "rotate it in .env and in postgres, then: docker compose up -d"
      [ "$env_ok" = no ] || env_ok=warned
    fi
  fi

  env_url=$(env_value AP_FRONTEND_URL)
  env_url_verdict="agrees with published port ${PUBLISHED_PORT}"
  case "$env_url" in
    http://localhost:"$PUBLISHED_PORT"|http://127.0.0.1:"$PUBLISHED_PORT") ;;
    http://localhost:*|http://127.0.0.1:*)
      bad env "AP_FRONTEND_URL is ${env_url} but the stack publishes port ${PUBLISHED_PORT} — every webhook and OAuth redirect URL the app builds points at nothing" \
        "re-run the installer with QADAM_FLOW_PORT=${PUBLISHED_PORT}, or fix AP_FRONTEND_URL in $(pwd)/.env"
      env_ok=no ;;
    '') env_url_verdict='' ;;
    *)
      # A real hostname is the operator's own routing decision: the published port
      # says nothing about what a reverse proxy in front of it forwards.
      env_url_verdict="is a custom hostname, not checked against the published port" ;;
  esac

  if [ "$env_ok" = yes ]; then
    pass env "secrets present and well-formed${env_url_verdict:+; AP_FRONTEND_URL $env_url_verdict}"
  fi
}

# What this catches: a service that exited, was never created, or is stuck in a
# docker-level restart loop. This is the weakest check in the file on purpose —
# it is the one every other tool already does, and it is exactly the one that
# reported a healthy install while nothing worked.
check_containers() {
  containers_ok=yes
  for svc in $(service_list); do
    svc_all=$(all_ids "$svc" | wc -l | tr -d ' ')
    svc_running=0
    for cid in $(running_ids "$svc"); do
      cid_state=$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || echo unknown)
      [ "$cid_state" = running ] && svc_running=$((svc_running + 1))
    done
    if [ "$svc_running" -eq 0 ]; then
      if [ "$svc_all" -eq 0 ]; then
        bad containers "service '${svc}' has no container at all" \
          "docker compose up -d ${svc}"
      else
        cid_exit=$(docker inspect -f '{{.State.ExitCode}}' "$(all_ids "$svc" | head -n 1)" 2>/dev/null || echo '?')
        bad containers "service '${svc}' is not running (last exit code ${cid_exit})" \
          "docker compose logs --tail=100 ${svc}"
      fi
      containers_ok=no
    fi
  done
  [ "$containers_ok" = yes ] && pass containers "every service in docker-compose.yml has at least one running container"
  return 0
}

# What this catches: a container that docker reports as `Up` because it keeps
# being restarted. `docker ps` shows the current attempt, not the count.
check_restarts() {
  restarts_ok=yes
  for svc in $(service_list); do
    for cid in $(all_ids "$svc"); do
      cid_restarts=$(docker inspect -f '{{.RestartCount}}' "$cid" 2>/dev/null || echo 0)
      cid_name=$(docker inspect -f '{{.Name}}' "$cid" 2>/dev/null | sed 's|^/||')
      if num_lt 4 "$cid_restarts"; then
        bad restarts "${cid_name} has been restarted ${cid_restarts} times by docker" \
          "docker compose logs --tail=100 ${svc}"
        restarts_ok=no
      elif num_lt 0 "$cid_restarts"; then
        soft restarts "${cid_name} has been restarted ${cid_restarts} time(s) by docker" \
          "docker compose logs --tail=100 ${svc}"
        [ "$restarts_ok" = no ] || restarts_ok=warned
      fi
    done
  done
  [ "$restarts_ok" = yes ] && pass restarts "no container has been restarted by docker"
  return 0
}

# What this catches: THE motivating failure. Each Qadam Flow container runs its
# processes under an in-container supervisor (pm2). When the worker process dies
# — a bad token, a missing secret — pm2 restarts it, and after enough attempts
# marks it `errored` and stops trying. The container stays `Up`, docker's
# RestartCount stays 0, and the API keeps answering 200. Nothing outside the
# container can see it. This looks inside.
#
# The parse runs through node (present in the image by construction — it is a
# `node:` base) rather than grep, because `pm2 jlist` dumps every process's full
# environment, AP_JWT_SECRET and the database password included. Only four
# fields per process ever leave the container.
check_supervisor() {
  supervisor_seen=no
  supervisor_ok=yes
  for svc in $(service_list); do
    [ -n "$(running_ids "$svc")" ] || continue
    svc_pm2=$(dexec "$svc" sh -c 'command -v pm2 >/dev/null 2>&1 || exit 9
pm2 jlist 2>/dev/null | node -e "
let s = \"\";
process.stdin.on(\"data\", (d) => { s += d; });
process.stdin.on(\"end\", () => {
  try {
    const list = JSON.parse(s);
    for (const p of list) {
      console.log([p.name, p.pm2_env.status, p.pm2_env.restart_time, p.pm2_env.unstable_restarts].join(\"|\"));
    }
  } catch (e) { process.exit(3); }
});
"' || true)
    [ -n "$svc_pm2" ] || continue
    supervisor_seen=yes
    printf '%s\n' "$svc_pm2" | tr -d '\r' | sed "/^\$/d; s|^|${svc}\||" > "$TMPDIR_DOCTOR/pm2"
    while IFS='|' read -r p_svc p_name p_status p_restarts p_unstable; do
      if [ "$p_status" != online ]; then
        bad supervisor "${p_name} in service '${p_svc}' is ${p_status} after ${p_restarts} restart(s) — the container is Up but this process is not running" \
          "docker compose exec ${p_svc} pm2 logs ${p_name} --lines 100 --nostream"
        supervisor_ok=no
      elif num_lt 4 "$p_restarts"; then
        bad supervisor "${p_name} in service '${p_svc}' has been restarted ${p_restarts} times (${p_unstable} unstable) — it is crash-looping" \
          "docker compose exec ${p_svc} pm2 logs ${p_name} --lines 100 --nostream"
        supervisor_ok=no
      elif num_lt 0 "$p_restarts"; then
        soft supervisor "${p_name} in service '${p_svc}' has been restarted ${p_restarts} time(s)" \
          "docker compose exec ${p_svc} pm2 logs ${p_name} --lines 100 --nostream"
        [ "$supervisor_ok" = no ] || supervisor_ok=warned
      fi
    done < "$TMPDIR_DOCTOR/pm2"
  done
  if [ "$supervisor_seen" = no ]; then
    skip supervisor "no in-container supervisor found — nothing to inspect inside the containers"
  elif [ "$supervisor_ok" = yes ]; then
    pass supervisor "every supervised process is online with no restarts"
  fi
  return 0
}

# What this catches: a 200 that is not the API. A reverse proxy that serves the
# SPA's index.html for /api/*, or a stale/foreign service squatting the port,
# answers 200 all day. The flags payload is the app's own identity document —
# if CURRENT_VERSION and PUBLIC_URL are not in it, whatever answered is not the app.
check_api() {
  # `|| true` rather than `|| echo 000`: curl already writes "000" to stdout when
  # it never got a response, and a second echo inside the same substitution
  # concatenates into the nonsense code "000000".
  api_code=$(curl -s -o "$TMPDIR_DOCTOR/flags" -w '%{http_code}' -m 15 "${BASE_URL}/api/v1/flags" 2>/dev/null || true)
  if [ -z "$api_code" ] || [ "$api_code" = 000 ]; then
    bad api "nothing answered ${BASE_URL}/api/v1/flags" \
      "docker compose logs --tail=100 app"
    return 0
  fi
  if [ "$api_code" != 200 ]; then
    bad api "${BASE_URL}/api/v1/flags returned HTTP ${api_code}" \
      "docker compose logs --tail=100 app"
    return 0
  fi
  if ! grep -q '"CURRENT_VERSION"' "$TMPDIR_DOCTOR/flags" || ! grep -q '"PUBLIC_URL"' "$TMPDIR_DOCTOR/flags"; then
    bad api "${BASE_URL}/api/v1/flags returned 200 but the body is not a flags payload — something other than the app is answering this port" \
      "curl -s ${BASE_URL}/api/v1/flags | head -c 300"
    return 0
  fi
  APP_VERSION=$(tr ',' '\n' < "$TMPDIR_DOCTOR/flags" | sed -n 's/.*"CURRENT_VERSION":"\([^"]*\)".*/\1/p' | head -n 1)
  api_public=$(tr ',' '\n' < "$TMPDIR_DOCTOR/flags" | sed -n 's/.*"PUBLIC_URL":"\([^"]*\)".*/\1/p' | head -n 1)
  pass api "flags payload served on port ${PUBLISHED_PORT}; release ${APP_VERSION:-unknown}, public url ${api_public}"
  return 0
}

# What this catches: postgres up but unreachable, or reachable but rejecting the
# app's credentials, or reachable and authenticating against an empty database.
# `pg_isready` inside the postgres container proves none of those — it asks
# postgres about itself over its own loopback. This connects from the app
# container, over the compose network, with the app's own credentials, and reads
# a table only a migrated database has.
check_postgres() {
  pg_type=$(env_value AP_DB_TYPE)
  if [ "$pg_type" = PGLITE ]; then
    skip postgres "AP_DB_TYPE is PGLITE — the database is embedded in the app container"
    return 0
  fi
  if [ -z "$(running_ids app)" ]; then
    skip postgres "the app container is not running, so there is no app network to test from"
    return 0
  fi
  pg_out=$(dexec app node -e '
const { Client } = require("pg");
const c = new Client({
  host: process.env.AP_POSTGRES_HOST,
  port: Number(process.env.AP_POSTGRES_PORT || 5432),
  user: process.env.AP_POSTGRES_USERNAME,
  password: process.env.AP_POSTGRES_PASSWORD,
  database: process.env.AP_POSTGRES_DATABASE,
  ssl: String(process.env.AP_POSTGRES_USE_SSL) === "true" ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 8000,
});
c.connect()
  .then(() => c.query("select to_regclass($1) as t", ["public.flow"]))
  .then((r) => { console.log(r.rows[0].t ? "OK" : "NOSCHEMA"); return c.end(); })
  .catch((e) => { console.log("ERR " + String(e.message).replace(/\s+/g, " ")); process.exit(1); });
' || true)
  case "$pg_out" in
    OK*)       pass postgres "reachable from the app container, credentials accepted, schema present" ;;
    NOSCHEMA*) bad  postgres "reachable and authenticated, but the database has no schema — migrations have not run" \
                 "docker compose logs --tail=200 app | grep -i migration" ;;
    ERR*)      bad  postgres "the app container cannot use the database: ${pg_out#ERR }" \
                 "docker compose logs --tail=100 postgres" ;;
    *)         soft postgres "could not run the connectivity probe inside the app container" \
                 "docker compose exec app node -e 'require(\"pg\")'" ;;
  esac
  return 0
}

# What this catches: redis running but unreachable from the app's network (a
# renamed service, a network the app is not attached to, a wrong AP_REDIS_HOST).
# `redis-cli ping` inside the redis container would pass in all three cases.
check_redis() {
  redis_type=$(env_value AP_REDIS_TYPE)
  if [ "$redis_type" = MEMORY ]; then
    skip redis "AP_REDIS_TYPE is MEMORY — the queue is in-process, there is no redis to reach"
    return 0
  fi
  if [ -z "$(running_ids app)" ]; then
    skip redis "the app container is not running, so there is no app network to test from"
    return 0
  fi
  redis_out=$(dexec app node -e '
const net = require("net");
const s = net.connect({ host: process.env.AP_REDIS_HOST, port: Number(process.env.AP_REDIS_PORT || 6379) });
s.setTimeout(8000);
s.on("connect", () => s.write("PING\r\n"));
s.on("data", (d) => { console.log(String(d).trim().startsWith("+PONG") ? "OK" : "BAD " + String(d).trim()); s.destroy(); process.exit(0); });
s.on("timeout", () => { console.log("ERR timed out"); process.exit(1); });
s.on("error", (e) => { console.log("ERR " + e.message); process.exit(1); });
' || true)
  case "$redis_out" in
    OK*)  pass redis "PING answered from inside the app container" ;;
    BAD*) bad redis "something is listening on AP_REDIS_HOST but it did not answer PING: ${redis_out#BAD }" \
            "docker compose logs --tail=50 redis" ;;
    ERR*) bad redis "the app container cannot reach redis: ${redis_out#ERR }" \
            "docker compose logs --tail=50 redis" ;;
    *)    soft redis "could not run the connectivity probe inside the app container" \
            "docker compose exec app node -e 'require(\"net\")'" ;;
  esac
  return 0
}

# What this catches: the whole point of the script. A worker container can be
# `Up`, its process online, and still never take a job — it has crashed and been
# restarted into a state where it is not polling, or it is connected and paused.
#
# The evidence is the app's own worker registry: `machineService.onConnection`
# writes one entry per worker into the redis hash `workerMachines`, and it is
# called by the `poll` RPC handler on *every* poll. So the `updated` timestamp on
# an entry is the last moment the app heard a worker ask for work. A registry
# entry proves a worker connected; a *fresh* one proves it is still polling.
# No app credentials are needed — the hash is in the stack's own redis.
load_workers() {
  WORKER_RECORDS=''
  [ -n "$(running_ids redis)" ] || return 0
  WORKER_RECORDS=$(dexec redis redis-cli --raw HVALS workerMachines || true)
}

check_workers() {
  if [ "$(env_value AP_REDIS_TYPE)" = MEMORY ]; then
    skip workers "AP_REDIS_TYPE is MEMORY — the worker registry is in-process and not readable from outside"
    return 0
  fi
  if [ -z "$(running_ids redis)" ]; then
    skip workers "redis is not running, so the app's worker registry cannot be read"
    return 0
  fi
  # Workers poll the app. With the app down, every entry in the registry is a
  # record of what was true before it stopped, and reporting it as current would
  # be the exact kind of stale reassurance this script exists to remove.
  if [ -z "$(running_ids app)" ]; then
    skip workers "the app is not running — the registry only records what was true before it stopped"
    return 0
  fi

  # In WORKER_AND_APP topologies there is no `worker` service and the worker runs
  # inside the app container, so "no worker container" only means something when
  # the compose file declares one.
  workers_service=no
  for svc in $(service_list); do
    [ "$svc" = worker ] && workers_service=yes
  done
  workers_containers=0
  for cid in $(running_ids worker); do
    [ -n "$cid" ] && workers_containers=$((workers_containers + 1))
  done

  FRESH_WORKERS=0
  STALE_WORKERS=0

  if [ -z "$WORKER_RECORDS" ]; then
    bad workers "no worker is registered with the app — ${workers_containers} worker container(s) running, 0 connected. Flows will queue and never execute." \
      "docker compose logs --tail=100 worker"
    note "the app's own registry (redis hash 'workerMachines') is empty; 'docker ps' cannot see this"
    return 0
  fi

  # Both stamps are ISO-8601 UTC produced on the same docker host, so the clock is
  # shared and the comparison is a plain string comparison.
  workers_cutoff=$(dexec redis date -u -d "-${QADAM_FLOW_WORKER_STALE_SECONDS} seconds" '+%Y-%m-%dT%H:%M:%S' || true)
  workers_total=0
  workers_stale_names=''
  printf '%s\n' "$WORKER_RECORDS" | while read -r rec; do
    [ -n "$rec" ] || continue
    printf '%s\t%s\n' \
      "$(printf '%s' "$rec" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')" \
      "$(printf '%s' "$rec" | sed -n 's/.*"updated":"\([0-9-]\{10\}T[0-9:]\{8\}\).*/\1/p')"
  done > "$TMPDIR_DOCTOR/workers"

  while IFS="$TAB" read -r w_id w_updated; do
    [ -n "$w_id" ] || continue
    workers_total=$((workers_total + 1))
    if [ -z "$workers_cutoff" ] || str_gt "$w_updated" "$workers_cutoff"; then
      FRESH_WORKERS=$((FRESH_WORKERS + 1))
    else
      STALE_WORKERS=$((STALE_WORKERS + 1))
      workers_stale_names="${workers_stale_names} ${w_id}"
    fi
  done < "$TMPDIR_DOCTOR/workers"

  # A registration outlives the worker that wrote it. The app deletes an entry on
  # the socket's DISCONNECT event and otherwise prunes stale ones only when
  # something calls the worker-machines list endpoint — so a removed worker leaves
  # a record that still looks fresh for as long as the staleness window. Comparing
  # the registry against the containers that actually exist closes that window.
  if [ "$workers_service" = yes ] && [ "$workers_containers" -eq 0 ]; then
    FRESH_WORKERS=0
    bad workers "the app lists ${workers_total} worker(s) but no worker container is running — those registrations are leftovers and nothing will execute a flow" \
      "docker compose up -d worker"
    note "the entries survive because the app only prunes its registry when its worker list is queried; 'docker ps' shows the app Up and the API answers 200 throughout"
    return 0
  fi

  if [ "$FRESH_WORKERS" -eq 0 ]; then
    bad workers "${workers_total} worker(s) are registered but none has polled for work in the last ${QADAM_FLOW_WORKER_STALE_SECONDS}s — they are connected and idle, not working" \
      "docker compose logs --tail=100 worker"
    note "stale worker ids:${workers_stale_names}"
    return 0
  fi
  if [ "$STALE_WORKERS" -gt 0 ]; then
    soft workers "${FRESH_WORKERS} of ${workers_total} registered worker(s) are polling; ${STALE_WORKERS} have not polled in the last ${QADAM_FLOW_WORKER_STALE_SECONDS}s" \
      "docker compose logs --tail=100 worker"
    return 0
  fi
  if [ "$workers_containers" -gt "$workers_total" ]; then
    soft workers "all ${workers_total} registered worker(s) are polling, but ${workers_containers} worker container(s) are running — $((workers_containers - workers_total)) never connected" \
      "docker compose logs --tail=100 worker"
    return 0
  fi
  pass workers "${workers_total} worker(s) registered and all polled for work within the last ${QADAM_FLOW_WORKER_STALE_SECONDS}s"
  return 0
}

# What this catches: a version-skewed pair, which is the most convincing-looking
# broken install there is. Dispatch is gated on an exact release match: the app's
# poll handler withholds every job from a worker on a different release, and the
# worker pauses polling against an app on a different release. Both sides log a
# line and keep running. Containers Up, API 200, worker "connected", zero
# execution — for as long as the mismatch lasts.
check_version() {
  if [ -z "$APP_VERSION" ]; then
    skip version "the app's release is unknown (the API check did not get a flags payload)"
    return 0
  fi
  version_ok=yes

  if [ -n "$WORKER_RECORDS" ]; then
    printf '%s\n' "$WORKER_RECORDS" | while read -r rec; do
      [ -n "$rec" ] || continue
      printf '%s\t%s\n' \
        "$(printf '%s' "$rec" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')" \
        "$(printf '%s' "$rec" | sed -n 's/.*"workerProps":{[^}]*"version":"\([^"]*\)".*/\1/p')"
    done > "$TMPDIR_DOCTOR/versions"
    while IFS="$TAB" read -r v_id v_version; do
      [ -n "$v_id" ] || continue
      if [ -z "$v_version" ]; then
        # A worker's release only reaches the registry on a poll — the settings it
        # needs to build its own props are not loaded yet at connect time. So a
        # registration with no release is a worker that has connected and not
        # completed a single poll since, which is exactly what the version gate's
        # worker-side pause looks like.
        soft version "worker ${v_id} registered without a release — it has not completed a poll since connecting" \
          "docker compose logs --tail=50 worker | grep -i 'version mismatch'"
        [ "$version_ok" = no ] || version_ok=warned
      elif [ "$v_version" != "$APP_VERSION" ]; then
        bad version "worker ${v_id} runs ${v_version} but the app runs ${APP_VERSION} — the app withholds every job from it and it will never execute a flow" \
          "docker compose pull && docker compose up -d"
        version_ok=no
      fi
    done < "$TMPDIR_DOCTOR/versions"
  fi

  # An independent second source, and the only one available when no worker has
  # managed to register: if the app and worker containers were started from
  # different images, they are different builds whatever the registry says.
  version_images_compared=no
  version_app_img=$(docker inspect -f '{{.Image}}' "$(running_ids app | head -n 1)" 2>/dev/null || true)
  version_worker_img=$(docker inspect -f '{{.Image}}' "$(running_ids worker | head -n 1)" 2>/dev/null || true)
  if [ -n "$version_app_img" ] && [ -n "$version_worker_img" ]; then
    version_images_compared=yes
    if [ "$version_app_img" != "$version_worker_img" ]; then
      bad version "the app and worker containers were started from different images — one of them is running an older build" \
        "docker compose up -d --force-recreate"
      version_ok=no
    fi
  fi

  if [ "$version_ok" = yes ]; then
    if [ -n "$WORKER_RECORDS" ]; then
      pass version "app and every registered worker are on release ${APP_VERSION}"
    elif [ "$version_images_compared" = yes ]; then
      pass version "app is on release ${APP_VERSION}; app and worker containers share one image"
    else
      # Saying "versions match" here would be an invention: there is no worker to
      # compare the app against, from either source.
      skip version "app is on release ${APP_VERSION}; no worker to compare it against"
    fi
  fi
  return 0
}

# What this catches: work piling up. A backlog on its own is a capacity problem;
# a backlog with nothing polling is the signature of the failure this script
# exists for, and it is the one symptom a user actually notices ("my flows just
# sit there"). Only the queues workers consume are counted — the app's own
# system-job-queue and runsMetadata are drained in-process and would be noise.
check_queue() {
  if [ "$(env_value AP_REDIS_TYPE)" = MEMORY ] || [ -z "$(running_ids redis)" ]; then
    skip queue "no external redis to read queue depth from"
    return 0
  fi
  queue_names=$(dexec redis redis-cli --scan --pattern 'bull:*:meta' 2>/dev/null | tr -d '\r' | sed 's/^bull://; s/:meta$//' || true)
  queue_waiting=0
  queue_active=0
  queue_counted=''
  for q in $queue_names; do
    case "$q" in
      workerJobs|platform-*-jobs) ;;
      *) continue ;;
    esac
    queue_counted="${queue_counted} ${q}"
    q_wait=$(dexec redis redis-cli --raw LLEN "bull:${q}:wait" 2>/dev/null | tr -d '\r' || echo 0)
    q_prio=$(dexec redis redis-cli --raw ZCARD "bull:${q}:prioritized" 2>/dev/null | tr -d '\r' || echo 0)
    q_act=$(dexec redis redis-cli --raw LLEN "bull:${q}:active" 2>/dev/null | tr -d '\r' || echo 0)
    queue_waiting=$((queue_waiting + ${q_wait:-0} + ${q_prio:-0}))
    queue_active=$((queue_active + ${q_act:-0}))
  done
  if [ -z "$queue_counted" ]; then
    skip queue "no worker job queue exists in redis yet — the app has not dispatched anything since this install was created"
    return 0
  fi
  if [ "$queue_waiting" -gt 0 ] && [ "$FRESH_WORKERS" -eq 0 ]; then
    bad queue "${queue_waiting} job(s) are waiting in${queue_counted} and no worker is polling — they will sit there indefinitely" \
      "docker compose logs --tail=100 worker"
    return 0
  fi
  if [ "$queue_waiting" -gt 50 ]; then
    soft queue "${queue_waiting} job(s) waiting, ${queue_active} in flight — the workers are behind" \
      "docker compose up -d --scale worker=\$((\$(docker compose ps -q worker | wc -l) * 2))"
    return 0
  fi
  pass queue "${queue_waiting} job(s) waiting, ${queue_active} in flight across${queue_counted}"
  return 0
}

# What this catches: the states that make a worker look fine to every other check
# — the app refusing to hand it jobs over the version gate, the socket failing to
# establish, or the SSRF egress stack aborting the process on startup. Only the
# count of matching lines is reported: the log bodies are structured records that
# can contain flow data, and this output is meant to be pasteable.
check_logs() {
  logs_ok=yes
  if [ -n "$(running_ids worker)" ]; then
    compose logs --since "$LOG_WINDOW" --tail=400 worker > "$TMPDIR_DOCTOR/worker.log" 2>/dev/null || true
    logs_scan worker 'app version mismatch' 1 \
      "the worker paused polling because the app is on a different release" \
      "docker compose pull && docker compose up -d"
    # A worker started alongside the app always loses the first connection or two
    # while the app is still binding its port, and then reconnects. Only a
    # sustained run of them in a ten-minute window means anything.
    logs_scan worker 'Socket.IO connection error' 5 \
      "the worker keeps failing to open its socket to the app" \
      "docker compose logs --tail=100 worker | grep -i 'connection error'"
    logs_scan worker 'Egress stack failed to start' 1 \
      "the worker aborted rather than run without SSRF protection" \
      "docker compose logs --tail=100 worker | grep -i egress"
  fi
  if [ -n "$(running_ids app)" ]; then
    compose logs --since "$LOG_WINDOW" --tail=400 app > "$TMPDIR_DOCTOR/app.log" 2>/dev/null || true
    logs_scan app 'Withholding job' 1 \
      "the app refused to hand a job to a worker on a different release" \
      "docker compose pull && docker compose up -d"
  fi
  [ "$logs_ok" = yes ] && pass logs "no known-fatal pattern in the last ${LOG_WINDOW} of app and worker logs"
  return 0
}

logs_scan() {
  scan_svc=$1; scan_pattern=$2; scan_threshold=$3; scan_msg=$4; scan_action=$5
  scan_file="$TMPDIR_DOCTOR/${scan_svc}.log"
  [ -f "$scan_file" ] || return 0
  scan_hits=$(grep -c "$scan_pattern" "$scan_file" 2>/dev/null || true)
  scan_hits=${scan_hits:-0}
  if [ "$scan_hits" -ge "$scan_threshold" ]; then
    soft logs "${scan_svc}: ${scan_hits} line(s) in the last ${LOG_WINDOW} — ${scan_msg}" "$scan_action"
    logs_ok=warned
  fi
  return 0
}

# What this catches: a full disk, which never presents as a full disk. It
# presents as postgres refusing writes, redis failing to persist, and flow runs
# failing with unrelated errors. The volumes are measured from inside the
# containers that own them, because on Docker Desktop the host's `df` measures a
# different filesystem entirely.
check_disk() {
  disk_ok=yes
  disk_probe postgres /var/lib/postgresql/data "the postgres data volume"
  disk_probe redis /data "the redis data volume"
  disk_host
  [ "$disk_ok" = yes ] && pass disk "every volume has headroom"
  return 0
}

disk_probe() {
  d_svc=$1; d_path=$2; d_label=$3
  [ -n "$(running_ids "$d_svc")" ] || return 0
  d_line=$(dexec "$d_svc" df -P "$d_path" 2>/dev/null | tail -n 1 || true)
  [ -n "$d_line" ] || return 0
  d_used=$(printf '%s' "$d_line" | awk '{ gsub(/%/, "", $5); print $5 }')
  d_avail=$(printf '%s' "$d_line" | awk '{ print $4 }')
  case "$d_used" in ''|*[!0-9]*) return 0 ;; esac
  case "$d_avail" in ''|*[!0-9]*) return 0 ;; esac
  d_free=$((100 - d_used))
  if [ "$d_free" -lt 5 ] || [ "$d_avail" -lt 262144 ]; then
    bad disk "${d_label} is ${d_used}% full ($((d_avail / 1024)) MB free)" \
      "free space on the docker data root, or: docker system prune"
    disk_ok=no
  elif [ "$d_free" -lt 15 ]; then
    soft disk "${d_label} is ${d_used}% full ($((d_avail / 1024)) MB free)" \
      "docker system prune"
    [ "$disk_ok" = no ] || disk_ok=warned
  fi
  return 0
}

disk_host() {
  d_line=$(df -P . 2>/dev/null | tail -n 1 || true)
  [ -n "$d_line" ] || return 0
  d_used=$(printf '%s' "$d_line" | awk '{ gsub(/%/, "", $5); print $5 }')
  d_avail=$(printf '%s' "$d_line" | awk '{ print $4 }')
  case "$d_used" in ''|*[!0-9]*) return 0 ;; esac
  case "$d_avail" in ''|*[!0-9]*) return 0 ;; esac
  if [ $((100 - d_used)) -lt 5 ] || [ "$d_avail" -lt 262144 ]; then
    bad disk "the install directory's filesystem is ${d_used}% full — the qadam cache is a bind mount here" \
      "free space under $(pwd)"
    disk_ok=no
  fi
  return 0
}

# ---------- banner -----------------------------------------------------------

banner() {
  cat <<EOF
${C_TEAL}${C_BOLD}
   Qadam Flow doctor
${C_RESET}${C_DIM}an AI Qadam Build project — https://flow.aiqadam.org${C_RESET}

EOF
}

summary() {
  printf '\n'
  if [ "$FAIL_COUNT" -gt 0 ]; then
    printf '%s%s%d failed%s, %d warning(s), %d passed, %d skipped\n' \
      "$C_RED" "$C_BOLD" "$FAIL_COUNT" "$C_RESET" "$WARN_COUNT" "$PASS_COUNT" "$SKIP_COUNT"
    printf '\n%sThis install is not working. Start with the FAIL lines above — each one names the command that shows why.%s\n' "$C_BOLD" "$C_RESET"
    printf '%sStill stuck? Open an issue with this output: https://github.com/aiqadam/qadam-flow/issues%s\n' "$C_DIM" "$C_RESET"
  elif [ "$WARN_COUNT" -gt 0 ]; then
    printf '%s%s0 failed%s, %d warning(s), %d passed, %d skipped\n' \
      "$C_GREEN" "$C_BOLD" "$C_RESET" "$WARN_COUNT" "$PASS_COUNT" "$SKIP_COUNT"
    printf '\n%sQadam Flow is working. The warnings above are worth reading but nothing is broken.%s\n' "$C_BOLD" "$C_RESET"
  else
    printf '%s%s0 failed%s, 0 warnings, %d passed, %d skipped\n' \
      "$C_GREEN" "$C_BOLD" "$C_RESET" "$PASS_COUNT" "$SKIP_COUNT"
    printf '\n%sQadam Flow is healthy: the API answers, the database and queue are reachable from the app, and workers are actively taking jobs at %s.%s\n' \
      "$C_BOLD" "$BASE_URL" "$C_RESET"
  fi
}

usage() {
  cat <<EOF
Usage: doctor.sh [--help]

Diagnoses a Qadam Flow docker compose install: not whether the containers are up,
but whether the install can actually execute a flow. Read-only.

Environment overrides:
  QADAM_FLOW_DIR                    install directory (default: qadam-flow)
  QADAM_FLOW_WORKER_STALE_SECONDS   worker poll staleness threshold (default: 120)
  NO_COLOR                          disable colour output

Exit codes: 0 healthy, 1 a check failed, 2 the doctor could not run.
EOF
}

# ---------- main -------------------------------------------------------------

main() {
  for arg in "$@"; do
    case "$arg" in
      -h|--help) usage; exit 0 ;;
      *) err "unknown argument: $arg"; usage >&2; exit 2 ;;
    esac
  done

  banner
  preflight
  resolve_stack
  log "inspecting $(pwd) — published on port ${PUBLISHED_PORT}"
  printf '\n'

  TMPDIR_DOCTOR=$(mktemp -d 2>/dev/null || mktemp -d -t qadam-doctor)
  trap 'rm -rf "$TMPDIR_DOCTOR"' EXIT INT TERM

  check_env
  check_containers
  check_restarts
  check_supervisor
  check_api
  check_postgres
  check_redis
  load_workers
  check_workers
  check_version
  check_queue
  check_logs
  check_disk

  summary
  exit_code || exit 1
  exit 0
}

# Sourcing with QADAM_FLOW_SOURCE_ONLY=1 loads the helpers without touching
# docker, which is how tools/ci/test-doctor-sh.sh drives check_env / the counters
# / the exit-code arithmetic over .env fixtures. `curl | sh` never sets it, so the
# diagnostic path is unchanged.
if [ "${QADAM_FLOW_SOURCE_ONLY:-}" != 1 ]; then
  main "$@"
fi
