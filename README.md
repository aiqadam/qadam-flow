<div align="center">

# Qadam Flow

**Workflow automation, built by the region, for the region.**

Localized · Self-hosted · No paid tiers · No enterprise gates · No vendor lock-in

[Roadmap](./ROADMAP.md) · [Governance](./GOVERNANCE.md) · [Contributing](./CONTRIBUTING.md) · [Code of Conduct](./CODE_OF_CONDUCT.md)

</div>

---

## What is Qadam Flow?

Qadam Flow is an open-source workflow automation platform — connect your apps and services with visual flows, no code required. It is built on the [Activepieces](https://github.com/activepieces/activepieces) MIT core, with all enterprise-licensed code removed, so every feature is free and open.

It is the first project of **AI Qadam Build** — open infrastructure that Central Asia's AI community owns and runs itself.

## Why it exists

The region runs its automation on foreign SaaS — billed in dollars, hosted abroad, in languages that aren't ours, with the features that matter (SSO, RBAC, audit logs) locked behind enterprise paywalls. Qadam Flow is the region's own: localized, self-hosted, data kept local, gates removed. The point isn't "a free Zapier" — it's **independence**.

## Status

Early, and honest about it. The Activepieces MIT core is forked and cleaned. Localization and regional integrations are the current focus; enterprise features (SSO / RBAC / audit) are built as real deployments need them, not on a fixed schedule — see the [Roadmap](./ROADMAP.md). Maintained by AI Qadam — founder-stewarded for now, community-owned by design (DCO, no copyright assignment).

## Quick start

Requires Docker. One line, no clone, no build:

```bash
curl -fsSL https://flow.aiqadam.org/run.sh | sh
```

This drops a fresh `./qadam-flow/` next to your shell, pulls
`ghcr.io/aiqadam/qadam-flow:latest`, generates random secrets in `.env`,
brings up postgres + redis + app + workers, and prints the URL when the
API is ready. Works on macOS (Docker Desktop), Linux (dockerd), and
Windows via WSL2.

Then open **http://localhost:8080/sign-up** — the first signup owns the
platform.

Env knobs (export before piping into `sh`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `QADAM_FLOW_DIR` | `./qadam-flow` | install directory |
| `QADAM_FLOW_PORT` | `8080` | host port for the app |
| `QADAM_FLOW_IMAGE` | `ghcr.io/aiqadam/qadam-flow:latest` | image / tag to run |
| `QADAM_FLOW_REF` | `main` | git ref for the compose file |

Prefer cloning? `git clone … && cd qadam-flow && docker compose up -d`
does the same thing — the public `docker-compose.yml` already points at
the registry image.

## Features

- Visual flow builder — no code required
- 238 qadams (27 core + 211 community) inherited from the Activepieces ecosystem
- Any qadam can be exposed as an MCP server — any MCP-compatible AI agent can call integrations as tools
- Self-hosted: your data stays on your infrastructure
- Free SSO / RBAC / audit logs — on the roadmap, never behind a paywall
- Multilingual: UI in Russian, Uzbek, Kazakh, English (in progress)

## How it's built

- **Agent-first** — much of the maintenance (piece scaffolding, localization, tests) is done with AI agents and reviewed by maintainers. Qadam Flow is also a living testbed for how agentic development maintains real software.
- **Dogfooded** — it runs in production, so it's shaped by real use, not a feature checklist.
- **Community-owned** — contributions are under the DCO (you keep your copyright) and recorded in the AI Qadam reputation graph. See [Governance](./GOVERNANCE.md).

## Contributing

You don't have to be an expert — you have to care. The easiest, highest-impact start:

- **Pieces** — build an integration the region needs (Payme, Click, Uzum, Kaspi, local APIs)
- **Localization** — translate the UI; no code required
- **Test & report** — run it, break it, file issues
- **Code** — pick a `good first issue`

Read [CONTRIBUTING](./CONTRIBUTING.md) and the [Code of Conduct](./CODE_OF_CONDUCT.md) first. Sign your commits with `-s` (DCO).

**Community:** AI Qadam Telegram / Discord · [aiqadam.org](https://aiqadam.org)

## Development

```bash
npm start    # setup dev environment + start all services
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full dev setup, and [CLAUDE.md](./CLAUDE.md) for architecture overview and coding conventions.

## License

[MIT](./LICENSE). Based on Activepieces (https://github.com/activepieces/activepieces), © 2020–2024 Activepieces Inc. Qadam Flow additions © 2026 The Qadam Flow Authors.

---

<div align="center">

*An AI Qadam Build project · #AIQadam*

</div>
