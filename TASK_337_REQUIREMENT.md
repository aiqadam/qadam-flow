# Task #337: Enable Chat specs by allowing Docker gateway SSRF

## Requirement

Enable E2E Chat specification tests in CI by configuring AP_SSRF_ALLOW_LIST to permit connections to Docker's gateway IP range.

The Chat specs invoke an OpenAI-compatible API stub running on localhost within the container. Currently, the default safeHttp.fetch middleware blocks all localhost/private-range connections. Adding the Docker internal gateway range to the allow-list unblocks these specifications.

## What needs to change

In `.github/workflows/ci.yml`, in the E2E job's "Boot the stack from the bundled docker-compose.yml" step:

Before `docker compose up -d`, create a docker-compose override that sets:
- `services.app.extra_hosts`: allows host.docker.internal to resolve inside the container
- `services.app.environment`: adds `AP_SSRF_ALLOW_LIST=172.16.0.0/12,192.168.0.0/16,10.0.0.0/8` to permit Docker's internal ranges

## Acceptance criteria

- [ ] E2E job report shows 12 passed / 1 skipped (currently 8 / 5, Chat specs are skipped)
- [ ] Job includes a comment explaining why the docker-compose override exists and how it differs from the stock install
- [ ] Job has an assert that fails if the Chat spec count drops — prevents silent regression if specs are excluded again
- [ ] Stack under test no longer byte-identical to stock install is documented (job comment explains this)

## Source

GitHub issue #337 in milestone v2.0.0

## Not covered (intentional)

- Network-level SSRF validation — that's an integration test level concern
- SMTP setup changes — those are configured separately in phase 2 of the e2e job
- Changes to the stock docker-compose.yml in the repo root — this is a CI-only override
