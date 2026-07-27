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
#   4. docker compose pull → docker compose up -d.
#   5. Waits for the API to start and prints the URL.
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

pull_and_up() {
  log "pulling ${QADAM_FLOW_IMAGE} (≈400 MB, one-time)"
  compose pull
  log "starting postgres, redis, app, and workers"
  compose up -d
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
  err "app didn't respond within 3 min — check: cd $QADAM_FLOW_DIR && docker compose logs app"
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
  docker compose pull && docker compose up -d   update to latest image

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
  pull_and_up
  wait_for_app
  final_banner
}

# Sourcing with QADAM_FLOW_SOURCE_ONLY=1 loads the helpers without installing anything, which is how
# tools/ci/test-run-sh.sh drives reconcile_port / set_env_value over .env fixtures. `curl | sh` never
# sets it, so the install path is unchanged.
if [ "${QADAM_FLOW_SOURCE_ONLY:-}" != 1 ]; then
  main "$@"
fi
