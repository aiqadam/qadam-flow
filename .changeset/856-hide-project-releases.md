---
"@aiqadam/platform": patch
---

The flow builder no longer shows a "Releases" tab or an "Environment" settings tab: both fronted a Project Releases / Git Sync backend that this repository does not implement. The `/releases` routes now redirect to the project's flows, the Project Releases guide and its `/v1/project-releases` API pages are removed from the docs navigation, and the docs no longer claim git sync ships. No data or API changes (#856).
