# debian/

Real Debian packaging: three binary packages from one source package, the
knix-flare pattern. Nothing here is used by the Docker install or by
`npm run dev`; the live files on a host are `/etc/qadam-flow/*.conf` and
`/lib/systemd/system/qadam-flow*.service`.

| Binary package | Contents |
| --- | --- |
| `qadam-flow-common` | `/usr/lib/qadam-flow` (vendored node_modules + built packages/dist), `/usr/share/qadam-flow/web`, `/usr/local/etc/isolate`, and the symlinks below |
| `qadam-flow` (master) | `/usr/bin/qadam-flow-master`, `/etc/qadam-flow/master.conf`, `qadam-flow-master.service` |
| `qadam-flow-worker` | `/usr/bin/qadam-flow-worker`, `/etc/qadam-flow/worker.conf`, `qadam-flow-worker.service` |

| File | Installs to | Mode |
| --- | --- | --- |
| `master.conf` | `/etc/qadam-flow/master.conf` | 0600 root:root (conffile) |
| `worker.conf` | `/etc/qadam-flow/worker.conf` | 0600 root:root (conffile) |
| `qadam-flow-master` | `/usr/bin/qadam-flow-master` | 0755 |
| `debian/scripts/qadam-flow-worker` | `/usr/bin/qadam-flow-worker` | 0755 |
| `qadam-flow.qadam-flow-master.service` | `/lib/systemd/system/qadam-flow-master.service` | 0644 |
| `qadam-flow-worker.service` | `/lib/systemd/system/` | 0644 |

The master unit file lives at `debian/qadam-flow.qadam-flow-master.service`
(debhelper-canonical `<pkg>.<unit>` name — needed because the binary package
is `qadam-flow` but the unit is `qadam-flow-master`).

Both `/etc` confs become conffiles automatically (dh ≥ 13 turns anything
dh_install places under `/etc` into a conffile), so there is no separate
`conffiles` list. The vendored runtime payload is prebuilt by
`scripts/debian-prebuild.sh` inside `build/source` (copy-out — the repo
working tree is never written; see the next section) and staged under
`build/source/debian/prebuild/usr` (`rules` uses `--buildsystem=none` and
fails loudly when the stage is missing — npm/npx only, no bun). Runtime
dependencies: `nodejs (>= 24.21)`;
the master additionally needs `postgresql-18-pgvector | postgresql-17-pgvector`
and `redis-server | valkey`; the worker deliberately needs neither (it only
talks HTTP to the master), which is what makes it installable on a separate
host. Full user notes: `debian/README.Debian`; manpages for the two
launchers ship with them.

systemd reads the two conf files as root before dropping privileges, so the
`qadam` user never needs to read them. Keep them 0600: they hold
`AP_JWT_SECRET`, `AP_ENCRYPTION_KEY`, the database password and
`AP_WORKER_TOKEN`.

## Runtime layout

    /usr/lib/qadam-flow/                 program tree (root:root, 0755)
    /usr/share/qadam-flow/web/           frontend build
    /var/lib/qadam-flow/                 state (qadam:qadam, 0750)
    /var/cache/qadam-flow/               cache (qadam:qadam, 0750)
    /usr/share/doc/qadam-flow-common/    copyright, changelog, README.Debian

`StateDirectory=qadam-flow` and `CacheDirectory=qadam-flow` create the two
`/var` directories. The app creates `qadam-versions/` and its subdirectories
itself.

The service user is a system account with no login shell:

    adduser --system --group --home /var/lib/qadam-flow --no-create-home qadam

## Secrets: minted per key, never overwritten

`qadam-flow.postinst` and `qadam-flow-worker.postinst` handle first-install
secrets: `AP_ENCRYPTION_KEY` / `AP_JWT_SECRET` / `AP_POSTGRES_PASSWORD` in
master.conf, `AP_WORKER_TOKEN` in worker.conf are minted while their own
line still reads `CHANGE_ME` — an operator's own values are never clobbered
by an upgrade, and rewinding one key to `CHANGE_ME` re-mints only that key.
The master postinst also creates the `qadam_flow` PostgreSQL role,
database and pgvector extension (idempotent), and resyncs the role password
only when the database password itself was freshly minted. What remains
manual after every install:

- `AP_FRONTEND_URL` — the public HTTPS URL of the web app (postinst prints
  a reminder while it is still the example default).
- distributed worker installs with no co-hosted master: run
  `qadam-flow-mint-worker-token` on the MASTER host (prints the derived
  token, never the secret) and set the output as AP_WORKER_TOKEN in the
  worker's conf.

## Verify after install

    systemd-analyze verify /lib/systemd/system/qadam-flow-master.service
    systemctl show qadam-flow-master -p Environment
    systemctl show qadam-flow-worker -p Environment

Editing a conf needs `systemctl restart`; `daemon-reload` is only for unit
file changes.

## Three symlinks the package creates

The server resolves these paths against its working directory
(`process.cwd()`), so `qadam-flow-common.links` bridges them:

    /usr/lib/qadam-flow/cache               -> /var/cache/qadam-flow
    /usr/lib/qadam-flow/dist/packages/web   -> /usr/share/qadam-flow/web
    /usr/src/node_modules                   -> /usr/lib/qadam-flow/node_modules

Without the first, the worker cannot write its cache under
`ProtectSystem=strict`. Without the second, the API's `fastifyStatic`
registration in production fails at startup. The third feeds the isolate
sandbox, which hardcodes `/usr/src/node_modules/` as its vendoring bridge —
only used by `SANDBOX_PROCESS` mode, but created unconditionally.

## Security notes

- `UNSANDBOXED` runs Code steps with the worker's own privileges. Use
  `SANDBOX_CODE_ONLY` for untrusted users. `SANDBOX_PROCESS` additionally
  needs `CAP_SYS_ADMIN`; drop `NoNewPrivileges` and add
  `AmbientCapabilities=CAP_SYS_ADMIN` to the worker unit in that case.
- The worker health server binds every interface on `AP_PORT` (the code has
  no host parameter). Firewall 3000 and 3001 to localhost; only 80/443
  should be public.
- `LimitCORE=0` keeps core dumps, which can contain secrets, off disk.

## Build model: copy-out

`scripts/debian-prebuild.sh` runs the whole toolchain inside a disposable
copy of the repo — `build/source` — and never writes the working tree. The
copy is cache/artifact-free by construction (`.git`, `node_modules`, `dist`,
`.turbo`, `.env*` never cross it), so `npm ci` provisions node_modules from
a clean slate and a dev tree can never accidentally commit build-time
manifests. `build/package-lock.json` is the only thing that ever leaves
`build/` — and even that moves to the repo root by hand, not by script.
`build-deb.sh` at the repo root drives the whole local chain (prebuild →
optional changelog rewrite in the copy → dpkg-buildpackage → artifact
assembly → lintian):

    REFRESH_LOCK=1 bash build-deb.sh               # bootstrap
    cp build/package-lock.json package-lock.json   # + git add (yours)
    bash build-deb.sh                              # every later build

CLI: `bash build-deb.sh [--fresh|--resume] [DEB_VERSION]`. `--fresh` is the
deterministic clean-room path (what the buildbot effectively runs): `build/`
is wiped and every phase reruns. `--resume` is an iteration mode — each phase
stamps its input hashes under `build/.phase` and is skipped while unchanged:
`derive` hashes the tracked manifest-level inputs plus both derivation
scripts; `lock` hashes the copy's package-lock.json over the derive stamp
(`REFRESH_LOCK=1` forces it); `ci` rides the lock stamp plus `.npmrc` and the
running node version; `native` re-mounts only when the isolated-vm binding
fails a load test (the smoke check runs on every resume regardless). The tar
copy-out becomes an overlay in resume mode, so `npm ci`'s node_modules,
turbo's `.turbo` cache and `dist/` survive between runs and turbo reruns only
what changed. A source-only fix then relaunches the whole chain in minutes;
resume never writes the repo tree, and `4c`, manifest writes, staging,
dpkg and lintian stay unconditional because the payload must always be
current.

The committed `package-lock.json` is then the npm-path source of truth: the
prebuild uses it verbatim (no registry re-resolution) and re-resolving
requires a deliberate `REFRESH_LOCK=1` run plus a new commit. With no
committed lock and no `REFRESH_LOCK` the prebuild fails closed. One
`--package-lock-only` gotcha the prebuild handles for you: regen runs COLD —
npm seeds its ideal tree from an installed `node_modules` even when only
updating the lock (silently keeping OLD override-resolved versions), and a
stale `package-lock.json` fed through the same reconciliation path aborted
mid-placement with arborist's `Invalid Version: `. The prebuild therefore
removes both the copy's node_modules and its lock before regenerating; the
full `npm ci` follows as soon as the lock contents move. The regen output
then passes a repair gate (`scripts/debian-lock-repair.cjs`) before it is
stamped or installed: it drops npm's empty placeholder nodes (a later
`npm ci` aborts on their version-less shape) and re-resolves every declared
runtime dependency against the lock tree, grafting names nothing satisfies
at the tree root from the derivation's override pins — the vendored payload
must never be missing a module a built qadam requires at load time. Two
shape notes the lock encodes:

- the lock maps the DERIVED npm manifests (`overrides` mirrored from
  `resolutions`; the direct `rollup` entry dropped — npm's EOVERRIDE —
  since the `rollup -> npm:@rollup/wasm-node` alias overrides covers it),
  so a root-manifest change means a fresh `REFRESH_LOCK=1` bootstrap;
- the `.deb` payload ships the repo's own bun-canonical manifests
  (`workspace:*`): the npm `file:` rewrites live only inside
  `build/source`, and the original manifests are copied back over the
  derived ones just before staging (nothing parses dep specs outside
  installs).

## Vendored-binary packaging exceptions

Two debhelper behaviors fight the vendored node tree; both are settled in
`debian/rules` / `debian/qadam-flow-common.lintian-overrides` with their
reasons:

- **`override_dh_strip`** — dh_strip is not invoked at all: no strip, no
  automatic dbgsym. The payload ships ELF binaries that must stay
  byte-identical with the Docker image, and several of them live OUTSIDE
  node_modules (which a `-X` exclude would miss):
  `packages/server/api/src/assets/` holds the prebuilt isolate /
  isolate-arm sandbox binaries — foreign architecture, unreadable by the
  host binutils ("Unable to recognise the architecture" kills both objcopy
  and strip). The files were already load-verified against node 24, and
  the dbgsym pass for a multi-GB tree costs minutes and gigabytes.
- **`override_dh_usrlocal`** — `/usr/local/etc/isolate` is a plain FILE:
  the isolate binary reads it from a compiled-in config path and the
  Dockerfile `COPY`s default.cf to exactly that path (verified via
  `strings`). `dh_usrlocal` refuses any file under /usr/local, and
  `.install` destinations are always directories, so the copy's destination
  is the PARENT (`usr/local/etc/`) and lintian's `file-in-usr-local` tag is
  overridden.
- **dh's staging-dir name collision** — dh names each binary package's
  build directory `debian/<pkg>`. `debian/qadam-flow` (master) collides
  with nothing, but the worker package's staging dir is
  `debian/qadam-flow-worker`, which is also a tracked launcher script —
  dh_install dies with `mkdir: File exists`. The launcher therefore lives
  at `debian/scripts/qadam-flow-worker` and `qadam-flow-worker.install`
  sources it from there.
- **`.install` destinations are always DIRECTORIES** — for file payloads
  (`package.json`, `bun.lock`, `bunfig.toml`, `.npmrc`, `LICENSE`,
  `NOTICE`) the destination line must name the PARENT directory
  (`usr/lib/qadam-flow/`); naming the file itself makes dh_install create
  a directory named `package.json` and copy the file inside it.

The payload build script is `scripts/debian-prebuild.sh`, driven by the
one-shot `build-deb.sh` at the repo root; the buildbot builder is
`config/builds/qadam-flow/qadam_flow_deb.yaml` in the knixbbot repo.

- **`override_dh_shlibdeps`** — dpkg-shlibdeps resolves every ELF's NEEDED
  libraries against the host architecture, and the vendored tree ships
  prebuilds for many platforms/ABIs — foreign ones abort ("cannot find
  library libstdc++.so.6" for an arm64 prebuild on an x64 host incl.).
  The runtime contract is declared in control instead: `nodejs (>= 24.21)`
  pulls libc6/libstdc++6/libgcc-s1 transitively, so `${shlibs:Depends}`
  stays empty by design.

## Packaging file list

``control`, `rules` (`--buildsystem=none`), `changelog` (base version — the
buildbot rewrites it to `1.1.0~stable.b<N>` per build counter), `copyright`
(DEP-5, MIT), `source/format` (3.0 native), `source/options`
(`tar-ignore` prebuild/node_modules/.turbo/dist), per-package
`install`/`dirs`/`links`/`manpages`/`lintian-overrides`,
`postinst`/`prerm`/`postrm` for master and worker, `README.Debian`, one man
page per launcher, and a man page for `qadam-flow-mint-worker-token`.

`master` is our name for the process; the code calls it `APP`
(`AP_CONTAINER_TYPE=APP`). The value inside the conf is what matters.
