---
"@aiqadam/platform": minor
---

Workers in the `UNSANDBOXED` and `SANDBOX_CODE_ONLY` execution modes run an official qadam step from the qadam version store when the store holds the pinned version, with `@aiqadam/*` and `zod` provided by the platform (ADR-0003, #779). Workers now read `AP_QADAM_VERSION_STORE_PATH`. No image puts versions in the store yet (#807), so installs run the bundled qadams as before.
