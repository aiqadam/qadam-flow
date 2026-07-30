---
name: design
description: Design system for Qadam Flow, the AI-first workflow automation platform built by AI Qadam. Use whenever designing, mocking, or building UI for Qadam Flow — the web app (flow builder, runs, connections, dashboard), docs, or brand surfaces. The authority for any design question is the AI Qadam brand at https://brand.aiqadam.org; this skill records what it specifies, what Qadam Flow currently ships instead, and which of the two to follow.
---

# Qadam Flow Design System

**AI Qadam** is the organisation. **Qadam Flow** is the product — an AI-first workflow
automation platform where users assemble triggers + actions from 238 *qadams* into flows,
each of which doubles as an MCP server. Never call it Activepieces, and never describe it
as a "replacement for Zapier" — that is upstream's positioning, not ours.

## The authority

**<https://brand.aiqadam.org> is the single source of truth for every design question.** Two
pillars: `brand.html` (identity, logo, colour, type, voice, photography, icons) and `system.html`
(tokens, components, spacing, radius — digital UI only). Tokens there are normative; when this
file and the site disagree, **the site wins** — read it and fix this file. `README.md` in this
folder holds the depth: brand-vs-shipping deltas, token table, and what is genuinely unspecified.

## Brand teal is the brand. Purple is what still ships.

This is the one thing you must not get wrong:

| | Value | Where |
|---|---|---|
| **Brand primary** | `oklch(0.58 0.10 192)` ≈ `#008d89` light, `oklch(0.70 0.105 192)` ≈ `#39b3af` dark | brand.aiqadam.org |
| **Shipped mark** | `#3CA29E` ≈ `oklch(0.653 0.093 191.5)` — the logo/banner/badge teal, **between** the two tokens above, not equal to either | `packages/web/public/logo.svg`, `.github/assets/*`, README badges |
| **Shipping primary** | `#3CA29E`, matching the mark | default in `packages/server/api/src/app/flags/theme.ts:67`; `packages/web/src/styles.css` still declares the old purple for the pre-hydration paint only |

The logo already migrated — `packages/web/public/logo.svg` and `logo-full.svg` are the teal
footprint mark. The CSS and the platform-branding default did not.

- **New brand surface, mockup, deck, greenfield page** → brand teal.
- **Existing product UI** → use the token (`bg-primary`, `hsl(var(--primary))`), never a literal.
  It resolves to purple today and to teal after the recolour, so token-based code needs no rework.
- **Never** hardcode either hex in product code, and **never** recolour the product on your own
  initiative — the switch is a visible brand change and Binali's call. Ask.

## Hard rules

1. **Sentence case** everywhere — headings, buttons, menu items. Proper nouns only for feature
   names (Flows, Runs, Qadams, MCP, Agents, Connections).
2. **Lucide icons only**, 2px stroke, 24×24 viewBox, `currentColor`. Default render size 16px.
   No emoji, no Unicode glyphs (✓ × ←) in product UI. Never mix icon families.
3. **Brand assets are immutable.** Don't recolour, redraw, stretch, rotate, shadow, or crop the
   footprint mark, the wordmark, or the four-dot motif; don't reuse the four dots in other
   icons; don't set the wordmark in a typeface — it is an SVG. Don't use the brand teal as a
   generic accent: it is the brand colour.
4. **Radius**: `sm 6` / **default 8** / `md 10` / `lg 12` / `xl 16`. Inputs & buttons 8, cards 12,
   modals 16. Matches the repo's `--radius: 0.5rem`.
5. **Spacing base 4px**; scale 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 80 · 96. Card padding 24.
   **No negative margins** (banned in `packages/web/CLAUDE.md`).
6. **Borders 1px**, `var(--border)`. Never thicker.
7. **Type**: Geist display, Inter body, JetBrains Mono for technical detail (times, IDs, tags).
   Latin *and* Cyrillic must read equally well. The repo ships Inter latin-only and no Geist —
   see README for that gap.
8. **`cn()` from `@/lib/utils`** for className composition, and design-token classes
   (`bg-primary`, `text-muted-foreground`, `border-border`, `rounded-md`) — never raw hex.

## Voice

Honest, practical, second-person, verb-first. No hype, no "Click here", no "Please", no emoji.
Buttons: "New flow", "Publish", "Connect", "Test step". Empty states state the fact, then the
action — *"No flows yet. Create your first flow to start automating."* The tone answers to the
seven AI Qadam principles at <https://brand.aiqadam.org/brand.html#voice> — read them there
rather than paraphrasing from memory.

## Licensing (before copying anything)

Three licenses in the brand repo: code (CSS/HTML/scripts) **MIT**; editorial prose **CC BY 4.0**;
brand assets — name, marks, wordmark, four-dot motif, brand teal as a brand colour — **© AI Qadam
Community** under <https://brand.aiqadam.org/brand-use.html>. Qadam Flow is MIT-only, so token
*values* may be reproduced (MIT) while logo SVGs, merch photos, and guideline prose are **linked,
not copied**. When unsure, link.

## Starting a design

1. Open <https://brand.aiqadam.org> — brand pillar for colour/type/logo/voice, system pillar for
   tokens/components/spacing. Then this folder's `README.md`.
2. Product screens: reuse `packages/web/src/components/ui/` (Shadcn/Radix) before inventing
   anything; follow `packages/web/CLAUDE.md`.
3. If the brand site doesn't answer your question, say it is unspecified and ask — don't invent a
   value and don't inherit the upstream one.
