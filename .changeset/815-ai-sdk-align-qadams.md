---
"@aiqadam/qadams-framework": patch
"@aiqadam/qadam-ai": patch
---

Depend on `ai` 7.0.129 and its `@ai-sdk/provider-utils` 5.0.55, the versions the platform already runs, so the framework's `Tool` type and the AI qadam's provider factories no longer come from two copies of `provider-utils` (#815). The AI qadam's `@ai-sdk/*` providers move to the matching releases. No API changed.
