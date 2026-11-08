---
"@aiqadam/shared": patch
"@aiqadam/qadams-framework": patch
---

Fields declared as bare `z.unknown()` / `z.any()` that can be `undefined` now carry `.optional()`, so they keep accepting a missing key after JSON drops it — e.g. a bodiless webhook handshake (`TriggerPayload.body`), an inline-subflow call without a payload, a resume callback without data, an `EmptyTrigger` without `settings`, a required `Custom` prop with no value. zod 4.3 accepted these; zod 4.6 rejects a missing key unless the field is optional (#949). The inferred types only loosen (`field: unknown` → `field?: unknown`); no schema rejects anything it accepted before.
