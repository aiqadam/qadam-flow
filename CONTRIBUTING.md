# Contributing to Qadam Flow

Thanks for helping build community-owned automation for the region. Qadam Flow is the first project of **AI Qadam Build** — open infrastructure that the streams own and run themselves. Before contributing, skim the [Governance](./GOVERNANCE.md) and the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Ways to contribute
You don't have to write core code to matter here:
- **Pieces & connectors** — integrations with regional services (banks, telecom, government, local SaaS). This is the highest-leverage contribution: the piece framework is modular, so a connector ships without touching the core.
- **Localization** — UI and docs in the region's languages (Uzbek, Kazakh, Russian, English, and more). Central to the mission: *localized and independent*.
- **Code** — features, bug fixes, performance, the free SSO / RBAC / audit layer.
- **Docs** — guides, examples, translations.
- **Triage & review** — reproducing bugs, reviewing PRs, helping newcomers.

## Ground rules
- Be kind and constructive — see the [Code of Conduct](./CODE_OF_CONDUCT.md).
- Open an issue and discuss anything non-trivial **before** writing a large PR, so effort isn't wasted.
- Keep pull requests small and focused: one logical change per PR.
- Practice over theory — a working example or test beats a long description.

## Architecture overview

Qadam Flow is a TypeScript monorepo built on the Activepieces engine. For a full architecture reference — module boundaries, coding conventions, entity registration rules, and key utilities — see [`AGENTS.md`](./AGENTS.md).

## Development setup
Prerequisites: Node.js (LTS), pnpm, PostgreSQL, Redis.

```bash
git clone https://github.com/aiqadam/qadam-flow.git
cd qadam-flow
pnpm install
pnpm build
```

Exact run/dev commands and environment variables live in the repo `README`. Qadam Flow is built on the Activepieces MIT core, so much of the upstream developer documentation applies.

## Commits and the DCO
Contributions are accepted under the **Developer Certificate of Origin (DCO)** — by signing off, you certify you have the right to submit the code under the project's MIT license. Sign off every commit:

```bash
git commit -s -m "Add piece for <service>"
```

This adds a `Signed-off-by: Your Name <email>` line. PRs with unsigned commits can't be merged.

## Pull request checklist
- [ ] Linked to an issue (for non-trivial changes)
- [ ] Commits signed off (`-s`)
- [ ] Tests added or updated where it makes sense
- [ ] Lint and build pass locally
- [ ] Docs / translations updated if behavior changed

## Optional: review before you push

`npm run review` runs an **advisory** AI review of your changes against this
repo's own conventions, which live in [`.opencodereview/rule.json`](./.opencodereview/rule.json)
(tenant isolation, entity registration, safe HTTP, i18n keys, migration safety,
and so on). It is a complement to — never a replacement for — CI and the review
agents. It cannot fail your build.

```bash
npm run review                    # staged + unstaged + untracked changes
npm run review -- --from main     # everything on this branch since main
npm run review -- --commit <sha>  # one commit
npm run review -- --preview       # what would be reviewed; no LLM call
npm run review -- -b "context"    # extra context, e.g. the ticket summary
```

The backend is detected at runtime, in this order:

1. **OCR-managed** — the [`ocr` CLI](https://github.com/alibaba/open-code-review)
   is installed and has an LLM endpoint configured (`ocr config provider`, or
   the `OCR_LLM_*` / `ANTHROPIC_*` environment variables). Most deterministic
   and the cheapest per review: `npm i -g @alibaba-group/open-code-review`.
2. **Delegation** — `ocr` is installed but has no endpoint: the script gathers
   the file list, rules and diffs itself and hands them to a headless agent CLI
   already on your machine (`opencode`, `claude`, `codex` or `cursor-agent`).
   The agent needs no tools or permissions — it reviews the prompt it is given
   and returns findings as JSON.
3. **Skip** — neither is available: you get a one-line hint and nothing else
   happens.

The pre-push hook offers the same as an `[r]eview` answer alongside
`[Y]es` / `[n]o` / `[l]int`. A push is stopped only when a `critical` finding is
reported, and even then you can confirm and push anyway — except when there is
no terminal to ask on (a piped or IDE-run git push), where the push is aborted
instead of hanging. The review never runs as part of the `[Y]es` gate.

Each run writes its findings to `.git/qadam-review/last.json` in the current
worktree (never committed), so you can inspect or diff the artifact later. When review
agents are used, the orchestrating agent runs this pass before spawning them and hands
the artifact to each reviewer alongside its charter.

## Issue & PR labels

We keep a small, consistent label taxonomy so the backlog stays readable. When you open an issue through a template, the **type** label is applied automatically; a maintainer sets the priority and track during triage — you don't have to.

Every issue carries:

- **One type** — `bug`, `enhancement`, `documentation`, `chore`, or `tech-debt`.
- **One priority** — `P0` (blocker: outage / data loss / exploited security), `P1` (high: near-term bug, security fix, or release blocker), `P2` (medium: should do, not urgent), `P3` (low: nice to have).
- **One `track/*`** — the roadmap lane it belongs to: `track/product-core`, `track/product-qadams`, `track/product-formulas`, `track/dev-infra`, `track/security`, `track/i18n-brand`, `track/docs-site`, `track/rebrand-cleanup`, `track/enterprise`.

Cross-cutting labels are added on top as needed:

- **`security`** — anything security-relevant (usually paired with `track/security`).
- **`area/core-qadams` / `area/third-party-qadams`** — for issues/PRs touching `packages/qadams`.
- **`help wanted`**, **`good first issue`** — to invite contributors.

**Pull requests** take exactly one primary label — `feature`, `bug`, or `skip-changelog` (docs, CI, internal refactors) — plus an `area/*-qadams` label when they touch `packages/qadams`.

## How contribution turns into standing
AI Qadam runs on a reputation graph, not on titles. Your merged contributions, reviews, and maintainership are recorded as verified reputation — earned by activity, never self-claimed. Sustained, quality contribution is how a contributor becomes a **committer**, and then a **maintainer**. See [Governance §7–8](./GOVERNANCE.md).

## License
By contributing, you agree your contributions are licensed under the project's **MIT license**. Qadam Flow is based on Activepieces (https://github.com/activepieces/activepieces), © Activepieces Inc., MIT License.
