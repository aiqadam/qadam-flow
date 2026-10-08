FROM node:24.21.0-bookworm-slim

ENV LANG=en_US.UTF-8 \
    LANGUAGE=en_US:en \
    LC_ALL=en_US.UTF-8 \
    CI=true

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        iptables \
        libcap2-bin \
        ca-certificates \
        curl \
        locales \
        unzip \
        procps \
        python3 \
        g++ \
        build-essential && \
    sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && \
    locale-gen en_US.UTF-8 && \
    rm -rf /var/lib/apt/lists/*

RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then \
      curl -fsSL https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64-baseline.zip -o /tmp/bun.zip \
        && echo "a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7  /tmp/bun.zip" | sha256sum -c -; \
    else \
      curl -fsSL https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-aarch64.zip -o /tmp/bun.zip \
        && echo "a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b  /tmp/bun.zip" | sha256sum -c -; \
    fi && \
    unzip -q /tmp/bun.zip -d /tmp/bun && \
    mv /tmp/bun/bun-*/bun /usr/local/bin/bun && \
    chmod +x /usr/local/bin/bun && \
    rm -rf /tmp/bun /tmp/bun.zip

RUN npm install -g --no-fund --no-audit node-gyp

WORKDIR /usr/src/app

COPY .npmrc package.json bun.lock bunfig.toml turbo.json ./
COPY packages/ ./packages/
COPY tools/ ./tools/
COPY tsconfig.base.json ./

# Skip native build scripts for the workspace install — these integration tests do not need
# better-sqlite3 and friends, and building them all costs minutes. isolated-vm is the exception:
# the per-mode suite runs a CODE step (#712) and the engine executes it through isolated-vm in
# the two V8 modes, so it is built explicitly right below.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts

# isolated-vm is a native addon, and the workspace install above already ships its prebuilt binary,
# so fork modes (cwd=/usr/src/app) resolve it without help. Isolate modes run with
# NODE_PATH=/usr/src/node_modules and resolve the copy mounted into the box, which nothing else in
# this image populates — install the same version there too (#712). Keep ISOLATED_VM_VERSION equal
# to the engine's pin (the main Dockerfile checks the two against each other).
ARG ISOLATED_VM_VERSION=7.0.1
RUN --mount=type=cache,target=/root/.bun/install/cache \
    cd /usr/src && bun install isolated-vm@${ISOLATED_VM_VERSION}

# Fail the build if ISOLATED_VM_VERSION drifted from the manifests, exactly as the main Dockerfile
# does (#641). Without this the e2e suite would keep exercising an old addon after a real bump.
RUN node -e 'const v=require("/usr/src/node_modules/isolated-vm/package.json").version;const r=require("./package.json").dependencies["isolated-vm"];const e=require("./packages/server/engine/package.json").dependencies["isolated-vm"];if(v!==r||v!==e){console.error("isolated-vm mismatch: sandbox="+v+" root="+r+" engine="+e);process.exit(1)}'

# Build the engine bundle and one bundled qadam (with its workspace deps): the per-execution-mode
# suite boots the real engine through createSandboxForJob, and sandbox-bundled-qadam.e2e.test.ts
# loads a real qadam through the mounts create-sandbox-for-job adds for isolate modes (#375).
RUN bun x turbo run build --filter=@aiqadam/engine --filter=@aiqadam/qadam-webhook...

# isolate binary + config (checked into the repo under assets/; repo ships x86_64 and arm variants)
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then \
      SRC=packages/server/api/src/assets/isolate; \
    else \
      SRC=packages/server/api/src/assets/isolate-arm; \
    fi && \
    install -m 0755 "$SRC" /usr/local/bin/isolate && \
    mkdir -p /usr/local/etc && \
    cp packages/server/api/src/assets/default.cf /usr/local/etc/isolate && \
    mkdir -p /var/local/lib/isolate && \
    mkdir -p /usr/src/node_modules

ENV E2E_LOG_LEVEL=warn

# cwd is the repo root — isolate.ts resolves its binary via `process.cwd() + packages/server/api/src/assets/…`.
WORKDIR /usr/src/app

CMD ["bun", "x", "vitest", "run", "--config", "packages/server/worker/test/e2e/vitest.config.ts"]
