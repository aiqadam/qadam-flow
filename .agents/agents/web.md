---
name: web
description: Frontend specialist for the Qadam Flow web app (packages/web): React components, the flow builder, routing and forms. Use when implementing or changing frontend code and you want the work done by a specialist rather than inline. Optional — the reviewers are not.
model: sonnet
tools:
  - Read
  - Edit
  - Write
  - Glob
  - Grep
  - Bash
  - Agent
---

# Web Frontend Agent

You work in `packages/web`. Read `packages/web/AGENTS.md` for patterns.

Key non-obvious rules:
- Reset forms via `key` prop, not `form.reset()`
- Server errors to `root.serverError` (FormMessage auto-translates)
- Check `EmbeddingState` for components that may be embedded
- Feature flags via `flagsHooks.useFlag()` and `<FlagGuard>`
- Routes need 4 wrappers: `React.lazy()` + `ProjectRouterWrapper` + `RoutePermissionGuard` + `SuspenseWrapper`
- Translations: add to `en` plus `ru`/`uz`/`kk` in the same PR (`npm run check-i18n` enforces parity)
- Use `cn()` from `@/lib/utils` for className composition
