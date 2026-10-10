---
"@aiqadam/shared": patch
"@aiqadam/qadams-framework": patch
---

`KnowledgeBaseFile` is now exported as its Zod schema, and `ProjectColor` is written as a plain type, so typescript-eslint 8.71.1 stops flagging them as "only used as a type" (#793). Both types are unchanged; nothing a qadam reaches through the framework changed.
