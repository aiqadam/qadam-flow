---
"@aiqadam/shared": patch
"@aiqadam/qadams-framework": patch
---

`RegistryQadamsRequestQuery` and `ListQadamsRequestQuery` accept a prerelease platform version as `release` (`2.1.0-main.5`), so the builder's version list works on images built from `main` instead of answering 400 (#798).
