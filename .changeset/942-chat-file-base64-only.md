---
"@aiqadam/shared": patch
---

`ChatMessageFile.data` (part of `SendChatMessageRequest`) is now validated as bare base64. A string there used to be handed to the AI SDK as-is, which tries it as a URL before falling back to inline data — so an `http(s)://` or `data:` string made the chat API server fetch it with the SDK's own downloader, bypassing `safeHttp` / `AP_SSRF_ALLOW_LIST` (#942). The web client already only ever sends bare base64 (`FileReader.readAsDataURL`, posted after the comma), so this closes a server-side gap without changing what the app does.
