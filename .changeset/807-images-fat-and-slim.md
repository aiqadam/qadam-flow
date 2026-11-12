---
"@aiqadam/platform": minor
---

Publish `:fat` and `:slim` images for every release (ADR-0003, #807). `:slim` carries the platform and the 27 core qadams (plus four community qadams the server itself depends on), and fetches other community qadams from a registry on demand; `:fat` bundles every official qadam. `run.sh` now installs `:slim` by default and accepts `QADAM_REGISTRY_URL` / `QADAM_REGISTRY_TOKEN`, probing the registry before pulling and suggesting `:fat` when it is unreachable. `:latest` and the unsuffixed exact-version tags remain aliases of the fat image for existing installs, and are deprecated for new ones.
