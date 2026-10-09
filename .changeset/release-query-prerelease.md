---
"@aiqadam/shared": patch
"@aiqadam/qadams-framework": patch
---

`RegistryQadamsRequestQuery` accepts a prerelease platform version as `release` (`2.1.0-main.5`), so `GET /v1/qadams/registry` — the builder's version list — answers images built from `main` instead of failing with 400 (#798). `ListQadamsRequestQuery` validates `release` the same way; that endpoint still refuses any `release` as deprecated.
