---
"@aiqadam/platform": minor
---

The qadam version catalogue's address (ADR-0003, #778) is now configurable: `AP_QADAM_VERSION_CATALOGUE_URL` points the server at a mirror instead of the published address, and `AP_QADAM_VERSION_CATALOGUE_DIRECTORY` points it at a local copy — such as an air-gapped mirror or the snapshot a `:slim` image carries — which takes precedence over the URL and sends no request. Flow export and the pin-fallback seam both read through this configured address; a missing or unreadable directory makes the catalogue unavailable rather than falling back to the URL.
