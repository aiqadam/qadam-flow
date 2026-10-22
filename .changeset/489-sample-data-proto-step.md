---
"@aiqadam/shared": patch
"@aiqadam/qadams-framework": patch
---

Keep a step named `__proto__` in queued sample data: `ExecuteFlowJobData` / `ExecutePropertyJobData` no longer parse `sampleData` with `z.record`, which drops an own `__proto__` key (#489). The inferred type is unchanged.
