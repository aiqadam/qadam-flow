---
"@aiqadam/platform": minor
---

A step pinned to a pre-release qadam build (`x.y.z-main.<n>`, the version a build from `main` gives a changed qadam) now shows "Update available" in the builder step settings once the instance knows a released version of the same qadam inside the pin's caret range — the graduation ADR-0004 describes, where `^1.3.0-main.412` contains the base release `1.3.0` and later patches like `1.3.2`. The offer names the newest such release and opens the existing update dialog on exactly that version; it never rewrites the pin on its own. The `follow` hold state from #854 remains a later slice (ADR-0004, #855).
