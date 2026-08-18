# Release acceptance harness

What you need to run `scenarios/ce/acceptance/` against a **published image** rather than a dev
stack — used to sign off v2.0.0. Nothing here is part of a normal install or of CI.

Two things the bundled `docker-compose.yml` deliberately does not provide, and why each is needed:

- **A fake SMTP server with a UI.** CI points SMTP at a dead `127.0.0.1:2525` and asserts only that
  nothing crashes, so no email has ever been *looked at*. That is how a broken logo reached a
  release. Mailpit gives every message a web inbox at <http://localhost:8025>.
- **`AP_SSRF_ALLOW_LIST` plus `host.docker.internal`.** The Chat specs (`scenarios/ce/chat/`) point a
  CUSTOM AI provider at an OpenAI-compatible stub running inside the Playwright worker, and
  `safeHttp.fetch` rejects private and loopback addresses. Without this the specs skip — which is
  exactly what happens in CI today (#337).

## Why the certificate

`smtp-email-sender.ts#initSmtpClient` sets `requireTLS: !useSSL` and passes no `tls` options, so
nodemailer performs a mandatory STARTTLS upgrade **with certificate verification left on**. A stock
Mailpit serves a self-signed cert, which that connection rejects. Rather than weaken the sender for
testing, the compose override mounts a certificate issued for the name the app dials (`mailpit`) and
points `NODE_EXTRA_CA_CERTS` at it. The app's TLS behaviour is therefore identical to production.

The key is generated locally and **never committed**. The run below keeps it in a scratch directory
outside the repo; if you would rather work in-tree, `packages/tests-e2e/acceptance/certs/` is
git-ignored for exactly that.

## Running it

```bash
# 1. a working directory outside the repo, with the bundled compose file and this override
mkdir -p /tmp/rc && cd /tmp/rc
cp <repo>/docker-compose.yml <repo>/run.sh .
cp <repo>/packages/tests-e2e/acceptance/docker-compose.override.yml .

# 2. the certificate the app will trust
mkdir -p certs && openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout certs/mailpit.key -out certs/mailpit.crt \
  -subj "/CN=mailpit" -addext "subjectAltName=DNS:mailpit,DNS:localhost,IP:127.0.0.1"
chmod 644 certs/mailpit.key certs/mailpit.crt

# 3. the same .env generator every real install uses, then point it at the image under test.
#    NOTE: no AP_SMTP_* yet — see the first gotcha below. They go in after the first sign-up.
NO_COLOR=1 QADAM_FLOW_SOURCE_ONLY=1 bash -c '. ./run.sh && generate_env'
perl -pi -e 's|^QADAM_FLOW_IMAGE=.*|QADAM_FLOW_IMAGE=ghcr.io/aiqadam/qadam-flow:sha-<short-sha>|' .env
cat >> .env <<'ENV'
AP_SSRF_ALLOW_LIST=172.16.0.0/12,192.168.0.0/16,10.0.0.0/8
ENV

docker compose up -d
<repo>/tools/ci/wait-for-api.sh http://localhost:8080/api/v1/flags 300
```

Then, from `packages/tests-e2e`, **phase 1** — everything that needs no mail. This is also what
creates the platform: `global-setup.ts` signs up, and that sign-up is the one that must not hit SMTP.

```bash
AP_FRONTEND_URL=http://localhost:8080 \
AP_API_URL=http://localhost:8080 \
E2E_CHAT_STUB_HOST=host.docker.internal \
  npx playwright test scenarios/ce --workers=1 --timeout=180000 --reporter=list \
  --grep-invert @smtp
```

**Phase 2** — turn SMTP on against Mailpit, recreate the sender processes, and run the suite again,
this time with a reachable inbox so the two mail cases stop skipping. It re-runs everything rather
than only the mail cases; at ~2 min for the rest of `scenarios/ce`, filtering is not worth the
bookkeeping. (The chat stub host is dropped here, so the chat specs skip on this pass — they already
ran in phase 1.) Sign-up
is invitation-only now that a platform exists, so global-setup must sign *in* as the user phase 1
created, which is why `E2E_EMAIL` / `E2E_PASSWORD` appear here and not above. Those are the
literals from `global-setup.ts` — phase 1 ran without them, so it signed up exactly that user.

```bash
cat >> .env <<'ENV'
AP_SMTP_HOST=mailpit
AP_SMTP_PORT=1025
AP_SMTP_USERNAME=qadam
AP_SMTP_PASSWORD=qadam
AP_SMTP_SENDER_EMAIL=no-reply@qadam.test
AP_SMTP_SENDER_NAME=Qadam Flow
ENV
docker compose up -d --force-recreate app worker
<repo>/tools/ci/wait-for-api.sh http://localhost:8080/api/v1/flags 300

AP_FRONTEND_URL=http://localhost:8080 \
AP_API_URL=http://localhost:8080 \
E2E_MAILPIT_URL=http://localhost:8025 \
E2E_EMAIL=test@aiqadam.org \
E2E_PASSWORD='TestPassword123!@#' \
  npx playwright test scenarios/ce --workers=1 --timeout=180000 --reporter=list
```

`--workers=1` is not optional: `enabledForChat` is a per-platform singleton, so two chat specs in
parallel flip the provider out from under each other. See `../CLAUDE.md`.

## Gotchas that cost time the first run

- **SMTP has to be off for the very first sign-up** — this is why the run above is split in two.
  `authentication.service.ts` auto-verifies a new identity only when SMTP is *not* configured; with
  it on, the first sign-up emails an OTP synchronously and `global-setup.ts` dies before any test
  runs. It is the same two-phase dance the CI job does, for the same reason. Putting `AP_SMTP_*` in
  `.env` before the first `docker compose up` is the single easiest way to lose an hour here.
- **The acceptance mail cases are gated on `E2E_MAILPIT_URL`, not on the `@smtp` tag.** They sit in a
  serial describe with the Viewer / locale / theme cases, which have no mail dependency and should
  not be held back to phase 2 — so the describe stays untagged and the two mail tests skip on their
  own when the variable is unset. Phase 1 above therefore runs them and they skip; phase 2 runs them
  for real.
- **The OTP throttle is not a bug.** A PENDING code younger than ten minutes suppresses a resend, so
  a second password-reset request within that window sends nothing. Confirm the first code before
  expecting a second mail.
