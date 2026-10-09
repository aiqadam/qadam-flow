---
"@aiqadam/platform": minor
---

Workers in the `UNSANDBOXED` and `SANDBOX_CODE_ONLY` execution modes run an official qadam step from the qadam version store when the store holds the pinned version, with `@aiqadam/*` and `zod` provided by the platform (ADR-0003, #779). Workers now read `AP_QADAM_VERSION_STORE_PATH`. No image puts versions in the store yet (#807), so installs run the bundled qadams as before.

Workers must mount the qadam version store read-only: a worker that can write it does not use it (outside `AP_ENVIRONMENT=dev`) and logs "mount the qadam version store read-only on workers". The bundled `docker-compose.yml` mounts `qadam_versions` with `:ro` on workers; an install with an older or custom compose file, or another orchestrator, needs the same change to use the store.
