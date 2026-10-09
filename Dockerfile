FROM node:24.21.0-bookworm-slim AS base

ARG SKIP_SSL_VERIFY=

# When SKIP_SSL_VERIFY is set, disable TLS checks for npm/bun/node (VPN/proxy workaround)
ENV NODE_TLS_REJECT_UNAUTHORIZED=${SKIP_SSL_VERIFY:+0}
RUN if [ -n "$SKIP_SSL_VERIFY" ]; then npm config set strict-ssl false; fi

# redis-memory-server's postinstall compiles Redis from source, and that compile is broken. Set here
# in `base` so every `bun install` in this file inherits it — there are three, and covering only one
# leaves the next uncached build to fail exactly as before.
#
# Those binaries existed for AP_REDIS_TYPE=MEMORY, the embedded-Redis mode of the all-in-one
# container. That container mode was removed in #210 and now refuses to start, and every shipped
# install path uses a real Redis (run.sh and .env.dev set STANDALONE; docker-compose.yml runs
# valkey/valkey:8.1.10). So the mode this compile served is already gone, while the compile still
# breaks the image build for everyone. If MEMORY is ever restored as a supported mode, this needs
# revisiting: without the baked binaries it downloads and compiles Redis at container start.
ENV REDISMS_DISABLE_POSTINSTALL=1

# Set environment variables early for better layer caching
ENV LANG=en_US.UTF-8 \
    LANGUAGE=en_US:en \
    LC_ALL=en_US.UTF-8

# Install all system dependencies in a single layer with cache mounts
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        openssh-client \
        python3 \
        g++ \
        build-essential \
        git \
        poppler-utils \
        poppler-data \
        procps \
        locales \
        unzip \
        curl \
        ca-certificates \
        iptables \
        libcap-dev \
        tini && \
    yarn config set python /usr/bin/python3 && \
    sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && \
    locale-gen en_US.UTF-8

RUN export ARCH=$(uname -m) && \
    CURL_OPTS="-fSL"; \
    if [ -n "$SKIP_SSL_VERIFY" ]; then CURL_OPTS="$CURL_OPTS --insecure"; fi && \
    if [ "$ARCH" = "x86_64" ]; then \
      curl $CURL_OPTS https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64-baseline.zip -o bun.zip \
        && echo "a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7  bun.zip" | sha256sum -c -; \
    elif [ "$ARCH" = "aarch64" ]; then \
      curl $CURL_OPTS https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-aarch64.zip -o bun.zip \
        && echo "a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b  bun.zip" | sha256sum -c -; \
    fi

RUN unzip bun.zip \
    && mv bun-*/bun /usr/local/bin/bun \
    && chmod +x /usr/local/bin/bun \
    && rm -rf bun.zip bun-*

RUN bun --version

# Install global npm packages in a single layer
RUN --mount=type=cache,target=/root/.npm \
    npm install -g --no-fund --no-audit \
    node-gyp \
    npm@11.11.0 \
    typescript@4.9.4 \
    esbuild@0.25.0

# Install isolated-vm globally (needed for sandboxes). Isolate mode resolves it only from here
# (NODE_PATH=/usr/src/node_modules), fork mode from /usr/src/app/node_modules, so the two must be
# the same version. The default must equal the root package.json pin; the build stage checks it (#641).
ARG ISOLATED_VM_VERSION=7.0.1
RUN --mount=type=cache,target=/root/.bun/install/cache \
    cd /usr/src && bun install isolated-vm@${ISOLATED_VM_VERSION}

### STAGE 1: Build ###
FROM base AS build

WORKDIR /usr/src/app

# Copy dependency files and workspace package.json files for resolution
COPY .npmrc package.json bun.lock bunfig.toml ./
COPY packages/ ./packages/

# Install all dependencies.
#
# No `|| true` here, deliberately. It used to swallow install failures, so the build carried on with
# no node_modules and died 20 lines later at `npx turbo` with exit 127 (command not found) — naming
# the symptom and discarding the cause. A failed install must fail the build.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install

# Fail the build if the sandbox's isolated-vm (base stage) drifted from the manifests (#641).
RUN node -e 'const v=require("/usr/src/node_modules/isolated-vm/package.json").version;const r=require("./package.json").dependencies["isolated-vm"];const e=require("./packages/server/engine/package.json").dependencies["isolated-vm"];if(v!==r||v!==e){console.error("isolated-vm mismatch: sandbox="+v+" root="+r+" engine="+e);process.exit(1)}'

# Copy remaining source code (turbo config, etc.)
COPY . .

# Optional turbo remote cache (populated by CI via dtinth/setup-github-actions-caching-for-turbo).
# Empty in local builds — turbo silently falls back to local cache only.
ARG TURBO_API=
ARG TURBO_TOKEN=
ARG TURBO_TEAM=
ENV TURBO_API=$TURBO_API \
    TURBO_TOKEN=$TURBO_TOKEN \
    TURBO_TEAM=$TURBO_TEAM

# Build frontend, engine, server API, worker, and all bundled qadams.
# Qadams must be pre-compiled because the runtime loader scans `<qadam>/dist/`
# in standalone mode (no cloud registry).
RUN --network=host npx turbo run build --filter=web --filter=@aiqadam/engine --filter=api --filter=worker --filter='@aiqadam/qadam-*'

# Index of the bundled qadams' dist folders (packages/qadams/dist-index.json). Without it every
# fresh engine process walks the whole qadam tree before its first step can load (#419).
RUN bun packages/server/engine/src/scripts/write-qadam-dist-index.ts packages/qadams

# Generate migration manifest (ordered list of migration names) for image-tag-based rollback
RUN node -e "\
  const {getMigrations} = require('./packages/server/api/dist/src/app/database/postgres-connection');\
  const names = getMigrations().map(M => new M().name);\
  process.stdout.write(JSON.stringify(names));\
" > packages/server/api/dist/src/migration-manifest.json

### STAGE 2: Run ###
FROM base AS run

WORKDIR /usr/src/app

# Copy static configuration files first (better layer caching)
COPY --from=build /usr/src/app/packages/server/api/src/assets/default.cf /usr/local/etc/isolate
COPY docker-entrypoint.sh .

# Create all necessary directories in one layer
RUN mkdir -p \
    /usr/src/app/dist/packages/engine && \
    chmod +x docker-entrypoint.sh

# Copy root config files needed for dependency resolution
COPY --from=build /usr/src/app/package.json ./
COPY --from=build /usr/src/app/.npmrc ./
COPY --from=build /usr/src/app/bun.lock ./
COPY --from=build /usr/src/app/bunfig.toml ./
COPY --from=build /usr/src/app/LICENSE .
COPY --from=build /usr/src/app/NOTICE .

# Copy workspace package.json files (needed for bun workspace resolution)
COPY --from=build /usr/src/app/packages ./packages
# The engine falls back to a tree walk without it, so a manifest lost on the way here would slow
# every fresh engine without failing anything (#419).
RUN test -s packages/qadams/dist-index.json

# Copy built engine
COPY --from=build /usr/src/app/dist/packages/engine/ ./dist/packages/engine/

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --production

# Reset TLS check for runtime — SSL skip was build-time only
ENV NODE_TLS_REJECT_UNAUTHORIZED=

# Serialized metadata of every bundled qadam (packages/qadams/bundled-qadams-metadata.json). Without
# it the app's first catalogue read require()s all 238 qadams on its event loop, which blocked every
# request for 30–63 s on QA after each start (#598). Written here, after the production install and
# not in the build stage, so the app's own scan code builds it against the exact tree and
# node_modules it would scan at run time. Nothing under packages/ (qadam dists, node_modules) may
# change after this step, or the manifest no longer describes the image. The writer fails the build
# when it finds no built qadam or any of them fails to load; `test -s` catches an empty file anyway.
RUN node packages/server/api/dist/src/scripts/write-bundled-qadams-manifest.js packages/qadams \
    && test -s packages/qadams/bundled-qadams-metadata.json

# Copy frontend files
COPY --from=build /usr/src/app/dist/packages/web ./dist/packages/web/

# Build provenance, baked in by CI (see ci.yml's build-args). Empty on a plain local
# `docker build` — .git is excluded via .dockerignore, so there is no fallback to
# compute here; the frontend treats a missing value as "local build".
ARG COMMIT_SHA=
ARG BUILD_TIMESTAMP=
ENV COMMIT_SHA=$COMMIT_SHA
ENV BUILD_TIMESTAMP=$BUILD_TIMESTAMP

# The platform version this image reports (ADR-0001, #798). ci.yml passes `<next>-main.<n>` for
# builds of `main` (tools/ci/compute-main-version.mjs); the script writes it into the root
# package.json, which `apVersionUtil.getCurrentRelease()` reads in both the API and the worker. It
# refuses anything but a `-main` prerelease above the tree's last release, so a build argument can
# never make an image claim a release. Empty — local builds and release.yml, whose tag
# version-tag-gate already pins to package.json — leaves the tree's version as it is. Last, like
# the two args above, so a new value per build invalidates only this layer.
ARG PLATFORM_VERSION=
COPY --from=build /usr/src/app/tools/scripts/stamp-platform-version.mjs /tmp/stamp-platform-version.mjs
RUN node /tmp/stamp-platform-version.mjs "$PLATFORM_VERSION" package.json \
    && rm /tmp/stamp-platform-version.mjs

LABEL service=qadam-flow

# PID 1 has to reap orphans, and Node does not reap processes it did not spawn.
# Measured in this image: with `exec node` as PID 1 an orphaned child is left as
# `Z  sh <defunct>` for the life of the container; under tini it is reaped.
# Signal handling is not the reason — both the API and the worker install their
# own SIGTERM handlers, and `docker stop` returns immediately either way.
ENTRYPOINT ["/usr/bin/tini", "--", "./docker-entrypoint.sh"]
EXPOSE 80
