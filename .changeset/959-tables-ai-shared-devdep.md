---
"@aiqadam/qadam-tables": patch
"@aiqadam/qadam-ai": patch
---

Re-point the type-only `@aiqadam/shared` imports narrowed out of `qadams-framework`'s re-export list (#959) straight at `@aiqadam/shared` as `import type`. No behaviour change: `tsc` erases every one of these imports from the emitted JS, and `@aiqadam/shared` is added only as a `devDependency` (never installed by a consumer), the same pattern `@aiqadam/qadams-common` already uses for its tests.
