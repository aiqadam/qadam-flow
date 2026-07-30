# E2E Tests

Playwright-driven full-stack tests. This is the ONLY package that owns the E2E layer under the unit / integration / e2e / smoke taxonomy.

## Layout

```
packages/tests-e2e/
├── scenarios/{ce,ee}/**/*.spec.ts   # test specs
├── pages/                            # Page Object Models
├── fixtures/                         # Playwright fixtures (users, etc.)
├── global-setup.ts                   # once-before-all sign-in/sign-up
└── playwright.config.ts
```

## What belongs here — and what does NOT

**Belongs here (E2E):** tests that exercise the real UI. The `page` fixture drives the browser: clicks, form fills, tab switches, URL navigations. Assertions look at DOM state (`expect(locator).toBeVisible()`, URL patterns, visible text). Value = catching regressions across the front-end ↔ back-end contract that pure API tests can't see.

**Does NOT belong here (anti-pattern):** specs that read a token from `localStorage` after sign-in and then do everything through `request.post()` / `request.get()`. That's an **API integration test wearing a Playwright costume**. It pays the browser boot cost (~3s) for zero incremental coverage — the same assertions run in ~300ms as Vitest against a real Postgres in `packages/server/api/test/integration/`. It also breaks the trace viewer: there's no DOM to scrub through.

Rule of thumb: **if the test never calls a `page.*` method that mutates the DOM (click, fill, select, keyboard, drag), it does not belong in this package.** Move it to `packages/server/api/test/integration/ce/` (or `ee/`) where it will run in a fraction of the time.

Concrete example — `scenarios/ce/projects/team-collaboration.spec.ts` is a real UI walkthrough of the member-management golden path from the perspective it actually matters for: a **non-platform-admin**. A platform admin mints a MEMBER (bootstrap only), then that non-admin drives the rest — signs up, is redirected away from the admin-gated `/platform`, creates a team project (becoming its project ADMIN), opens the project's **Settings → Team** tab, invites a member, and after the invitee accepts + signs up, sees the accepted member listed with the per-member failure-alert toggle (#88). Project creation and the invitee's `accept` are done via API (setup plumbing); every *assertion* is browser-driven against the DOM. The API-level guarantees are covered separately by `packages/server/api/test/integration/ce/team-collaboration.test.ts` and `.../project-member/project-member.test.ts`.

Why non-admin specifically: the members UI (`ProjectMembersTab`) used to be reachable only from the platform-admin `/platform/projects` dialog, so a non-admin project ADMIN had no way to manage members despite backend support. Surfacing it in project settings (the **Team** tab) is what makes the golden path real — the spec guards that reachability.

Screenshots at key points are written to `screenshots/team-collaboration/` (git-ignored) — useful as visual proof when reviewing a PR.

## Selector conventions

- Prefer `getByRole` / `getByTestId` over CSS. `getByText` is fine for asserting content, less fine for clicking (matches too broadly).
- Filter noisy tables via URL query (`?displayName=…`) instead of walking pagination — the projects and users lists both accept `displayName` as a `useQuery` filter.
- Icon-only action buttons have no accessible name in this codebase. Reach them via the Lucide class: `row.locator('button:has(svg.lucide-pencil)')`.

## Running

Boot the dev stack first (see repo root `AGENTS.md`), then:

```bash
cd packages/tests-e2e
AP_FRONTEND_URL=http://localhost:4200 \
  E2E_EMAIL=dev@ap.com E2E_PASSWORD=12345678 \
  npx playwright test scenarios/ce/<spec>.spec.ts --reporter=list
```

`E2E_EMAIL` / `E2E_PASSWORD` let `global-setup.ts` sign in as the seeded dev user instead of running its default sign-up — which is blocked by `INVITATION_ONLY_SIGN_UP` once dev-seed has provisioned a platform. When they are unset, the specs fall back to `DEFAULT_EMAIL` / `DEFAULT_PASSWORD` from `global-setup.ts`, i.e. to whoever global-setup itself just signed up — never to a hardcoded pair of its own, which is how a fresh instance used to fail with a `page.waitForURL` timeout that looked like a UI regression.

`AP_API_URL` is the API origin the specs talk to directly (`request.newContext({ baseURL })`), separately from `AP_FRONTEND_URL`. It defaults to `http://localhost:3000`, the dev stack's backend port, so the command above needs no change; set it when the API is not there — `docker-compose.yml` serves the API on the frontend's own origin, so a compose stack wants `AP_API_URL=http://localhost:8080`.

## Running against a deployed instance in CI

The `E2E Suite (docker compose)` job in `.github/workflows/ci.yml` runs this suite on every push to `main`, against the image that push just built, booted with the bundled `docker-compose.yml`. It also runs on a pull request that touches `packages/tests-e2e/**` or `ci.yml` — but on a PR the image is not published, so it tests the last published `:main`: green there means the job works, not that the PR passes e2e. It uploads `screenshots/**` on every run and `test-results/**` on failure. It pins `--workers=1`: eight parallel browsers against one instance made the app stop answering with `ERR_CONNECTION_RESET`, and serially the whole suite is ~2 min.

**SMTP forces it into two phases, and this is the trap to know about.** Setting `AP_SMTP_*` from the start makes the *first* sign-up on a fresh instance fail: `authentication.service.ts` auto-verifies a new identity only when SMTP is **not** configured, and otherwise emails a verification OTP synchronously, so a dummy SMTP host returns `500 ESOCKET connect ECONNREFUSED` and `global-setup.ts` dies before a single test runs. A *reachable* dummy is no better — the identity is then created unverified and never reaches `/automations` (and `initSmtpClient` sets `requireTLS`, so a plain local sink fails the STARTTLS upgrade anyway).

So the job boots with no SMTP, runs everything not tagged `@smtp` (global-setup signs up and creates the platform), then sets `AP_SMTP_*`, recreates `app`, and runs the `@smtp` specs with `E2E_EMAIL` / `E2E_PASSWORD` so global-setup signs in as the user phase 1 created. Everything after that first sign-up is invitation-based, and invited identities are created verified — no OTP — while the invitation email goes through a `tryCatch` that logs and swallows. No mail is ever sent.

Tag any new SMTP-dependent spec `@smtp` (`test.describe('…', { tag: '@smtp' }, …)`) rather than naming files in the workflow. Forgetting the tag puts the spec in phase 1, where the disabled toggle fails it loudly.

For visible debugging: add `--headed` (opens Chromium) or `--trace on` (records DOM snapshots + network per step; view with `npx playwright show-trace --host 127.0.0.1 --port 9323 test-results/**/trace.zip`).

## SMTP-dependent specs

`scenarios/ce/projects/failure-alerts-toggle.spec.ts` (#88) drives the per-member
failure-alert toggle, which the UI disables unless the backend reports
`SMTP_CONFIGURED = true` (all of `AP_SMTP_HOST` / `AP_SMTP_PORT` / `AP_SMTP_USERNAME` /
`AP_SMTP_PASSWORD` set). Toggling only writes an alert row — no mail is sent — so dummy
values are fine. Boot the dev stack with them set (they reach the dev process because
`turbo.json` passes `AP_*` through; without that, turbo's strict env-mode filters them):

```bash
AP_SMTP_HOST=127.0.0.1 AP_SMTP_PORT=2525 AP_SMTP_USERNAME=dev AP_SMTP_PASSWORD=dev \
AP_SMTP_SENDER_EMAIL=no-reply@qadam.test AP_SMTP_SENDER_NAME='Qadam Flow' npm run dev
```

## Environment limitations

- **Single platform on localhost.** `platformUtils.getPlatformIdForRequest` routes anonymous requests to `getOldestPlatform()`, so once dev-seed has created a platform, every anonymous sign-up joins it (invitation-only). Multi-platform tests need SaaS host routing (`legacy_custom_domain`), not present locally. Prefer same-platform isolation scenarios over cross-platform ones — the former exercises `applyProjectsAccessFilters` directly, which is what user-facing isolation actually relies on.
- **`project_role` is not seeded in dev DB.** `dev-seeds.ts` creates the platform + dev user but no default project roles, so invitation-with-role calls return 500 until a role exists. Insert one manually:
  ```sql
  INSERT INTO project_role (id, name, permissions, "platformId", type)
  VALUES ('editor_dev', 'Editor', ARRAY['READ_FLOW','WRITE_FLOW'],
          (SELECT id FROM platform LIMIT 1), 'DEFAULT');
  ```
  Long-term fix: extend `dev-seeds.ts` to seed the default role set.
