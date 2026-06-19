# Qadam Flow — Roadmap

> Workflow automation, built by the region, for the region.
> Localized. Self-hosted. No paid tiers, no enterprise gates, no vendor lock-in.
> Built on the Activepieces MIT core. An AI Qadam Build project.

---

## Why this exists

Central Asia runs its automation on foreign SaaS — billed in dollars, hosted abroad, in languages that aren't ours, with the features that actually matter (SSO, RBAC, audit logs) locked behind enterprise paywalls.

Qadam Flow is the region's own automation backbone: localized, self-hosted, with data that stays in the region — built and maintained in the open. The enterprise gates come down, permanently. But the point isn't "a free Zapier" — it's **independence**: infrastructure the community owns and runs itself.

## How this is built

Honest about the model, because that's the whole brand:

- Qadam Flow is maintained by AI Qadam and runs in **production** — so it's shaped by real use, not a feature checklist.
- Development is **agent-first**: much of the work — piece scaffolding, localization, and test maintenance — is done with AI agents and reviewed by maintainers. Qadam Flow is also a living testbed for how agentic development maintains real software.
- Contributions are welcome and recorded in the AI Qadam reputation graph. There's no copyright assignment (DCO) — the code stays the community's. See [GOVERNANCE](./GOVERNANCE.md) and [CONTRIBUTING](./CONTRIBUTING.md).

**Timeframes below are targets, not promises.** We'd rather ship less and stay honest than miss dates and call it a roadmap.

---

## Now — Foundation (June 2026)

The base is in place.

- [x] Fork Activepieces v0.83.0 (MIT core)
- [x] Strip enterprise-licensed code (all features available to everyone, no paid tiers)
- [x] 238 qadams curated for the region (211 community + 27 core, down from 715 — kept what the region actually uses)
- [x] Domain rename: `Piece` → `Qadam` across code, DB, API, UI, docs
- [x] Docker Compose deploy (Postgres + Redis + app)
- [x] Repo governance: LICENSE (MIT), GOVERNANCE, CONTRIBUTING, CODE_OF_CONDUCT
- [x] Running in production (first real deployment)
- [x] Rebrand to Qadam Flow — code, UI, docs, API (Phase N: final UI cleanup, zero "Piece"/"Activepieces" in UI)
- [x] README with manifesto
- [ ] Brand assets (logo, favicon, OG) — designer track
- [ ] First `good first issue` set opened
- [ ] Announce at AI Qadam Meetup #2 (June 20, 2026)

---

## Next — Make it ours (next few months)

The focus that actually matters: localized, regional, genuinely usable. Most of this is accessible, parallel work — the best place for new contributors.

**Localization**
- [ ] UI in Russian, Uzbek, Kazakh (no code needed — translate strings)
- [ ] Locale-aware dates, numbers, formats

**Regional pieces** — the highest-leverage contribution: modular, no core changes
- [ ] Payments: Payme, Click, Uzum (UZ), Kaspi (KZ)
- [ ] Government / public API pieces (UZ/KZ) as they become available
- [ ] Local telecom and banking connectors the community asks for

**Make self-hosting painless**
- [ ] One-command install, sane defaults, data stays local
- [ ] Getting-started docs for our setup (what upstream docs don't cover)

> **Contributor ask:** if you know TypeScript, you can ship a regional piece in about a day — the framework is modular. Translators and testers needed too; no code required.

---

## Later — Enterprise features, demand-driven

The scaffolding exists (`auth/`, `rbac/`, `audit/`, `siem/`), but these get built **as production use requires them — starting with what production users actually needs — not on a fixed schedule.** They are large and security-critical, so they ship carefully and get audited before any security claim is made. We won't promise a bank a volunteer-built auth stack before it has earned that trust.

In likely order of real need:
- [ ] **SSO** — OIDC first (Google Workspace, Microsoft Entra); SAML later. A real undertaking, not a sprint.
- [ ] **RBAC** — roles and per-flow permissions a non-technical lead can manage.
- [ ] **Audit logs** — who did what, when; filterable and exportable.
- [ ] **SIEM output** — stream to Elastic/OpenSearch/Splunk/syslog, once audit is solid.

All free, all in the open — when they're ready, not when a calendar says so.

> **Contributor ask:** experienced backend and security contributors especially welcome here — this is where careful review matters most.

---

## Vision — directions, not commitments

Where the community could take this:

**Agent-native flows** — first-class MCP support (the core already ships ~400 MCP servers), LLM steps, agent orchestration as pieces.

**Chapter infrastructure** — Qadam Flow as the automation backbone for AI Qadam chapters: event registration, speaker pipelines, community notifications. (Build serving the other streams — the whole point of Build.)

**Qadam Flow Cloud** — a hosted option for teams that don't want to self-host, *only if* there is a sustainable way to fund the hosting (e.g. backed by AI Qadam infrastructure partners). Not promised. If it happens: never a paywall on features.

**Beyond UZ** — KZ, KG, TJ regional pieces and locales as chapters come online.

---

## Contribute

Every line above is an open invitation. You don't have to be an expert — you have to care.

- **Pieces** — build an integration the region needs (start here: easiest, highest impact)
- **Localization** — translate the UI into RU / UZ / KZ
- **Test** — run it, break it, file what you find
- **Docs** — write for our setup, in any of our languages
- **Code** — pick a `good first issue` or `help wanted`

Read [CONTRIBUTING](./CONTRIBUTING.md) and the [CODE_OF_CONDUCT](./CODE_OF_CONDUCT.md) first. Contributions are signed off under the DCO and recorded as reputation — earned by activity, never self-claimed.

**Where:** GitHub `github.com/aiqadam/qadam-flow` · AI Qadam Telegram / Discord · AI Qadam Meetups (Tashkent, Almaty, and beyond)

---

> "Qadam" means a step forward.
> Every workflow automated, every piece contributed, every translation — a step.
> Built by the region, for the region.

---

*Qadam Flow is an AI Qadam Build project.*
*Based on Activepieces (MIT). Copyright (c) 2020–2024 Activepieces Inc.*
*Qadam Flow additions: Copyright (c) 2026 The Qadam Flow Authors — MIT licensed.*
