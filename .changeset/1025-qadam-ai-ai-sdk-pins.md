---
"@aiqadam/qadam-ai": patch
---

Depend on `ai` 7.0.163 and `@ai-sdk/provider-utils` 5.0.75, the versions the platform already runs, and move the `@ai-sdk/*` providers to the matching releases, so the qadam's `LanguageModel` type and the provider factories come from one copy of `@ai-sdk/provider` again (#1025). No action, prop or output changed.
