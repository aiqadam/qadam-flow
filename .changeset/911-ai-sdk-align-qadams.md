---
"@aiqadam/qadams-framework": patch
"@aiqadam/qadam-ai": patch
---

Depend on `ai` 7.0.143 and its `@ai-sdk/provider-utils` 5.0.62, the versions the platform now runs, so the framework's `Tool` type and the AI qadam's provider factories no longer come from two copies of `provider-utils`. The AI qadam's `@ai-sdk/*` providers move to the matching releases. No API changed.
