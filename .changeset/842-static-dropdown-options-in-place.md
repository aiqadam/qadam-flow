---
"@aiqadam/shared": patch
"@aiqadam/qadams-framework": patch
---

`UpdateFieldRequest` accepts `data.options` (and `name` becomes optional), so a table's STATIC_DROPDOWN options can be changed in place (#842). Nothing a qadam reaches through the framework changed: `Field`, `FieldType` and `StaticDropdownEmptyOption` are untouched.
