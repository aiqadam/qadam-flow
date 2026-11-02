---
"@aiqadam/qadam-ai": patch
---

Depend on `ai` 7.0.157, `@ai-sdk/provider-utils` 5.0.71 and `ai-gateway-provider` 4.0.2, the versions the platform already runs, and move the `@ai-sdk/*` providers to the matching releases, so the Cloudflare AI Gateway models and the qadam's own `LanguageModel` type come from one copy of `@ai-sdk/provider` again (#997). No action, prop or output changed.
