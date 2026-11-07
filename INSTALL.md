# Install Qadam Flow from source without Docker

This guide runs Qadam Flow from source on a single Linux or macOS host, using an existing
PostgreSQL and Redis instead of Docker. It builds a minimal core catalog of qadams so the flow
builder is usable without compiling all 238 integrations, and it runs the React frontend with
Vite for hot reload.

Tested with Node.js 22.22.0, PostgreSQL 18.6 with pgvector 0.8.7, and Redis 8.0.6 on Linux.

## What you get

| Component | Address | Notes |
| --- | --- | --- |
| Web (React + Vite) | `http://localhost:4200` | Hot reload, proxies `/api` and socket.io to the API |
| API (Fastify) | `http://localhost:3000` | Runs migrations and the dev seed on first start |
| Worker | no port | Connects to the API over socket.io and runs flows |
| PostgreSQL | your existing server | Schema is created by migrations |
| Redis | your existing server, dedicated DB index | Queues, cache, distributed locks |

## Requirements

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | 22 or 24 | Tested on 22.22.0. The repo pins 24.21.0 in `.nvmrc` and the Dockerfile |
| bun | 1.3.14 | Installed by `tools/scripts/install-bun.js`; do not use `npm install` for dependencies |
| PostgreSQL | 14 or newer | Tested on 18.6 |
| pgvector | 0.8.x | Tested on 0.8.7. The baseline migration runs `CREATE EXTENSION IF NOT EXISTS vector` |
| Redis or Valkey | 7 or newer / 8 | Tested on Redis 8.0.6 |
| Build tools | `g++`, `make`, `python3`, `node-gyp` | `g++` 14 or 13 is required for `isolated-vm`; `g++` 16 fails |
| RAM | 4 GB minimum with swap, 8 GB recommended | The dev stack (Vite + API + worker + TypeScript) is memory hungry |
| Disk | about 10 GB free | `node_modules` is roughly 2.5 GB, plus build output |
| Ports | 3000 and 4200 free | Change `AP_PORT` and the Vite port if they are taken |

## 1. Clone the repository

```bash
git clone https://github.com/aiqadam/qadam-flow.git
cd qadam-flow
```

The API and worker read the env file named by `QF_ENV_FILE` and fall back to `.env.dev`. The
`npm run dev:prod` script below sets `QF_ENV_FILE=.env.prod` for both processes. If you run the
turbo commands by hand, export `QF_ENV_FILE` yourself or the app will load `.env.dev`.

## 2. Prepare PostgreSQL

Create a database and a login role. Run the extension statement as a PostgreSQL superuser,
because pgvector is not a trusted extension:

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE qadam_flow LOGIN PASSWORD 'change-me';
CREATE DATABASE qadam_flow OWNER qadam_flow;
\c qadam_flow
CREATE EXTENSION IF NOT EXISTS vector;
SQL
```

If the role or database already exists, skip the matching `CREATE` statement. On macOS, use
`psql postgres` as your PostgreSQL superuser instead of `sudo -u postgres psql`.

Verify the connection and the extension:

```bash
psql "postgresql://qadam_flow:change-me@127.0.0.1:5432/qadam_flow" \
  -c "select extversion from pg_extension where extname = 'vector';"
```

Expected output: `0.8.7` (or the version you installed).

If `CREATE EXTENSION` fails, install pgvector for your PostgreSQL major version first. On
Debian and Ubuntu the package is `postgresql-<major>-pgvector`.

## 3. Prepare Redis

Use a dedicated Redis database index. The default `0` is often shared with other applications,
and Qadam Flow will write queues and locks into whichever index you choose. This guide uses `3`.

```bash
redis-cli ping
redis-cli -n 3 dbsize
```

`PING` must return `PONG`. `dbsize` should return `0` for a fresh index, or a number you
recognize as your own keys. Do not point Qadam Flow at an index another application is using.

## 4. Create `.env.prod`

`.env.prod` is ignored by git (the `.gitignore` rule is `.env*`), so your secrets stay out of the
repository. Create it in the repository root:

```bash
cat > .env.prod <<'EOF'
# Runtime
AP_ENVIRONMENT=dev
AP_LOG_LEVEL=info
AP_LOG_PRETTY=true
AP_TELEMETRY_ENABLED=false
AP_DEV_QADAMS=
AP_EXECUTION_MODE=UNSANDBOXED
AP_FLOW_TIMEOUT_SECONDS=600
AP_WEBHOOK_TIMEOUT_SECONDS=30
AP_TRIGGER_DEFAULT_POLL_INTERVAL=5

# PostgreSQL
AP_DB_TYPE=POSTGRES
AP_POSTGRES_HOST=127.0.0.1
AP_POSTGRES_PORT=5432
AP_POSTGRES_DATABASE=qadam_flow
AP_POSTGRES_USERNAME=qadam_flow
AP_POSTGRES_PASSWORD=change-me
AP_POSTGRES_USE_SSL=false

# Redis
AP_REDIS_TYPE=STANDALONE
AP_REDIS_HOST=127.0.0.1
AP_REDIS_PORT=6379
AP_REDIS_DB=3

# Secrets — replace every value below before the first start
# AP_ENCRYPTION_KEY must be exactly 32 hexadecimal characters
AP_ENCRYPTION_KEY=00000000000000000000000000000000
AP_JWT_SECRET=replace-with-a-long-random-string
AP_WORKER_TOKEN=replace-with-the-generated-token

# URLs and process type
AP_FRONTEND_URL=http://localhost:4200
AP_INTERNAL_URL=http://localhost:3000
AP_PORT=3000
AP_CONTAINER_TYPE=APP
AP_CLOUD_AUTH_ENABLED=false

# Worker
AP_WORKER_API_URL=http://localhost:3000
EOF
```

Generate the encryption key and the JWT secret:

```bash
openssl rand -hex 16   # AP_ENCRYPTION_KEY, 32 characters
openssl rand -hex 32   # AP_JWT_SECRET
```

Generate a worker token signed with `AP_JWT_SECRET`. This snippet has no npm dependencies:

```bash
set -a
. ./.env.prod
set +a

node -e '
const crypto = require("crypto")
const secret = process.env.AP_JWT_SECRET
if (!secret) { console.error("AP_JWT_SECRET is not set"); process.exit(1) }
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url")
const now = Math.floor(Date.now() / 1000)
const header = b64({ alg: "HS256", typ: "JWT", kid: "1" })
const payload = b64({
  id: crypto.randomUUID(),
  type: "WORKER",
  iat: now,
  exp: now + 100 * 365 * 24 * 60 * 60,
  iss: "qadam-flow",
})
const signature = crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url")
console.log(`${header}.${payload}.${signature}`)
'
```

Copy the output into `AP_WORKER_TOKEN`. If you change `AP_JWT_SECRET` later, regenerate the
token; the worker will fail to authenticate otherwise.

Qadam Flow is migrating its environment variables from `AP_` to `QF_`. The `AP_` names above
still work and match the committed `.env.dev`, but each one logs a one-time
`[env-migrations] AP_... is deprecated` warning at start-up. Renaming any of them to `QF_` (for
example `QF_ENVIRONMENT`) silences that variable's warning; the two names are equivalent.
`QF_ENV_FILE` is already on the new prefix because it is read before that migration runs.

`AP_ENVIRONMENT=dev` creates the local account `dev@ap.com` with password `12345678` on first
start. That seed is for local development only. `AP_CONTAINER_TYPE=APP` is shared by the API and
the worker in this single-file setup; the worker only uses it to decide whether to open a health
server, so it does not bind a second listener on port 3000.

## 5. Install dependencies

Install the pinned bun version, then install the workspace with bun:

```bash
node tools/scripts/install-bun.js

CXX=g++-14 CC=gcc-14 REDISMS_DISABLE_POSTINSTALL=1 bun install
```

`REDISMS_DISABLE_POSTINSTALL=1` skips the `redis-memory-server` postinstall, which compiles
Redis from source and is broken. This setup uses a real Redis, so the embedded binary is not
needed. The first install downloads roughly 2.5 GB and can take several minutes.

`CXX=g++-14` works around a compile error in `isolated-vm` 7.0.1 with g++ 16. If
`g++ --version` reports 14 or 13, you can omit both compiler variables.

Verify that the native module loads:

```bash
cd packages/server/engine
node -e "const ivm = require('isolated-vm'); console.log(typeof ivm.Isolate)"
cd ../..
```

Expected output: `function`.

Do not run `npm install` for the workspace. npm's arborist fails on this repository's
dependency graph; use bun as shown above. The `npm run ...` scripts still work because they
delegate to turbo.

## 6. Build the minimal core

```bash
npm run build:core-min
```

This builds the shared packages, the engine, and ten core qadams:

`manual-trigger`, `http`, `webhook`, `delay`, `subflows`, `data-mapper`, `schedule`, `approval`,
`store`, `tables`.

The engine build writes `dist/packages/engine/main.js`, which the worker needs to execute flows.
Each qadam build writes `packages/qadams/core/<name>/dist`, which the API scans at start-up. With
`AP_DEV_QADAMS` empty, every built qadam dist is loaded. The `serve` step may also build a few
qadams that the API lists as devDependencies for its test suite (currently `slack`, `intercom`,
`facebook-leads`, and `telegram-bot`), so the catalog can show those as well. To restrict the
catalog to an explicit list, set `AP_DEV_QADAMS` to a comma-separated list of qadam names.

To build the full catalog instead, expect a long compile on a 4-core machine:

```bash
npx turbo run build --filter='@aiqadam/qadam-*' --concurrency=2
```

## 7. Start the stack

```bash
npm run dev:prod
```

The script runs three steps:

1. Checks or installs bun at the pinned version.
2. Runs `build:core-min`; turbo's cache makes this a few seconds after the first build.
3. Starts `web`, `api`, and `worker` with `QF_ENV_FILE=.env.prod`.

On the first start the API runs every migration, creates the schema, and seeds the dev account.
This can take from a few seconds to a couple of minutes on a small machine. The worker may log
`Socket.IO connection error` while the API is still migrating; it reconnects automatically once
port 3000 is listening.

## 8. Verify the installation

Check the API health endpoint:

```bash
curl -s http://localhost:3000/api/v1/health/
```

Expected: `{"status":"Healthy"}`.

Check the frontend:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4200/
```

Expected: `200`.

Open `http://localhost:4200` and sign in with `dev@ap.com` / `12345678`.

You can also sign in through the API and confirm the dev seed:

```bash
curl -s -X POST http://localhost:3000/api/v1/authentication/sign-in \
  -H 'Content-Type: application/json' \
  -d '{"email":"dev@ap.com","password":"12345678"}'
```

### Run a first flow

1. Open `http://localhost:4200` and sign in.
2. Create a flow with a **Manual Trigger**.
3. Add an **HTTP** action: method `GET`, URL `http://localhost:3000/api/v1/health/`,
   authentication `None`.
4. Publish or test the flow, then open the run and confirm both steps succeeded.

The API and worker logs show the queue and engine activity. If the HTTP step returns
`{"status":"Healthy"}`, the full path works: browser → API → Redis queue → worker → engine →
qadam.

## Stop and restart

If the stack runs in your terminal, press `Ctrl+C`.

If it runs in the background, stop the turbo process group:

```bash
pkill -f 'turbo run serve'
```

If a child process survives, stop it by port:

```bash
fuser -k 3000/tcp 4200/tcp        # Linux
lsof -ti tcp:3000 tcp:4200 | xargs kill   # macOS
```

Restart with the same command:

```bash
npm run dev:prod
```

PostgreSQL data and the Redis index survive a restart. The qadam dists and the engine bundle also
stay on disk, so `build:core-min` is a cache hit unless source files changed.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `npm install` fails with `Cannot read properties of null (reading 'matches')` | npm's arborist cannot resolve this workspace. Use `bun install` |
| `isolated-vm` fails with `no declaration matches 'void ivm::timer_t::wait_detached(uint32_t, const callback_t&)'` | g++ 16 is too new for isolated-vm 7.0.1. Reinstall with `CXX=g++-14 CC=gcc-14` |
| `CREATE EXTENSION vector` fails with `permission denied` | Run the statement as a PostgreSQL superuser, and install the pgvector package for your PostgreSQL major version |
| API exits with `AP_CONTAINER_TYPE is required` or `Invalid AP_CONTAINER_TYPE` | Set `AP_CONTAINER_TYPE=APP` for the API. A dedicated worker process uses `WORKER` |
| `EADDRINUSE` on 3000 or 4200 | Another process owns the port. Stop it, or change `AP_PORT`, `AP_FRONTEND_URL`, and the Vite port plus proxy entries in `packages/web/vite.config.mts` together |
| Worker logs `Socket.IO connection error` on first start | The API is still migrating. Wait for `Server listening at http://[::]:3000`; the worker reconnects |
| Worker cannot authenticate after a secret change | `AP_WORKER_TOKEN` was signed with the old `AP_JWT_SECRET`. Regenerate the token |
| `AP_ENCRYPTION_KEY is missing or invalid` | The key must be exactly 32 hexadecimal characters. Generate one with `openssl rand -hex 16` |
| The qadam catalog is empty | No `packages/qadams/**/dist` exists. Run `npm run build:core-min` |
| `[qadamVersionStore] ... unavailable; seeding is skipped` | Expected in a dev tree: the default store path `/var/lib/qadam-flow/qadam-versions` is not writable. Steps fall back to the bundled qadam build |
| `[validateEnvPropsOnStartup] DEV_QADAMS ... Expected: Value must be a non-empty string` | `AP_DEV_QADAMS` is empty. This is harmless: an empty value means "scan every built dist". Set a comma-separated list to narrow it |
| `[eventLoopMonitor] Event loop was blocked` warnings | The machine is low on RAM or CPU. Close browsers and other heavy processes, or give the machine more memory |
| Migrations fail on start-up | Confirm the role owns the database, can create tables in `public`, and that pgvector is installed in that database |
| Redis contains another application's keys | You are sharing a database index. Change `AP_REDIS_DB` to an unused index and restart |

## Moving beyond local development

This guide runs the development stack: Vite on 4200, `AP_ENVIRONMENT=dev`, and
`AP_EXECUTION_MODE=UNSANDBOXED`. Before exposing the instance to other users:

- Replace every secret in `.env.prod` with a fresh random value, and regenerate
  `AP_WORKER_TOKEN` after changing `AP_JWT_SECRET`.
- Set `AP_ENVIRONMENT=prod`. The dev seed no longer runs; create the first account through the
  sign-up flow.
- Build the frontend so the API serves it on port 3000:
  `npx turbo run build --filter=web --concurrency=2`. Set `AP_FRONTEND_URL` to the public URL
  the browser will use, and stop the Vite server; the API serves the built assets itself.
- Use a sandboxed execution mode such as `SANDBOX_PROCESS` or `SANDBOX_CODE_AND_PROCESS` if the
  host can grant the required capabilities. `UNSANDBOXED` runs flow code as the API/worker user.
- Put the API behind TLS, restrict database and Redis access to the host, and back up
  PostgreSQL.

## How the pieces connect

```text
Browser
  └── :4200 Vite dev server
        ├── /api/*            -> :3000 Fastify API
        └── /api/socket.io/*  -> :3000 socket.io

API (:3000)
  ├── PostgreSQL  schema, flows, runs, users
  └── Redis DB  queue jobs, cache, distributed locks

Worker
  ├── socket.io -> API
  └── spawns dist/packages/engine/main.js per flow run
```

The API and worker are separate processes. The worker does not serve HTTP in this setup; it
polls Redis for jobs and reports progress back to the API over the socket connection.

## Repository changes used by this guide

The setup above relies on these local changes, which are part of this branch:

- `packages/server/api/src/bootstrap.ts` and `packages/server/worker/src/bootstrap.ts` read the
  env file named by `QF_ENV_FILE` (with `AP_ENV_FILE` still accepted), defaulting to `.env.dev`.
- `tools/setup-dev.js` reads the same `QF_ENV_FILE` when it looks up `AP_DEV_PIECES`.
- `package.json` provides `build:core-min` (the ten-qadam build) and `dev:prod` (build plus
  serve with `.env.prod`).

If you apply this guide to a tree without those changes, export the variables from `.env.prod`
into your shell before starting, or point the bootstrap files at `.env.prod` directly.
