# Qadam Flow — Landing screenshots

9 production-stack screenshots captured 2026-06-19 from a local
`docker compose up` of `qadam-flow:latest` (port 8080). Every shot is
the production build with the demo platform owner `demo@aiqadam.org`
("Qadam Demo"). Resolution: 1280×640. Recapture at 1920×1080 if a
denser version is needed.

When moving into `flow.aiqadam.org/`, suggested mapping:
`./screenshots/` → `flow.aiqadam.org/assets/product/`.

---

## Story arc on the landing

1. **Hero** — `02-dashboard.png`
2. **Templates** — `03-template-detail.png`
3. **The product** — `04-flow-builder.png` (Ollama AI webhook, **largest**)
4. **Connects to your stack** — `05-qadams-search-stripe.png`
5. **AI is first-class** — `06-ai-providers.png` + `07-mcp-server.png`
6. **It actually runs** — `08-run-detail.png`
7. **Self-host & multi-tenant** — `09-platform-users.png`
8. **Closing CTA** — `01-signin.png`

---

## 01-signin.png — brand entry

- **Slot:** closing CTA on landing.
- **Alt:** "Qadam Flow sign-in: AI Qadam / FLOW lockup on the left, teal
  hero on the right with 'Automation that's yours.'"
- **Caption:** *Open-source AI workflows. No vendor lock-in, no
  phone-home.*
- **Why it matters:** the only frame that carries the full AI Qadam /
  FLOW lockup and the brand teal.

## 02-dashboard.png — hero

- **Slot:** above the fold.
- **Alt:** "Welcome dashboard with Build-a-Flow / Create-a-Table cards
  and a Templates carousel showing measured hour and dollar savings."
- **Caption:** *Start blank or grab a ready-made template — each ships
  with measured time and cost savings.*
- **Why it matters:** answers "what is this?" in one frame. The
  Templates strip carries concrete savings ($1,260–$6,012/year per
  flow) — credibility without claims.

## 03-template-detail.png — templates depth

- **Slot:** section #2.
- **Alt:** "Daily Schedule & Task Briefing template — saves $1,260/year
  and 46 hours, with a six-step flow preview on the right (Every Day
  → weather → calendar → tasks → AI summary)."
- **Caption:** *One of 60+ templates in the library, each shipping
  with the full step graph, setup guide, and savings math.*
- **Why it matters:** the live canvas preview on the right pane proves
  the visual builder is real. Covers breadth ("60+ templates") and
  depth (per-template anatomy) in a single shot.

## 04-flow-builder.png — product hero ⭐

- **Slot:** section #3 — the **largest image** on the page.
- **Alt:** "Flow builder showing 'Ollama AI Webhook' — Catch Webhook
  trigger → HTTP step 'Ask Ollama (qwen2.5)' → Return Response, with
  the trigger's Live URL panel open on the right (Synchronous Requests
  note visible)."
- **Caption:** *Drag, drop, run. Webhook in, local LLM out, structured
  JSON back — without ever calling a SaaS.*
- **Why it matters:** a **real, working flow** that runs end-to-end
  against a local Ollama (qwen2.5:7b). Demonstrates the open-source /
  self-hosted message in a single visual: no OAuth, no API key, no
  cloud LLM. Paired with `08-run-detail.png` it closes the loop.

## 05-qadams-search-stripe.png — real integrations

- **Slot:** section #4.
- **Alt:** "Steps picker search for 'stripe' returning the Stripe qadam
  with triggers Checkout Session Completed, New Payment, New Customer."
- **Caption:** *Real integrations. Real events. Real qadams — not
  generic HTTP placeholders.*
- **Why it matters:** picks a recognizable B2B brand (Stripe) and
  shows concrete trigger semantics. Also surfaces the "qadam"
  vocabulary in the search overlay.

## 06-ai-providers.png — AI is first-class

- **Slot:** section #5 — top.
- **Alt:** "AI Providers settings page — Anthropic, AWS Bedrock, Azure,
  Cloudflare AI Gateway, Google Gemini, Mistral AI — each with an
  Enable button."
- **Caption:** *Bring your own keys. Anthropic, Bedrock, Azure,
  Cloudflare, Gemini, Mistral, or anything OpenAI-compatible (Ollama,
  vLLM, LM Studio) — pick your engine per flow.*
- **Why it matters:** explicit list of providers makes the AI claim
  concrete and signals neutrality.

## 07-mcp-server.png — MCP

- **Slot:** section #5 row 2.
- **Alt:** "Platform MCP Server settings — Server URL
  'http://localhost:8080/mcp/platform', Connection / Tools tab
  switcher, JSON Configuration expandable section."
- **Caption:** *Every flow becomes an MCP tool. Plug Qadam Flow into
  Cursor, Windsurf, Claude Desktop — your automations show up natively.*
- **Why it matters:** MCP is the most modern positioning we have;
  differentiation against Zapier/Make in one frame.

## 08-run-detail.png — execution inspector ⭐

- **Slot:** section #6 — pairs with `04`.
- **Alt:** "Run detail for 'Ollama AI Webhook' — three steps all
  Succeeded (Catch Webhook 0 ms → Ask Ollama qwen2.5 13 s → Return
  Response), with the trigger output panel open showing POST method,
  headers, body (the prompt), and query params."
- **Caption:** *Every run lands in a queryable history — drill into
  any step to see what it received, returned, and how long it took.*
- **Why it matters:** **closes the loop** started by `04`. The viewer
  sees the flow built, then the flow running, then the per-step
  inspection. Strongest "real product" moment in the sequence.

## 09-platform-users.png — self-host

- **Slot:** section #7.
- **Alt:** "Platform Admin Users page listing demo@aiqadam.org as an
  Admin, with columns Identity / Name / Role / Created / Last Active /
  Status."
- **Caption:** *Multi-tenant from day one. Users, roles, projects —
  the platform model is yours to shape.*
- **Why it matters:** counters the "OSS is a single-user toy"
  assumption.

---

## What's missing / could strengthen the page later

- **Tables.** The route `/projects/<id>/tables` redirects to
  `/automations` in this build — feature scaffolded but not wired up
  yet. If Tables ships before launch, capture it; otherwise drop the
  "Create a Table" copy from `02-dashboard`.
- **A second flow** (e.g. Schedule → AI → Slack) to show variety
  alongside the webhook one. Optional.
- **Mobile.** All shots are desktop viewport. If the landing has a
  mobile-first section, capture at 390×844.
- **Retina.** Default viewport was 1280×640. For 2× hero use,
  recapture at 1920×1080.

---

## Reproduction notes

```bash
# Production stack:
docker compose up -d
# wait for http://localhost:8080/api/v1/flags to return 200
# sign up at /sign-up — first user owns the platform
# name the platform when prompted

# For the Ollama webhook hero (04 + 08) — with Ollama running on the
# host as OLLAMA_HOST=0.0.0.0:11434 ollama serve (so the docker
# container can reach it via host.docker.internal):
# 1. Create an empty flow via the UI ("Start from scratch")
# 2. POST /api/v1/flows/<id> with FlowOperationType=IMPORT_FLOW and a
#    trigger graph: Webhook (catch_webhook) → HTTP (send_request to
#    host.docker.internal:11434/api/generate, qwen2.5:7b) → Webhook
#    (return_response). Settings keys use the rebranded names:
#    qadamName / qadamVersion (NOT pieceName/pieceVersion), and an
#    empty propertySettings: {} is required.
# 3. POST /api/v1/flows/<id> with type=LOCK_AND_PUBLISH.
# 4. curl -X POST http://localhost:8080/api/v1/webhooks/<id>/sync
#    -d '{"prompt":"..."}' to fire a run.
# 5. Screenshot the builder and the run detail page.
```

All screenshots taken via headless `agent-browser` (Playwright) over
`http://localhost:8080/...`.
