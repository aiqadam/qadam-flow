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
docker build --build-arg SKIP_SSL_VERIFY=true -t ghcr.io/aiqadam/qadam-flow:latest .
docker compose up -d
```

`docker-compose.yml` reads the image name from `$QADAM_FLOW_IMAGE`
(default `ghcr.io/aiqadam/qadam-flow:latest`). Tag a local build with
that name (or override the env var) so the registry pull is skipped.

## Stack
- **app** (port 8080:80) — API + frontend via PM2
- **worker** ×5 — BullMQ job workers
- **postgres** — `pgvector/pgvector:0.8.0-pg14`
- **redis** — `redis:7.0.7`

## Key ENV vars
- `AP_QADAMS_SYNC_MODE=NONE` — disable cloud piece sync (no registry available)
- `AP_ENVIRONMENT=PRODUCTION` (use `DEVELOPMENT` only to opt into dev seeds)
- `SKIP_SSL_VERIFY=true` build arg — for VPN/proxy environments with SSL interception
- `QADAM_FLOW_IMAGE` — override the image tag picked up by `docker-compose.yml`

## Reset
```bash
docker compose down -v   # remove volumes (clean DB)
./run.sh                 # or docker compose up -d
```

## Useful one-liners
- `docker compose logs -f app worker` — tail app + worker output
- `docker compose pull && docker compose up -d` — upgrade to the latest image
- `docker exec postgres psql -U postgres -d qadam_flow` — open a psql shell

## Known Issues Fixed in Local Build
- Missing entities: `ConcurrencyPoolEntity`, `ProjectRoleEntity` — restored after EE removal
- Project controller/module deleted during EE cleanup — `GET /v1/projects` returns 404 without it
- Authorization: `UserPrincipal` JWT has no `projectId` — fixed to check platform membership via DB
- Baseline migration not idempotent — added `IF NOT EXISTS` and `EXCEPTION WHEN duplicate_object`
- `en_natural` collation missing — added `CREATE COLLATION` before `qadam_metadata` table; ICU also unsupported on pglite (handled via additional `EXCEPTION WHEN feature_not_supported`)
