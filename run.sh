#!/bin/sh
# Qadam Flow — one-line installer & launcher.
#
# Paste this into any macOS / Linux / WSL2 shell:
#   curl -fsSL https://flow.aiqadam.org/run.sh | sh
#
# What it does (no git, no source build):
#   1. Verifies docker + docker compose are available.
#   2. Downloads docker-compose.yml into ./qadam-flow.
#   3. Generates a fresh .env with random secrets.
#   4. docker compose pull.
#   5. Upgrades the bundled PostgreSQL's data if it was written by an older major
#      (dump with the old image, restore into a new volume, keep the old one).
#   6. docker compose up -d.
#   7. Waits for the API to start and prints the URL.
#
# Environment overrides:
#   QADAM_FLOW_DIR   — install directory (default: ./qadam-flow)
#   QADAM_FLOW_PORT  — host port the app is published on (default: 8080)
#   QADAM_FLOW_IMAGE — docker image (default: ghcr.io/aiqadam/qadam-flow:latest)
#   QADAM_FLOW_REF   — git ref for the compose file (default: main)
#
# Targets: macOS (Docker Desktop), Linux (dockerd), Windows via WSL2.
# Native Windows PowerShell is not supported — use WSL2.

set -eu

# ---------- colors -----------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_TEAL=$(printf '\033[38;5;37m')
  C_BOLD=$(printf '\033[1m')
  C_DIM=$(printf '\033[2m')
  C_RED=$(printf '\033[31m')
  C_YELLOW=$(printf '\033[33m')
  C_RESET=$(printf '\033[0m')
else
  C_TEAL=''; C_BOLD=''; C_DIM=''; C_RED=''; C_YELLOW=''; C_RESET=''
fi

log()  { printf '%s▸%s %s\n' "$C_TEAL"   "$C_RESET" "$1"; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$1" >&2; }
err()  { printf '%s✗%s %s\n' "$C_RED"    "$C_RESET" "$1" >&2; }
die()  { err "$1"; exit 1; }

# ---------- defaults ---------------------------------------------------------

QADAM_FLOW_DIR=${QADAM_FLOW_DIR:-qadam-flow}
QADAM_FLOW_IMAGE=${QADAM_FLOW_IMAGE:-ghcr.io/aiqadam/qadam-flow:latest}
QADAM_FLOW_REF=${QADAM_FLOW_REF:-main}

DEFAULT_PORT=8080
# Whether the operator asked for a specific port matters: an explicit override must be pushed into an
# existing .env, while no override must adopt whatever port that .env already publishes.
if [ -n "${QADAM_FLOW_PORT:-}" ]; then
  PORT_EXPLICIT=yes
else
  PORT_EXPLICIT=no
fi
QADAM_FLOW_PORT=${QADAM_FLOW_PORT:-$DEFAULT_PORT}

COMPOSE_URL="https://raw.githubusercontent.com/aiqadam/qadam-flow/${QADAM_FLOW_REF}/docker-compose.yml"

# PostgreSQL major upgrade (#611). The volume keys and the marker file name must match the postgres
# service in docker-compose.yml. PG_ROLLBACK_REF is the last commit whose compose file runs
# PostgreSQL 14 on postgres_data; the rollback hint points the installer back at it.
PG_DATA_VOLUME_KEY=pgdata
PG_LEGACY_VOLUME_KEY=postgres_data
PG_UPGRADE_MARKER=QADAM_FLOW_UPGRADED
PG_ROLLBACK_REF=ef4f230d5263712480a1a7e5fb9f752be15995ee
PG_UPGRADE_OLD_CONTAINER=qadam-flow-pg-upgrade-old
PG_UPGRADE_NEW_CONTAINER=qadam-flow-pg-upgrade-new
PG_UPGRADE_SUMMARY=''

validate_port() {
  port_source=${1:-QADAM_FLOW_PORT}
  case "$QADAM_FLOW_PORT" in
    ''|*[!0-9]*) die "$port_source must be a number between 1 and 65535 (got '$QADAM_FLOW_PORT')" ;;
  esac
  if [ "$QADAM_FLOW_PORT" -lt 1 ] || [ "$QADAM_FLOW_PORT" -gt 65535 ]; then
    die "$port_source must be a number between 1 and 65535 (got '$QADAM_FLOW_PORT')"
  fi
}

# ---------- platform sanity --------------------------------------------------

detect_platform() {
  uname_s=$(uname -s 2>/dev/null || echo unknown)
  case "$uname_s" in
    Darwin)  PLATFORM=macos ;;
    Linux)
      if grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
        PLATFORM=wsl
      else
        PLATFORM=linux
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*)
      die "native Windows shell detected — please re-run from WSL2 (https://learn.microsoft.com/windows/wsl/install)"
      ;;
    *) PLATFORM=$uname_s ;;
  esac
}

# ---------- prereqs ----------------------------------------------------------

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1 — install it and re-run"
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  else
    docker-compose "$@"
  fi
}

check_docker_compose() {
  if docker compose version >/dev/null 2>&1; then return 0; fi
  if command -v docker-compose >/dev/null 2>&1; then return 0; fi
  die "docker compose not found — install Docker Desktop or the docker-compose-plugin package"
}

check_docker_daemon() {
  if ! docker info >/dev/null 2>&1; then
    case "$PLATFORM" in
      macos) die "Docker Desktop isn't running — open it and wait until the whale icon goes steady" ;;
      wsl)   die "docker daemon unreachable — start Docker Desktop on Windows with WSL integration enabled" ;;
      *)     die "docker daemon unreachable — run: sudo systemctl start docker" ;;
    esac
  fi
}

check_prereqs() {
  need curl
  need openssl
  need docker
  check_docker_compose
  check_docker_daemon
}

# ---------- staging directory ------------------------------------------------

prepare_dir() {
  if [ -d "$QADAM_FLOW_DIR" ]; then
    if [ -f "$QADAM_FLOW_DIR/docker-compose.yml" ] && [ -f "$QADAM_FLOW_DIR/.env" ]; then
      log "found existing install at $QADAM_FLOW_DIR — refreshing compose file"
    else
      warn "$QADAM_FLOW_DIR exists but doesn't look like a Qadam Flow install — continuing anyway"
    fi
  else
    mkdir -p "$QADAM_FLOW_DIR"
  fi
  cd "$QADAM_FLOW_DIR"
}

fetch_compose() {
  log "downloading docker-compose.yml from $COMPOSE_URL"
  if ! curl -fsSL "$COMPOSE_URL" -o docker-compose.yml.new; then
    die "failed to download $COMPOSE_URL — check your network and that the repo is public"
  fi
  mv docker-compose.yml.new docker-compose.yml
}

# Older compose files hardcode '8080:80'. Publishing a custom port depends on the downloaded file
# interpolating QADAM_FLOW_PORT, so fail loudly instead of booting a stack on the wrong port.
check_compose_port() {
  if [ "$QADAM_FLOW_PORT" = "$DEFAULT_PORT" ]; then
    return 0
  fi
  if ! grep -q 'QADAM_FLOW_PORT' docker-compose.yml; then
    die "the docker-compose.yml at ref '${QADAM_FLOW_REF}' hardcodes port ${DEFAULT_PORT} and cannot publish ${QADAM_FLOW_PORT} — re-run with QADAM_FLOW_REF=main, or unset QADAM_FLOW_PORT"
  fi
}

# A .env written on Windows (Notepad, or a WSL user's editor) is CRLF, and an unstripped \r would end
# up inside the health-check URL and the compose port mapping.
env_value() {
  [ -f .env ] || return 0
  sed -n "s/^$1=//p" .env | tr -d '\r' | tail -n 1
}

set_env_value() {
  if grep -q "^$1=" .env; then
    # cp -p seeds the temp file with .env's own mode before `>` truncates it, so renaming over a
    # hand-hardened .env can't widen AP_JWT_SECRET / AP_ENCRYPTION_KEY / the DB password to 0644.
    cp -p .env .env.tmp && sed "s|^$1=.*|$1=$2|" .env > .env.tmp && mv .env.tmp .env
  else
    # Hand-written .env files often lack a trailing newline (VS Code's insertFinalNewline is off by
    # default); appending blind would glue the assignment onto the last line and destroy both.
    if [ -s .env ] && [ -n "$(tail -c 1 .env)" ]; then
      printf '\n' >> .env
    fi
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

# Only the shape run.sh itself generates is safe to rewrite. Anything else — a real hostname, https,
# an ngrok tunnel, a path — is the operator's own value and must survive a port change untouched.
is_stock_localhost_url() {
  case "$1" in
    http://localhost:*) ;;
    *) return 1 ;;
  esac
  url_port=${1#http://localhost:}
  case "$url_port" in
    ''|*[!0-9]*) return 1 ;;
  esac
  return 0
}

# .env is authoritative for an existing install: compose interpolates QADAM_FLOW_PORT from it, so the
# health check and the printed URL have to agree with what that file says.
reconcile_port() {
  existing_port=$(env_value QADAM_FLOW_PORT)
  frontend_url=$(env_value AP_FRONTEND_URL)
  if [ "$PORT_EXPLICIT" = no ]; then
    if [ -n "$existing_port" ] && [ "$existing_port" != "$QADAM_FLOW_PORT" ]; then
      log "existing install publishes port ${existing_port} — keeping it (set QADAM_FLOW_PORT to change)"
      QADAM_FLOW_PORT=$existing_port
    elif [ -z "$existing_port" ] && is_stock_localhost_url "$frontend_url" \
      && [ "$frontend_url" != "http://localhost:${QADAM_FLOW_PORT}" ]; then
      # Installs predating the QADAM_FLOW_PORT line: the app is told one port by AP_FRONTEND_URL while
      # compose publishes another. Don't move a running stack's port silently — say so instead.
      warn "AP_FRONTEND_URL says ${frontend_url} but the stack will publish port ${QADAM_FLOW_PORT} — re-run with QADAM_FLOW_PORT=${frontend_url#http://localhost:} to move the published port, or fix AP_FRONTEND_URL in .env"
    fi
    return 0
  fi
  if [ "$existing_port" != "$QADAM_FLOW_PORT" ]; then
    log "updating existing .env to publish port ${QADAM_FLOW_PORT}"
    set_env_value QADAM_FLOW_PORT "$QADAM_FLOW_PORT"
  fi
  # Checked even when the port line already matched, so a hand edit that moved only the port — or an
  # earlier run interrupted between the two writes — is repaired instead of left inconsistent.
  if [ "$frontend_url" = "http://localhost:${QADAM_FLOW_PORT}" ] || [ -z "$frontend_url" ]; then
    return 0
  fi
  if is_stock_localhost_url "$frontend_url"; then
    # Announce it: the URL being the stock shape does not prove the operator did not choose it (a local
    # proxy on http://localhost:3000 is the same shape), so a rewrite of their config must be visible.
    log "repointing AP_FRONTEND_URL from ${frontend_url} to http://localhost:${QADAM_FLOW_PORT} in .env"
    set_env_value AP_FRONTEND_URL "http://localhost:${QADAM_FLOW_PORT}"
  else
    warn "AP_FRONTEND_URL is customised ($frontend_url) — left as-is; edit .env if it should follow the new port"
  fi
}

generate_env() {
  if [ -f .env ]; then
    log "reusing existing .env (delete it to regenerate secrets)"
    reconcile_port
    return 0
  fi
  log "generating .env with fresh random secrets"
  enc_key=$(openssl rand -hex 16)
  jwt_secret=$(openssl rand -hex 32)
  pg_password=$(openssl rand -hex 12)

  # Tighten the mode on the empty file first: the heredoc below then truncates a file that is already
  # 0600, so the encryption key, JWT secret and DB password never exist on disk world-readable.
  : > .env
  chmod 600 .env

  cat > .env <<EOF
# Qadam Flow — generated by run.sh. Delete this file and re-run to rotate secrets.
# QADAM_FLOW_* are read by docker-compose.yml itself, not by the app.
QADAM_FLOW_IMAGE=${QADAM_FLOW_IMAGE}
QADAM_FLOW_PORT=${QADAM_FLOW_PORT}

AP_ENVIRONMENT=prod
AP_FRONTEND_URL=http://localhost:${QADAM_FLOW_PORT}
# Distinct from AP_FRONTEND_URL/AP_WEBHOOK_URL on purpose: those are the
# externally reachable address (what a browser or an external webhook
# sender uses — localhost:${QADAM_FLOW_PORT}, the published port). This is
# what the app uses to call back into itself over the compose-internal
# network (the \`app\` service listens on port 80 inside the container,
# which is not the same as the port docker-compose publishes it on) — e.g.
# callFlow's queue-mode wait-for-response resume callback. Falls back to
# AP_FRONTEND_URL if unset, so leaving this out is safe, just slower/less
# reliable for that one path — see AppSystemProp.INTERNAL_URL.
AP_INTERNAL_URL=http://app:80
AP_WEBHOOK_TIMEOUT_SECONDS=30
AP_TRIGGER_DEFAULT_POLL_INTERVAL=5

# Database
AP_DB_TYPE=POSTGRES
AP_POSTGRES_HOST=postgres
AP_POSTGRES_PORT=5432
AP_POSTGRES_DATABASE=qadam_flow
AP_POSTGRES_USERNAME=postgres
AP_POSTGRES_PASSWORD=${pg_password}
AP_POSTGRES_USE_SSL=false

# Queue + cache
AP_REDIS_TYPE=STANDALONE
AP_REDIS_HOST=redis
AP_REDIS_PORT=6379

# Secrets — regenerated per install
AP_ENCRYPTION_KEY=${enc_key}
AP_JWT_SECRET=${jwt_secret}

# Telemetry
AP_TELEMETRY_ENABLED=false

# Engine
AP_EXECUTION_MODE=UNSANDBOXED
EOF
}

# ---------- run --------------------------------------------------------------

pull_images() {
  log "pulling ${QADAM_FLOW_IMAGE} (≈400 MB, one-time)"
  compose pull
}

start_stack() {
  log "starting postgres, redis, app, and workers"
  compose up -d
}

# ---------- PostgreSQL major upgrade (#611) ----------------------------------
#
# A PostgreSQL major cannot open another major's data directory. Installs from before #611 keep
# PostgreSQL 14 data in the postgres_data volume, while the current compose file runs PostgreSQL 18 on
# the pgdata volume. upgrade_postgres copies the data across: pg_dump with the old image, pg_restore
# with the new one. It never deletes postgres_data, so going back stays possible. pg_upgrade is not
# used, because it needs the old and the new binaries in one container and no pgvector image has both.

# The decision alone, with no docker in it, so tools/ci/test-run-sh.sh can drive every branch.
#   $1 legacy major: PG_VERSION in postgres_data, '' when that volume holds no cluster
#   $2 target major: PG_MAJOR of the compose file's postgres image, '' when unknown
#   $3 state of the new volume: absent | empty | upgraded | stale | populated
# Prints none, upgrade, stale or partial. The last two are refusals.
pg_upgrade_action() {
  case "$1" in ''|*[!0-9]*) echo none; return 0 ;; esac
  case "$2" in ''|*[!0-9]*) echo none; return 0 ;; esac
  # Before 18 the compose file mounted postgres_data as the data directory itself (an older
  # QADAM_FLOW_REF does), so the legacy cluster is the live one and there is nothing to move.
  if [ "$2" -lt 18 ] || [ "$1" -ge "$2" ]; then
    echo none
    return 0
  fi
  case "$3" in
    absent|empty) echo upgrade ;;
    upgraded) echo none ;;
    stale) echo stale ;;
    *) echo partial ;;
  esac
}

# Compose prefixes volume names with the project name. `compose config` resolves it the way `up` does
# (COMPOSE_PROJECT_NAME, a `name:` in an override file, the directory name). The fallback repeats
# Compose's normalisation of the directory name, for a compose binary that does not print it.
compose_project_name() {
  project_name=$(compose config 2>/dev/null | sed -n 's/^name: *//p' | head -n 1)
  if [ -z "$project_name" ]; then
    project_name=$(normalize_project_name "$(basename "$(pwd)")")
  fi
  printf '%s' "$project_name"
}

normalize_project_name() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-' | sed 's/^[-_]*//'
}

image_pg_major() {
  docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null \
    | sed -n 's/^PG_MAJOR=//p' | head -n 1
}

volume_exists() {
  docker volume inspect "$1" >/dev/null 2>&1
}

# The probes below mount volumes read-only into a short-lived container from the target image. `docker
# run -v` would create a missing volume, so each one checks that the volume exists first.
legacy_pg_major() {
  volume_exists "$2" || return 0
  docker run --rm --network none --entrypoint cat -v "$2:/legacy:ro" "$1" /legacy/PG_VERSION 2>/dev/null || true
}

# The two scripts below run inside a container from the target image, with the old volume at $LEGACY,
# the new one at $DATA and the marker file name in $MARKER. They are kept as text so that
# tools/ci/test-run-sh.sh runs exactly these against fixture directories. The marker they write and
# compare is the format the guard in docker-compose.yml reads, and the one the docs' manual steps write.
#
# The state of the new volume:
#   upgraded: the marker matches the old cluster's current pg_control, so the copy is current.
#   stale: the marker is there but pg_control changed, so the old major ran after the upgrade.
#   populated: a cluster with no marker, i.e. a restore that never finished.
#   empty: no cluster at all.
# An unreadable pg_control fails the probe instead of comparing an empty checksum.
# shellcheck disable=SC2016
PG_STATE_PROBE='
if [ -e "$DATA/$MARKER" ]; then
  fingerprint=$(cksum < "$LEGACY/global/pg_control") || exit 1
  if [ "$fingerprint" = "$(cat "$DATA/$MARKER")" ]; then echo upgraded; else echo stale; fi
elif [ -s "$DATA/PG_VERSION" ] || ls "$DATA"/*/docker/PG_VERSION >/dev/null 2>&1; then
  echo populated
else
  echo empty
fi'
# shellcheck disable=SC2016
PG_MARKER_WRITE='
fingerprint=$(cksum < "$LEGACY/global/pg_control") || exit 1
umask 022
printf "%s\n" "$fingerprint" > "$DATA/$MARKER"'

# Every database a client can connect to, postgres included: an install may keep its data there
# (AP_POSTGRES_DATABASE=postgres), and the list is also what the restore is checked against.
PG_DATABASES_SQL='SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname'
PG_POSTGRES_DB_SETTINGS_SQL="SELECT coalesce(r.rolname, '(every role)') || ': ' || array_to_string(s.setconfig, ', ')
  FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase LEFT JOIN pg_roles r ON r.oid = s.setrole
  WHERE d.datname = 'postgres' ORDER BY 1"

pg_data_volume_state() {
  if ! volume_exists "$3"; then
    echo absent
    return 0
  fi
  docker run --rm --network none --entrypoint sh \
    -e LEGACY=/legacy -e DATA=/data -e "MARKER=${PG_UPGRADE_MARKER}" \
    -v "$2:/legacy:ro" -v "$3:/data:ro" "$1" -c "$PG_STATE_PROBE"
}

# initdb has already created the postgres database in the new cluster, so its dump is restored into
# it. Every other database is created by pg_restore --create, with the encoding, locale and settings
# it had.
pg_restore_creates_database() {
  [ "$1" != postgres ]
}

dump_file_name() {
  printf '%s.dump' "$(printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '_')"
}

# A stop before the removal, so a temporary server still running gets a clean shutdown rather than
# the SIGKILL of `rm -f`.
remove_container() {
  docker stop -t 120 "$1" >/dev/null 2>&1 || true
  docker rm -f "$1" >/dev/null 2>&1 || true
}

wait_for_pg() {
  pg_deadline=$(( $(date +%s) + 300 ))
  while [ "$(date +%s)" -lt "$pg_deadline" ]; do
    if [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" != true ]; then
      docker logs --tail 20 "$1" >&2 2>&1 || true
      die "PostgreSQL in the $1 container exited before it was ready"
    fi
    # Over TCP on purpose: during a first start the image's entrypoint runs a socket-only temporary
    # server to initialise the cluster, and pg_isready on the socket would report that one as ready.
    if docker exec "$1" pg_isready -q -h 127.0.0.1 -U "$pg_user" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  die "PostgreSQL in the $1 container was not ready within 5 minutes"
}

# $1 is the sentence that introduces the command; what "the data" means differs before and after a
# finished upgrade.
pg_rollback_hint() {
  printf '%s\n' "$1" \
    "  curl -fsSL https://flow.aiqadam.org/run.sh | QADAM_FLOW_DIR=$(shell_quote "$install_dir") QADAM_FLOW_REF=${PG_ROLLBACK_REF} sh"
}

pg_upgrade_cleanup() {
  remove_container "$PG_UPGRADE_OLD_CONTAINER"
  remove_container "$PG_UPGRADE_NEW_CONTAINER"
  if [ "$pg_upgrade_state" = new-volume ]; then
    # Only this run wrote to the new volume (it was absent or empty when the run began), so removing
    # it loses nothing and lets the next run start over instead of refusing a half-restored copy.
    compose rm -f -s postgres >/dev/null 2>&1 || true
    docker volume rm "$data_volume" >/dev/null 2>&1 \
      || warn "could not remove the incomplete ${data_volume} volume; remove it before re-running: docker volume rm ${data_volume}"
  fi
  err "the PostgreSQL upgrade did not finish. ${legacy_volume} still holds your PostgreSQL ${legacy_major} data and was not deleted."
  err "anything dumped so far is in ${backup_dir}. The stack is stopped. Re-run the installer to try again."
  pg_rollback_hint "To start the stack on PostgreSQL ${legacy_major} again instead:" >&2
}

# For an install the installer cannot check: say loudly that the data may still need moving, and where
# the postgres service says so if it does.
warn_upgrade_not_checked() {
  warn "$1, so the installer could not check whether ${legacy_volume} holds PostgreSQL data from before 18, or upgrade it."
  warn "if it does, the postgres service refuses to start; see: cd $(shell_quote "$install_dir") && docker compose logs postgres"
  warn "and upgrade by hand: https://flow.aiqadam.org/docs/install/guides/upgrade-postgres#upgrade-by-hand"
}

upgrade_postgres() {
  install_dir=$(pwd)
  project=$(compose_project_name)
  legacy_volume="${project}_${PG_LEGACY_VOLUME_KEY}"
  data_volume="${project}_${PG_DATA_VOLUME_KEY}"
  # A run killed outright (SIGKILL, a host reboot) cannot clean up after itself. Its temporary server
  # may still be running on a volume compose is about to start, and two servers on one data directory
  # corrupt it, so they go before anything else.
  remove_container "$PG_UPGRADE_OLD_CONTAINER"
  remove_container "$PG_UPGRADE_NEW_CONTAINER"
  pg_image=$(compose config --images postgres 2>/dev/null | head -n 1)
  if [ -z "$pg_image" ]; then
    if volume_exists "$legacy_volume"; then
      warn_upgrade_not_checked "docker compose config --images did not name the postgres image"
    fi
    return 0
  fi
  target_major=$(image_pg_major "$pg_image")
  legacy_major=$(legacy_pg_major "$pg_image" "$legacy_volume")
  [ -n "$legacy_major" ] || return 0
  if [ -z "$target_major" ]; then
    warn_upgrade_not_checked "the postgres image ${pg_image} does not declare PG_MAJOR"
    return 0
  fi
  data_state=$(pg_data_volume_state "$pg_image" "$legacy_volume" "$data_volume") \
    || die "could not inspect the ${data_volume} volume"

  case "$(pg_upgrade_action "$legacy_major" "$target_major" "$data_state")" in
    none) return 0 ;;
    upgrade) ;;
    stale)
      err "${legacy_volume} was used by PostgreSQL ${legacy_major} after it was upgraded into ${data_volume}, so that copy is out of date. Nothing was changed."
      err "to upgrade the newer data, delete the older copy and re-run the installer. This deletes whatever was written while on PostgreSQL ${target_major}:"
      err "  cd $(shell_quote "$install_dir") && docker compose down && docker volume rm ${data_volume}"
      die "to stay on PostgreSQL ${legacy_major}, re-run with QADAM_FLOW_REF=${PG_ROLLBACK_REF}"
      ;;
    *)
      err "${data_volume} holds a PostgreSQL cluster but no record of a finished upgrade, so an earlier upgrade was interrupted. Nothing was changed; your data is still in ${legacy_volume}."
      err "remove the incomplete copy and re-run the installer (back it up first if you started PostgreSQL ${target_major} on it yourself and wrote data there):"
      die "  cd $(shell_quote "$install_dir") && docker compose down && docker volume rm ${data_volume}"
      ;;
  esac

  case "$legacy_major" in
    # What every compose file before #611 pinned, so it is already on the host.
    14) legacy_image='pgvector/pgvector:0.8.0-pg14' ;;
    13|15|16|17) legacy_image="pgvector/pgvector:0.8.7-pg${legacy_major}" ;;
    *) die "${legacy_volume} holds PostgreSQL ${legacy_major} data, which the installer cannot upgrade; see https://flow.aiqadam.org/docs/install/guides/upgrade-postgres" ;;
  esac
  pg_user=$(env_value AP_POSTGRES_USERNAME)
  pg_user=${pg_user:-postgres}
  pg_password=$(env_value AP_POSTGRES_PASSWORD)
  [ -n "$pg_password" ] || die "AP_POSTGRES_PASSWORD is empty in ${install_dir}/.env, so PostgreSQL ${target_major} cannot be initialised"
  backup_dir="${install_dir}/backups/postgres${legacy_major}-$(date +%Y%m%d-%H%M%S)"

  log "PostgreSQL ${legacy_major} data found in ${legacy_volume}: upgrading it to PostgreSQL ${target_major} in ${data_volume}"
  log "${legacy_volume} is kept, not deleted, so you can go back"

  pg_upgrade_state=started
  trap pg_upgrade_cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  log "stopping the stack"
  compose stop
  for busy_volume in "$legacy_volume" "$data_volume"; do
    if [ -n "$(docker ps -q --filter "volume=${busy_volume}")" ]; then
      die "a running container still uses ${busy_volume}; stop it and re-run the installer. To list it: docker ps --filter volume=${busy_volume}"
    fi
  done
  # The dumps hold every credential the app stores, so they get the same treatment as .env. The umask
  # covers the files the redirections below create, and is put back once the upgrade has finished.
  pg_saved_umask=$(umask)
  umask 077
  mkdir -p "$backup_dir"

  log "starting PostgreSQL ${legacy_major} (${legacy_image}) on ${legacy_volume} to dump it"
  docker run -d --name "$PG_UPGRADE_OLD_CONTAINER" --network none \
    -v "${legacy_volume}:/var/lib/postgresql/data" "$legacy_image" >/dev/null \
    || die "could not start ${legacy_image} on ${legacy_volume}"
  wait_for_pg "$PG_UPGRADE_OLD_CONTAINER"

  log "dumping into ${backup_dir}"
  docker exec "$PG_UPGRADE_OLD_CONTAINER" pg_dumpall -U "$pg_user" --roles-only > "${backup_dir}/roles.sql" \
    || die "pg_dumpall --roles-only failed"
  docker exec "$PG_UPGRADE_OLD_CONTAINER" psql -X -A -t -U "$pg_user" -d postgres -c "$PG_DATABASES_SQL" \
    > "${backup_dir}/databases.txt" || die "could not list the databases to dump"
  # The server's own configuration lives in the data directory, not in any database, so the restore
  # does not carry it across. A copy is kept for reference.
  for conf_file in postgresql.conf postgresql.auto.conf pg_hba.conf; do
    docker exec "$PG_UPGRADE_OLD_CONTAINER" cat "/var/lib/postgresql/data/${conf_file}" > "${backup_dir}/${conf_file}" 2>/dev/null \
      || rm -f "${backup_dir}/${conf_file}"
  done
  if grep -q -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "${backup_dir}/postgresql.auto.conf" 2>/dev/null; then
    warn "postgresql.auto.conf holds ALTER SYSTEM settings, which the upgrade does not carry over. A copy is in ${backup_dir}; re-apply what you still need on PostgreSQL ${target_major} with ALTER SYSTEM."
  fi
  # pg_restore carries a database's own settings only when it creates the database, which it does not
  # for postgres (see pg_restore_creates_database).
  docker exec "$PG_UPGRADE_OLD_CONTAINER" psql -X -A -t -U "$pg_user" -d postgres -c "$PG_POSTGRES_DB_SETTINGS_SQL" \
    > "${backup_dir}/postgres-database-settings.txt" || die "could not read the settings of the postgres database"
  if [ -s "${backup_dir}/postgres-database-settings.txt" ]; then
    warn "the postgres database has ALTER DATABASE or ALTER ROLE ... IN DATABASE settings, which the upgrade does not carry over. They are listed in ${backup_dir}/postgres-database-settings.txt; re-apply what you still need on PostgreSQL ${target_major}."
  else
    rm -f "${backup_dir}/postgres-database-settings.txt"
  fi
  while IFS= read -r db; do
    [ -n "$db" ] || continue
    log "  ${db}"
    docker exec "$PG_UPGRADE_OLD_CONTAINER" pg_dump -U "$pg_user" -Fc -d "$db" \
      > "${backup_dir}/$(dump_file_name "$db")" < /dev/null || die "pg_dump of ${db} failed"
  done < "${backup_dir}/databases.txt"
  docker stop -t 120 "$PG_UPGRADE_OLD_CONTAINER" >/dev/null
  remove_container "$PG_UPGRADE_OLD_CONTAINER"

  log "starting PostgreSQL ${target_major} on a new ${data_volume} volume"
  # Compose creates the volume, so it carries Compose's labels and `up` adopts it without a warning.
  compose up --no-start postgres
  pg_upgrade_state=new-volume
  POSTGRES_USER=$pg_user POSTGRES_PASSWORD=$pg_password docker run -d --name "$PG_UPGRADE_NEW_CONTAINER" \
    --network none -e POSTGRES_USER -e POSTGRES_PASSWORD -e POSTGRES_DB=postgres \
    -v "${data_volume}:/var/lib/postgresql" "$pg_image" >/dev/null \
    || die "could not start ${pg_image} on ${data_volume}"
  wait_for_pg "$PG_UPGRADE_NEW_CONTAINER"

  log "restoring into PostgreSQL ${target_major}"
  # The new cluster already has the bootstrap role, so its CREATE ROLE is the one statement that would
  # fail; the ALTER ROLE after it still carries the old password hash across.
  grep -v -x -F -e "CREATE ROLE ${pg_user};" -e "CREATE ROLE \"${pg_user}\";" "${backup_dir}/roles.sql" \
    | docker exec -i "$PG_UPGRADE_NEW_CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U "$pg_user" -d postgres >/dev/null \
    || die "restoring the roles failed"
  while IFS= read -r db; do
    [ -n "$db" ] || continue
    log "  ${db}"
    # No --clean for postgres: this run initialised the cluster a moment ago, so the database is empty.
    if pg_restore_creates_database "$db"; then
      docker exec -i "$PG_UPGRADE_NEW_CONTAINER" pg_restore -U "$pg_user" --exit-on-error --create -d postgres \
        < "${backup_dir}/$(dump_file_name "$db")" || die "pg_restore of ${db} failed"
    else
      docker exec -i "$PG_UPGRADE_NEW_CONTAINER" pg_restore -U "$pg_user" --exit-on-error -d "$db" \
        < "${backup_dir}/$(dump_file_name "$db")" || die "pg_restore of ${db} failed"
    fi
  done < "${backup_dir}/databases.txt"
  docker exec "$PG_UPGRADE_NEW_CONTAINER" psql -X -A -t -U "$pg_user" -d postgres -c "$PG_DATABASES_SQL" \
    > "${backup_dir}/databases-restored.txt" || die "could not list the restored databases"
  cmp -s "${backup_dir}/databases.txt" "${backup_dir}/databases-restored.txt" \
    || die "the restored databases do not match the dumped ones (compare ${backup_dir}/databases.txt and databases-restored.txt)"
  rm -f "${backup_dir}/databases-restored.txt"

  docker stop -t 120 "$PG_UPGRADE_NEW_CONTAINER" >/dev/null
  remove_container "$PG_UPGRADE_NEW_CONTAINER"
  # Only now that no server runs on the new volume: the marker is what lets compose start one there,
  # and two servers on one data directory corrupt it.
  docker run --rm --network none --entrypoint sh \
    -e LEGACY=/legacy -e DATA=/data -e "MARKER=${PG_UPGRADE_MARKER}" \
    -v "${legacy_volume}:/legacy:ro" -v "${data_volume}:/data" "$pg_image" -c "$PG_MARKER_WRITE" \
    || die "could not record the finished upgrade"

  pg_upgrade_state=finished
  trap - EXIT HUP INT TERM
  umask "$pg_saved_umask"
  log "PostgreSQL ${legacy_major} → ${target_major} upgrade finished"
  PG_UPGRADE_SUMMARY=$(
    printf '%s\n' \
      "PostgreSQL was upgraded from ${legacy_major} to ${target_major}. The data now lives in ${data_volume}." \
      "The dump taken before the upgrade is in ${backup_dir}." \
      "It holds password hashes and the encrypted connection credentials: keep it safe, and delete it once you no longer need a way back." \
      "${legacy_volume} still holds the PostgreSQL ${legacy_major} data. Once you are satisfied, free its space with:" \
      "  cd $(shell_quote "$install_dir") && docker compose down && docker volume rm ${legacy_volume} && docker compose up -d"
    pg_rollback_hint "To go back to PostgreSQL ${legacy_major} with the data as it was before the upgrade (anything written since is only in ${data_volume}):"
  )
  # Printed here as well as in the final banner, which a failed start never reaches.
  printf '\n%s\n\n' "$PG_UPGRADE_SUMMARY"
}

wait_for_app() {
  HEALTH_URL="http://localhost:${QADAM_FLOW_PORT}/api/v1/flags"
  log "waiting for the app at ${HEALTH_URL}"
  deadline=$(( $(date +%s) + 180 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS -m 2 "$HEALTH_URL" >/dev/null 2>&1; then
      log "app is up"
      return 0
    fi
    sleep 2
  done
  err "app didn't respond within 3 min — check: cd $QADAM_FLOW_DIR && docker compose logs app postgres"
  return 1
}

# ---------- banner -----------------------------------------------------------

banner() {
  cat <<EOF
${C_TEAL}${C_BOLD}
   Qadam Flow installer
${C_RESET}${C_DIM}an AI Qadam Build project — https://flow.aiqadam.org${C_RESET}

EOF
}

# The upgrade hint prints the install dir as an absolute QADAM_FLOW_DIR: a relative one only
# resolves from the directory the first run started in. From anywhere else it creates a second install
# with fresh secrets, which takes over this one's fixed container names and, when the directory name
# matches, its compose project and postgres volume, which the new password cannot open.
shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

final_banner() {
  cat <<EOF

${C_TEAL}${C_BOLD}Qadam Flow${C_RESET} is running at ${C_BOLD}http://localhost:${QADAM_FLOW_PORT}${C_RESET}
   installed in ${C_BOLD}$(pwd)${C_RESET}

${C_DIM}First-time onboarding:${C_RESET}
  1. Open ${C_BOLD}http://localhost:${QADAM_FLOW_PORT}/sign-up${C_RESET} — first signup owns the platform.
  2. Name the platform when prompted.
  3. From the welcome dashboard, pick a template or start a flow from scratch.

${C_DIM}Common commands (from $(pwd)):${C_RESET}
  docker compose logs -f app worker   follow logs
  docker compose down                 stop (keep data)
  docker compose down -v              stop AND wipe data

${C_DIM}To upgrade, re-run the installer against this directory. It refreshes docker-compose.yml, which${C_RESET}
${C_DIM}pins the Postgres and Redis images, and keeps .env; docker compose pull alone updates only the app.${C_RESET}
  curl -fsSL https://flow.aiqadam.org/run.sh | QADAM_FLOW_DIR=$(shell_quote "$(pwd)") sh
${PG_UPGRADE_SUMMARY:+
$PG_UPGRADE_SUMMARY
}
${C_DIM}an AI Qadam Build project — https://flow.aiqadam.org${C_RESET}
EOF
}

# ---------- main -------------------------------------------------------------

main() {
  banner
  detect_platform
  log "platform: $PLATFORM"
  check_prereqs
  validate_port
  prepare_dir
  fetch_compose
  generate_env
  # Both of these run after generate_env because reconcile_port can replace QADAM_FLOW_PORT with a
  # value adopted from an existing .env — a value no earlier check has seen.
  validate_port "QADAM_FLOW_PORT in $(pwd)/.env"
  check_compose_port
  pull_images
  # Between the pull and the start: it needs the new postgres image, and PostgreSQL 18 must not be
  # started before its data has been restored.
  upgrade_postgres
  start_stack
  wait_for_app
  final_banner
}

# Sourcing with QADAM_FLOW_SOURCE_ONLY=1 loads the helpers without installing anything, which is how
# tools/ci/test-run-sh.sh drives reconcile_port / set_env_value over .env fixtures. `curl | sh` never
# sets it, so the install path is unchanged.
if [ "${QADAM_FLOW_SOURCE_ONLY:-}" != 1 ]; then
  main "$@"
fi
