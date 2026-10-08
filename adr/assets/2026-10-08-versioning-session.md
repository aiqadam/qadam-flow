# Versioning storming session — 2026-10-08

Record of the answers given by the maintainer (@binalirustamov) in the 2026-10-08 session that
produced ADR-0001, ADR-0002 and ADR-0003. Each answer picked one of the options put to them; the
reasoning for each pick is in the ADRs' "Options considered" sections. Kept here so the ADRs can
cite something outside themselves.

## Deployment and scope

| Question | Answer |
| --- | --- |
| Where will instances run in the next year? | Our cloud and our own projects; customers' on-prem with internet or a corporate npm proxy (Nexus / Artifactory). Not: closed sites with no npm access at all. |
| Who upgrades on-prem, and how often? | It varies. |
| Will there be external qadam authors? | Yes. |

## Store model (ADR-0003)

| Question | Answer |
| --- | --- |
| What goes into the fat image? | Current versions only; older ones come from the persistent store or npm. |
| What goes into slim? | The platform and the 27 core qadams; community qadams on demand. |
| Is slim needed now? | Yes. |
| Where does the store live? | On a persistent volume; npm fetches write into it too. |
| Already published packages that pin `shared` / `framework` / `common`? | Override them with the platform's libraries now; move to peer dependencies over time. |
| When to fetch a missing version? | When a flow is published or imported — and also at start-up. |
| Pin unavailable and unfetchable? | Move it automatically when compatible, with an audit record; otherwise "update this step". |
| Pins older than the first npm publication (no metadata, so no compatibility check)? | Keep #424's caret fallback, adding a load check on the target and an audit record with revert (asked after the review of PR #790). |
| Catalogue host | GitHub Pages under `flow.aiqadam.org`. |
| Default registry | npmjs, with a configurable URL and token. |
| Signature check | Mandatory for `@aiqadam/*`; a platform setting for custom qadams. |
| GC | Never a pinned version; unreferenced after 10 days; never the current image's versions. |
| Custom qadams | Same store, per-platform namespace. |
| Artifact format | One bundle, the same file in images and on npm. |
| Libraries the platform provides | `@aiqadam/*` and `zod`. |
| Catalogue scope | Every version. |
| Image tags | `:fat` and `:slim`; `run.sh` installs slim; `:latest` stays fat. |
| Republishing the 238 published qadams | Only when each one next changes. |
| Registry at install time | Environment variables passed to `run.sh`, reachability checked, fat suggested on failure. |

## Framework support window (ADR-0002)

| Question | Answer |
| --- | --- |
| How many context versions does the engine support? | Use semver and support two framework majors. |
| Time floor? | Two majors, and at least 12 months — plus a deterministic CI check and a convention for agents and humans. |
| Census before an upgrade | Warn, do not block. |
| When is `qadams-framework@1.0.0` cut? | When the stable SDK is ready. |

## Semver for everything (ADR-0001)

| Question | Answer |
| --- | --- |
| Separate ADR or extend an existing one? | Separate. |
| What makes a qadam major? | Schema and observable behaviour. |
| Qadams `0.x` → `1.0` | Each at its next change. |
| Platform `package.json` | The last released version; prereleases for builds from `main`. |
| Who raises versions? | Changesets. |
| Gates | All required from the start, with a maintainer-only override label. |
| Conventions | One rule, one skill, docs. |
| `shared` | Private; bundled into `framework`. |
| Where do qadam-facing `shared` symbols go? | Into `qadams-framework`. |

## Process

| Question | Answer |
| --- | --- |
| ADR order | Number order is dependency order. |
| Merge while proposed? | Yes. |
