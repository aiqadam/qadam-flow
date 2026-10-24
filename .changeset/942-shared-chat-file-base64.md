---
"@aiqadam/qadams-framework": patch
---

Vendors the `@aiqadam/shared` fix tightening `ChatMessageFile.data` (part of `SendChatMessageRequest`) to bare base64 (#942). No qadam reads this schema today, so nothing a qadam author ships changes.
