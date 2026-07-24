No Enterprise Edition code exists in this repo. Never reintroduce edition gating, paywalls, or EE-only services. All features are available to all users.

## Never copy upstream EE source (licensing)

Upstream Activepieces is dual-licensed: the core (outside `ee/`) is MIT, but `packages/ee/` and `packages/server/api/src/app/ee` are under the proprietary **Activepieces Enterprise License** (production use requires a paid subscription; copying, publishing, distributing, sublicensing, and relicensing are forbidden — copy/modify is allowed only for dev/testing). This repo is MIT-only; its `LICENSE` states the `packages/ee/` components were removed.

Therefore, when restoring or re-enabling a feature that lived under upstream `ee/` (e.g. API keys, SSO, RBAC, audit logs, git sync):

- **NEVER** copy the EE source verbatim — no `git show <upstream-sha>:packages/ee/...`, no pasting file bodies, comments, or one-to-one file structure from the EE tree. That would infringe the Activepieces Enterprise License and expose the project to a legitimate claim.
- **DO** clean-room reimplement it as CE code: work only from the *behavior* — HTTP contract/endpoints, DB schema as an idea, auth flow (e.g. `sk-` bearer → SERVICE principal). Copyright protects the specific expression (source), not the functionality, API surface, or schema idea.
- Code already in the MIT core is safe to use (e.g. `PrincipalType.SERVICE`, `authorize.ts`, existing SERVICE plumbing) — it was never EE.
- Place restored features outside any `ee/` directory (e.g. `app/api-keys/`), strip all edition/plan gating, and register entities per `entity-registration.md`.

When in doubt about whether a snippet came from EE-licensed source, treat it as EE and reimplement from the spec instead.
