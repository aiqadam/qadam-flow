---
name: local-docker-deploy
description: Runs the Qadam Flow stack locally in Docker via run.sh or docker compose. Use when you need the app running on localhost:8080 to verify a change by hand, when you are touching run.sh, docker-compose.yml, the Dockerfile or docker-entrypoint.sh, or when debugging a container, migration or environment-variable problem in a local deployment.
---

# Local Docker Deploy

## Quick Start

Default path — pull from the registry, no source build:

```bash
./run.sh
# or from outside the repo:
curl -fsSL https://flow.aiqadam.org/run.sh | sh
# App: http://localhost:8080
```

The script writes a fresh `.env` next to `docker-compose.yml`, pulls
`ghcr.io/aiqadam/qadam-flow:latest`, brings up the stack, and waits for
the API. Re-running it is idempotent.

Build from local source instead of pulling:

```bash
docker build --build-arg SKIP_SSL_VERIFY=true \
  --build-arg PLATFORM_VERSION="$(node tools/ci/compute-main-version.mjs --counter 0)" \
  -t ghcr.io/aiqadam/qadam-flow:latest .
docker compose up -d
```

`PLATFORM_VERSION` makes the local image report a `main`-style prerelease (`<next>-main.0`, below
every CI build of the same line) instead of the last release it is not (ADR-0001, #798). Leave it
out and the image reports the root `package.json`, the last release.

`docker-compose.yml` reads the image name from `$QADAM_FLOW_IMAGE`
(default `ghcr.io/aiqadam/qadam-flow:latest`). Tag a local build with
that name (or override the env var) so the registry pull is skipped.

## Stack
- **app** (port 8080:80) — API + frontend, a single Node process under `tini`
- **worker** ×5 — BullMQ job workers
- **postgres** — `pgvector/pgvector:0.8.7-pg18`, data in the `pgdata` volume. An install from before #611 also has `postgres_data` with its PostgreSQL 14 data: `run.sh` dumps and restores it into `pgdata` and keeps it for rollback, and the service's entrypoint refuses to start next to it until that has happened (`docs/install/guides/upgrade-postgres.mdx`)
- **redis** — `valkey/valkey:8.1.10` (Valkey, the BSD-licensed Redis fork; the service, volume and `AP_REDIS_*` names stay `redis`)

## Key ENV vars
- `AP_ENVIRONMENT=prod` (use `dev` only to opt into dev seeds)
- `SKIP_SSL_VERIFY=true` build arg — for VPN/proxy environments with SSL interception
- `QADAM_FLOW_IMAGE` — override the image tag picked up by `docker-compose.yml`

## Reset
```bash
docker compose down -v   # remove volumes (clean DB)
./run.sh                 # or docker compose up -d
```

## Useful one-liners
- `docker compose logs -f app worker` — tail app + worker output
- `./run.sh` (or `curl -fsSL https://flow.aiqadam.org/run.sh | sh` from the directory containing `qadam-flow/`) — upgrade: refreshes `docker-compose.yml`, keeps `.env`, pulls and restarts. `docker compose pull && docker compose up -d` alone updates only the app image and leaves Postgres/Redis on whatever images the existing compose file pins
- `docker exec postgres psql -U postgres -d qadam_flow` — open a psql shell

## Known Issues Fixed in Local Build
- Missing entities: `ConcurrencyPoolEntity`, `ProjectRoleEntity` — restored after EE removal
- Project controller/module deleted during EE cleanup — `GET /v1/projects` returns 404 without it
- Authorization: `UserPrincipal` JWT has no `projectId` — fixed to check platform membership via DB
- Baseline migration not idempotent — added `IF NOT EXISTS` and `EXCEPTION WHEN duplicate_object`
- `en_natural` collation missing — added `CREATE COLLATION` before `qadam_metadata` table, guarded with `EXCEPTION WHEN feature_not_supported` for Postgres builds without ICU
