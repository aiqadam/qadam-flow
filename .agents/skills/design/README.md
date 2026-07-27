# Qadam Flow Design System

The design reference for **Qadam Flow** — the AI-first workflow automation platform built by
**AI Qadam**. Users assemble triggers + actions from 238 *qadams* (27 core + 211 community)
into automated flows; every qadam doubles as an MCP server for Claude, Cursor, Windsurf, etc.

- **AI Qadam** — the organisation (the AI community infrastructure for Central Asia).
- **Qadam Flow** — this product. Self-hosted by design, MIT, `flow.aiqadam.org`.

Do not call the product Activepieces, and do not describe it as an "open source replacement for
Zapier". Qadam Flow descends from the MIT core of Activepieces, but upstream's name and
positioning are not ours.

---

## The authority: brand.aiqadam.org

**Every design question is answered at <https://brand.aiqadam.org>.** It is the canonical brand
and design reference for the whole AI Qadam umbrella, and it is deliberately not duplicated
here — this file records only what a Qadam Flow agent needs in order to act, plus the places
where the shipping product diverges from it.

Two pillars, and which one you need:

| Pillar | Covers | Read it when |
| --- | --- | --- |
| [Brand](https://brand.aiqadam.org/brand.html) | identity, logo system, brand colour, colour tokens, type scale, voice & principles, photography, iconography, merch, decks | anything that travels off-screen, plus colour and type (they apply everywhere) |
| [Design system](https://brand.aiqadam.org/system.html) | spacing, radius, component primitives, domain patterns, mockups, navigation | digital product UI |

Useful deep links: [`#brand-color`](https://brand.aiqadam.org/brand.html#brand-color) ·
[`#colors`](https://brand.aiqadam.org/brand.html#colors) ·
[`#typography`](https://brand.aiqadam.org/brand.html#typography) ·
[`#logo`](https://brand.aiqadam.org/brand.html#logo) ·
[`#voice`](https://brand.aiqadam.org/brand.html#voice) ·
[`#iconography`](https://brand.aiqadam.org/brand.html#iconography) ·
[`#foundation`](https://brand.aiqadam.org/system.html#foundation) ·
[`#components`](https://brand.aiqadam.org/system.html#components).
Agent-oriented index: <https://brand.aiqadam.org/llms.txt>.

**Tokens there are normative.** If this file disagrees with the site, the site wins — go read it
and fix this file.

---

## Licensing — what may be reproduced here, and what may not

The brand repo carries three separate licenses covering non-overlapping material:

| Material | License | Consequence for this MIT repo |
| --- | --- | --- |
| Source code — `tokens.css`, `components.css`, HTML markup, scripts | MIT | May be reproduced. This is why the token *values* below are written out. |
| Brand assets — the name "AI Qadam", the footprint mark, the `AI QADAM` wordmark, the four-dot motif, the brand teal **used as a brand colour or logo background**, `#AIQadam` | © AI Qadam Community, [Brand Usage Policy](https://brand.aiqadam.org/brand-use.html) — **not** open source | Not relicensable. Qadam Flow's use of the mark and the teal rests on the policy's "open-source projects recognised as part of AI Qadam Build" clause (recognition granted by community leads), not on any license grant. Link the assets; don't vendor, redraw, or recolour them. |
| Editorial prose — guideline copy, examples, manifesto excerpts | CC BY 4.0 | Copyable with attribution, but CC BY prose inside an MIT repo means mixed licensing. So we link it instead. |

**What this skill therefore does and does not reproduce:**

- **Reproduced** — the OKLCH/hex token values, font families, radius and spacing scales, and
  component dimensions. All from MIT-licensed `tokens.css` / `components.css`, and all needed to
  implement the product. The brand teal's value is stated because it is already the colour of the
  mark this repo ships (`packages/web/public/logo.svg`) and you cannot build the product without
  it.
- **Not reproduced** — the logo SVGs (`logo-mark.svg`, `logo-full.svg`), the merch photography,
  the seven manifesto principles, and the guideline prose. Those are linked. The seven principles
  in particular are editorial CC BY content: read them at
  [`brand.html#voice`](https://brand.aiqadam.org/brand.html#voice), don't paste them here.
- **Ambiguity resolved toward less copying.** The policy permits brand-asset use by recognised AI
  Qadam Build projects but doesn't spell out how a recognised project's *own repo* should carry
  the guidelines. Rather than guess, this folder links. If the tokens should be vendored as a CSS
  file in `packages/web`, that is an explicit decision for Binali, with license headers sorted
  first.

---

## Brand vs. shipping — the gap, file by file

The brand is teal. Large parts of the product still ship the inherited purple. Both are true at
once, and an agent that conflates them will either paint a mockup the wrong colour or silently
rebrand the product. Verified against the tree:

| Thing | Brand says | Repo ships | Where |
| --- | --- | --- | --- |
| Primary colour | teal `#3CA29E` / `oklch(0.58 0.10 192)`; dark `oklch(0.70 0.105 192)` | purple `hsl(257 74% 57%)`; **blue** `hsl(210 90% 50%)` in dark | `packages/web/src/styles.css:414` (light), `:500` (dark) |
| Platform-branding default | teal | `primaryColor: '#8142E3'` | `packages/server/api/src/app/flags/theme.ts:67` |
| Product logo | teal footprint mark | **already teal** | `packages/web/public/logo.svg`, `logo-full.svg`, `logo-192.png`, `logo-180.png`, `og-image.svg` |
| Docs logo + favicon | teal footprint mark | still the purple Activepieces "A" | `docs/resources/logo/light.svg`, `docs/resources/logo/dark.svg`, `docs/favicon.svg`, `docs/favicon.png` |
| Docs site accent | teal | `#9675FF` | `docs/docs.json:6-8` |
| Body font | Inter, Latin **and** Cyrillic equally legible | Inter, **Latin subset only** | `packages/web/src/assets/fonts/inter-v20-latin-*` |
| Display font | Geist | not present; `Sentient-Variable.woff2` is loaded instead — and it **is in use**, via `font-sentient` on the sign-in/signup headings, platform creation, and the chat empty state | `packages/web/src/styles.css:7-12`; used in `create-platform.tsx`, `chat-with-ai/components/chat-empty-state.tsx`, `authentication/components/auth-form-template.tsx`, `authentication/components/auth-animation.tsx` |
| Mono font | JetBrains Mono | not loaded | — |
| Theme default | dark-first (`<html data-theme="dark">`), light a verified peer | light-first: `theme === 'system'` resolves to `'light'` | `packages/web/src/components/providers/theme-provider.tsx:57-61` |
| Radius default | 8px | `--radius: 0.5rem` = 8px ✅ | `packages/web/src/styles.css:410` |
| Icons | Lucide | Lucide ✅ | `packages/web/components.json` (`"iconLibrary": "lucide"`) |

At runtime `--primary` is **overwritten by platform branding** in `theme-provider.tsx:64-67` from
the value the server supplies — so `theme.ts` is as load-bearing as `styles.css`. A recolour that
touches only the CSS changes nothing for a running install.

**Do not recolour the product as a side effect of any other task.** Enumerated scope for when that
decision is taken, all line counts verified:

| File | Lines | What changes |
| --- | --- | --- |
| `packages/web/src/styles.css` | 891 | `--primary-100` / `--primary` / `--primary-300` light (413-415) + dark (499-501); `--sidebar-primary` (471, 525) |
| `packages/server/api/src/app/flags/theme.ts` | 72 | default `primaryColor` (67) |
| `docs/docs.json` | 457 | `colors.primary` / `.light` / `.dark` (6-8) |
| `docs/favicon.svg` | 3 | purple `#8142E3` mark → teal footprint |
| `docs/favicon.png` | binary, 2.7 KB | same |
| `docs/resources/logo/light.svg` | 15 | purple `#8142E3` Activepieces wordmark → AI Qadam lockup |
| `docs/resources/logo/dark.svg` | 15 | white Activepieces wordmark → AI Qadam lockup |
| `packages/web/public/chat-suggestions/card-triage-support.svg` | 238 | one `#8142E3` fill |

Verified **not** in scope, contrary to what you might assume:

- **No Tailwind config file exists.** Tailwind v4 is configured in CSS (`@theme` in `styles.css`).
  There is nothing at `tailwind.config.*` anywhere in the repo.
- **Email templates carry no brand colour.** `packages/server/api/src/assets/emails/*.html`
  (8 files) use only `#ffffff`, `#2f2e2e`, `#a3a3a3`, `#0a0a0a`, `#e5e5e5`.
- **Web logos and app icons are already teal** (`#3CA29E`). `favicon.ico` ships but the app
  replaces the favicon at runtime from platform branding
  (`theme-provider.tsx:31-37`), so it follows branding, not the file.
- A recolour changes **no** `.agents/` or `.claude/` file: after this rewrite they name the brand
  value and the shipping value separately.

Noted and deliberately untouched: `packages/web/public/og-image.png` is the *brand site's* OG
image ("AI Qadam Brand Guidelines · brand.aiqadam.org"), not a Qadam Flow card. It is wrong for
the product's social previews and wants its own fix.

---

## Colour tokens

From the brand's MIT `tokens.css` — Tailwind 4 / shadcn-compatible, OKLCH. **Dark is the brand's
default surface**; light is a verified peer, not an afterthought.

| Token | Light | Dark |
| --- | --- | --- |
| `--background` | `oklch(1 0 0)` | `oklch(0.145 0 0)` |
| `--foreground` | `oklch(0.145 0 0)` | `oklch(0.985 0 0)` |
| `--card` | `oklch(0.99 0 0)` | `oklch(0.205 0 0)` |
| `--popover` | `oklch(1 0 0)` | `oklch(0.205 0 0)` |
| `--muted` | `oklch(0.97 0 0)` | `oklch(0.269 0 0)` |
| `--muted-foreground` | `oklch(0.556 0 0)` | `oklch(0.708 0 0)` |
| `--border` / `--input` | `oklch(0.922 0 0)` | `oklch(0.269 0 0)` |
| `--primary` | `oklch(0.58 0.10 192)` | `oklch(0.70 0.105 192)` |
| `--primary-foreground` | `oklch(0.985 0 0)` | `oklch(0.145 0 0)` |
| `--secondary` / `--accent` | `oklch(0.97 0 0)` | `oklch(0.269 0 0)` |
| `--success` | `oklch(0.696 0.17 162)` | `oklch(0.765 0.17 162)` |
| `--warning` | `oklch(0.768 0.188 70)` | `oklch(0.823 0.188 70)` |
| `--destructive` | `oklch(0.577 0.245 27)` | `oklch(0.704 0.191 22)` |
| `--ring` | = `--primary` | = `--primary` |

Neutrals are **fully desaturated** (chroma 0) — no cool or warm tint. Brand teal is the only
colour with brand meaning; everything else is the neutral scale plus four semantic accents.
**Don't invent new colour tokens.**

Also defined, but specific to AI Qadam community surfaces rather than to Qadam Flow:
`--live-indicator`, `--badge-bronze` / `-silver` / `-gold` / `-special`, `--streak`. Ignore unless
you are building those surfaces.

Qadam Flow's own `--primary-100` / `--primary-300` (soft wash, deep accent) have **no brand
counterpart** — they are a local extension. Treat them as product-local, derive them from
`--primary`, and don't present them as brand tokens.

---

## Typography

Three families, one voice — [`brand.html#typography`](https://brand.aiqadam.org/brand.html#typography):

- `--font-display: "Geist"` — titles, hero, brand.
- `--font-sans: "Inter"` — body copy.
- `--font-mono: "JetBrains Mono"` — times, IDs, tags, technical detail.

**Latin and Cyrillic must read equally well.** Central Asia uses both, and the brand's type
samples are deliberately half Cyrillic. The repo currently loads a Latin-only Inter subset, so
Cyrillic UI text falls back to a system font. Flag it; don't quietly ship Latin-only copy as if
it were fine.

Brand type scale: `6xl` 60/64 · `4xl` 36/40 · `3xl` 30/36 · `2xl` 24/32 · `xl` 20/30 · `lg` 18/28
· `base` 16/24 · `sm` 14/20 · `xs` 12/16. Display sizes carry `-0.01em` to `-0.035em` tracking,
tightening as size grows.

**Body-size ambiguity, unresolved.** The brand type scale labels `base` (16px) "Body default",
while the brand's own `tokens.css` sets `body { font-size: 14px }` and its components (buttons,
inputs, labels) are all built at 13-14px. Qadam Flow ships 14px, which matches the components.
Keep 14px for dense product UI and 16px for brand/marketing prose; if a screen sits between the
two, ask — don't treat either number as settled.

---

## Foundation

**Spacing** — base unit 4px. Scale: 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 80 · 96. Standard card
padding 24px. No negative margins (also banned by `packages/web/CLAUDE.md`).

**Radius** — `sm` 6 · **default 8** · `md` 10 · `lg` 12 · `xl` 16 · `full` 9999. Inputs and
buttons 8, cards 12, modals 16.

**Shadows** — `--shadow-sm` `0 1px 2px rgb(0 0 0 / .05)`, `--shadow` `0 1px 3px rgb(0 0 0 / .1),
0 1px 2px -1px rgb(0 0 0 / .1)`, plus `--shadow-md` and `--shadow-lg`. Cards get a border, not a
shadow; shadows belong to floating surfaces (popovers, menus, dialogs). No coloured shadows.

**Motion** — `--ease-out: cubic-bezier(0.4, 0, 0.2, 1)` for interface transitions (150ms on
components), `--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1)`. The brand defines the spring
curve but doesn't say where to use it, and its own components use `--ease-out` throughout —
default to `--ease-out` and treat springs as unspecified.

**Component dimensions** from `components.css`: button heights 32 / 40 / 44 (icon buttons square
at the same heights); input and textarea 40px tall, textarea min-height 96px; badge and tag 22px
tall with 12px text; switch 36×20 with a 16px thumb; checkbox and radio 16px; avatars 24 / 32 /
40 / 56 / 80 / 120.

**Focus** — `outline: 2px solid var(--ring); outline-offset: 2px` on buttons and controls; inputs
use `border-color: var(--ring)` plus a `0 0 0 2px ring/30%` box-shadow. The repo currently ships a
3px `ring/50` ring. Divergence, not yet reconciled — match the surrounding code inside the
product, match the brand on new brand surfaces.

**Disabled** — the brand doesn't specify a disabled treatment. The repo uses
`opacity: 0.5; pointer-events: none`. Follow the repo, and call it a repo convention.

---

## Iconography

[Lucide](https://lucide.dev) only — line, 2px stroke, 24×24 viewBox, inheriting `currentColor`.
Confirmed as the repo's icon library in `packages/web/components.json`.

- Never mix icon families (no Heroicons + Phosphor + Lucide on one surface).
- Never recolour an icon; let it inherit from text.
- The four-dot motif belongs to the logo alone — never fold it into another icon.
- Emoji and Unicode glyphs (✓ × ←) are not icons. Use a Lucide component.
- Qadam icons: copy the real SVG from `packages/web/src/assets/img/piece/`; never redraw a
  third-party logo.

---

## Logo

Two lockups, one source, both at
[`brand.html#logo`](https://brand.aiqadam.org/brand.html#logo) — download from there, don't
recreate:

- **Mark** — the footprint with four dots. Navbars, favicons, app icons, avatars, anywhere small
  or square. Sizes in use: 20 / 28 / 40 / 64px.
- **Full lockup** — mark plus the `AI QADAM` wordmark. Splash screens, hero blocks, decks, OG
  images, print.

The full lockup is **theme-adaptive**: the footprint stays teal while the letters resolve to
`--foreground` (dark on light, off-white on dark) via `--aiq-logo-dark`. That only works when the
SVG is **inlined** — an `<img>` gets the baked hex fallback. Inline it on any surface whose theme
toggles. For print, bake the fill before exporting.

**Never** recolour, redraw, stretch, skew, rotate, add shadows / glows / gradients / outlines,
crop the four dots, retype the wordmark in a font, or place the mark over busy imagery.

**Writing the name**: `AI Qadam` in prose (title case, two words). `AI QADAM` only inside the
lockup, never in body copy. `#AIQadam` as the hashtag. The product is `Qadam Flow`. Wrong:
`AI-Qadam`, `AIQadam`, `ai qadam`, `AI Kadam`, `Qadam AI`.

---

## Voice & copy

Product copy is functional, direct and honest — honesty over hype is an AI Qadam principle, and it
applies to microcopy as much as to a keynote. Read the seven principles at
[`brand.html#voice`](https://brand.aiqadam.org/brand.html#voice).

- **Person** — second person: "your flows", "you can build".
- **Casing** — sentence case for every UI string. Proper nouns are the features themselves:
  Flows, Runs, Qadams, MCP, Agents, Connections, Tables.
- **Buttons** — verb-first and terse: "New flow", "Publish", "Connect", "Test step", "Run",
  "Save".
- **Empty states / errors** — state the fact, then the action: *"No flows yet. Create your first
  flow to start automating."*
- **No** emoji in product UI, no "Click here", no "Please", no exclamation-mark enthusiasm.

**Do**: "Your flow is live." · "Add a step" · "Connect your Google account"
**Don't**: "Awesome! 🎉 Your flow is now live!" · "Click here to add a step" · "Please authorize
Google"

---

## Imagery

Documentary, not staged — real rooms, real people, real screens. No AI-generated humans, robots,
brain graphics or glowing-data backgrounds; no stock handshakes or staged smiles; no heavy filters
or duotone overlays; no watermarks (credit belongs in the caption). The honesty principle covers
images too. Inside the product, imagery is minimal by default: no hero photos, no illustrations,
no abstract gradients — the real UI is the illustration.

---

## Building product UI

Follow `packages/web/CLAUDE.md`; it is authoritative for the frontend. In brief:

- Reuse `packages/web/src/components/ui/` (Shadcn/Radix "new-york" on Tailwind v4, base colour
  `neutral`) before creating anything; extend an existing component rather than forking it.
- `cn()` from `@/lib/utils` for every `className` — never template literals.
- Design-token classes (`bg-primary`, `text-muted-foreground`, `border-border`, `rounded-md`),
  never raw hex. This is what makes the eventual teal switch a token change instead of a sweep.
- No negative margins.
- Layouts follow the F-pattern: left-aligned, not centred.

---

## Not specified by the brand

Say "unspecified" and ask, rather than inventing a value or keeping an inherited one:

- **The flow builder's dotted canvas.** A Qadam Flow product signature, not a brand element. The
  brand says nothing about it; it survives as a repo convention only.
- **The floating-content-card shell** (inset sidebar plus bordered content card). Repo layout, not
  brand.
- **Dark-mode primary behaviour in the product.** The brand gives one teal per theme. The repo
  shifts primary to *blue* in dark mode (`styles.css:500`) — inherited, matching neither the brand
  nor its own light-mode purple, and needing a decision.
- **Disabled and loading treatments**, **table density**, **z-index layers**, **breakpoints**
  beyond the brand container's 768 / 1024, and **data-visualisation palettes** — all repo-local or
  absent. For charts, load the `dataviz` skill and swap in `--primary` plus the neutral scale.
- **A `--radius-xs`** (the old 2px token) does not exist in the brand scale. Smallest is 6px.

Also gone, and not to be reinstated: this folder previously claimed an inventory of assets —
`colors_and_type.css`, `fonts/`, `assets/`, `preview/`, `ui_kits/web/`, `insights/` — none of
which has ever existed in this repo. Only `SKILL.md` and `README.md` are here. Don't cite those
paths, and don't cite a Figma file: there is no Figma source of truth for this product, only
`brand.aiqadam.org`.
