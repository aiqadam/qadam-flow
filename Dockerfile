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

# Image flavour (ADR-0003, #807): `fat` seeds the store with every official qadam; `slim` seeds the
# 27 core qadams and drops the community build from the runtime tree (except four qadams the server
# itself depends on — see the slim-prune step below). Both still build every qadam, because the
# build-qadam-artifacts.mjs archive each flavour's store seed is selected from needs every official
# qadam's tarball available, regardless of which ones a given flavour keeps.
ARG QADAM_FLAVOUR=fat

# The commit the artifacts are stamped with, for archive-index.json's own provenance record. CI
# passes it because `.git` is excluded from the build context; a local build with no build-arg
# leaves this empty, so build-qadam-artifacts.mjs below falls back to the well-known all-zero
# placeholder and records it as a dirty commit rather than crediting a fake one as clean.
ARG COMMIT_SHA=

# Build frontend, engine, server API, worker, and all bundled qadams.
# Qadams must be pre-compiled because the runtime loader scans `<qadam>/dist/`
# in standalone mode (no cloud registry).
RUN --network=host npx turbo run build --filter=web --filter=@aiqadam/engine --filter=api --filter=worker --filter='@aiqadam/qadam-*'

# ADR-0003's artifacts (#804): one npm tarball per official qadam at the version this tree holds.
# This is the image's store seed. `--out` must be outside the repository, so it goes in /tmp and
# only the parts each flavour needs are copied back below.
#
# NOT wired up here (deliberately, #807): #778's catalogue snapshot. Baking one into the image
# from this archive alone — the only way available in this Dockerfile, with no step anywhere in
# ci.yml/release.yml that checks out the already-published catalogue first — can only ever hold
# this tree's own current version of each qadam, never "every released version" the catalogue
# format promises (code-quality review, #807). `qadamPinFallbackSeams`'s `readPinMetadata` treats
# an older pinned version that is simply absent from a catalogue with zero skipped (unparseable)
# entries as proof the version was "never published", not merely unlisted — exactly the wrong call
# against a necessarily-partial, from-scratch snapshot, for every qadam that has more than one
# released version. #807's own issue thread flagged this directly: "Seed only after #851 lands (or
# ships in the same change)" — #851's snapshot-plan computation exists but, per
# .agents/rules/versioning.md, "the image does not apply it yet", so that gate is not met by this
# branch either. Deferred to whichever change wires a real checkout-then-append release step; see
# .agents/features/qadam-version-catalogue.md.
RUN node tools/scripts/qadams/bundle/build-qadam-artifacts.mjs \
        --out /tmp/qadam-artifacts \
        --all \
        --pack \
        --concurrency 4 \
        --commit "${COMMIT_SHA:-0000000000000000000000000000000000000000}"

# What the app seeds the version store with at start-up. Each flavour includes only the tarballs
# its store should hold.
RUN node tools/scripts/qadams/bundle/build-image-seed.mjs \
        --archive /tmp/qadam-artifacts/archive \
        --out packages/qadams/version-store-seed \
        --flavour "$QADAM_FLAVOUR" \
        --repo .

# `:slim` does not ship most community code, but four community qadams are the server's own direct
# dependencies, not something a flow merely happens to use: `app-event-routing.module.ts` statically
# imports slack / facebook-leads / intercom to parse their app-webhook payloads in-process, and
# `event-puller-registry.ts` lazily imports telegram-bot for its long-polling trigger — both run
# inside the server itself, never through the qadam version store a flow step's qadam is fetched
# from (code-quality review, #807: deleting them unconditionally broke every slim boot with
# `Cannot find module '@aiqadam/qadam-facebook-leads'`, since `app.ts` registers that module
# unconditionally). Keeping these four here does not add them to the 27 "core" qadams
# build-image-seed.mjs seeds the version store with below — that count, and whether a flow using
# one of them as an action still has to fetch it, are unaffected; this is a separate, smaller list
# of what the server process itself can't start without.
#
# Done before the dist index and the bundled metadata manifest are written, so both describe exactly
# what the runtime can load. `rm -rf` does not fail on a missing/mismatched path, so a slim image
# whose removal silently no-op'd would otherwise ship the full community tree under a
# `org.aiqadam.qadam-flavour=slim` label with nothing in the build log to say so — check each kept
# directory survived and nothing unexpected did.
RUN if [ "$QADAM_FLAVOUR" = slim ]; then \
      find packages/qadams/community -mindepth 1 -maxdepth 1 -type d \
        ! -name facebook-leads ! -name intercom ! -name slack ! -name telegram-bot \
        -exec rm -rf {} + \
      && for kept in facebook-leads intercom slack telegram-bot; do \
        test -d "packages/qadams/community/$kept" || { echo "slim pruning lost packages/qadams/community/$kept, which the server itself depends on" >&2; exit 1; }; \
      done \
      && [ "$(find packages/qadams/community -mindepth 1 -maxdepth 1 -type d | wc -l)" = 4 ]; \
    fi

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

ARG QADAM_FLAVOUR=fat

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

# Same defense-in-depth as the dist-index check above, for the flavour's version-store seed #807
# adds. The writer already fails the build on a real problem, but a build that crashed between
# opening the file and writing to it, or a copy that silently dropped it, would otherwise surface
# only as an empty version store at runtime — a confusing failure far from its cause instead of a
# build failure at it.
RUN test -s packages/qadams/version-store-seed/archive-index.json

# Copy built engine
COPY --from=build /usr/src/app/dist/packages/engine/ ./dist/packages/engine/

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --production

# Reset TLS check for runtime — SSL skip was build-time only
ENV NODE_TLS_REJECT_UNAUTHORIZED=

# Serialized metadata of every bundled qadam (packages/qadams/bundled-qadams-metadata.json). Without
# it the app's first catalogue read require()s every bundled qadam on its event loop, which blocked
# every request for 30–63 s on QA after each start (#598). Written here, after the production install and
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
LABEL org.aiqadam.qadam-flavour=$QADAM_FLAVOUR

# PID 1 has to reap orphans, and Node does not reap processes it did not spawn.
# Measured in this image: with `exec node` as PID 1 an orphaned child is left as
# `Z  sh <defunct>` for the life of the container; under tini it is reaped.
# Signal handling is not the reason — both the API and the worker install their
# own SIGTERM handlers, and `docker stop` returns immediately either way.
ENTRYPOINT ["/usr/bin/tini", "--", "./docker-entrypoint.sh"]
EXPOSE 80
