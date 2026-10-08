Architectural decisions live in `adr/` (standard and index: `adr/README.md`). Before changing a
contract, versioning/distribution, a runtime dependency outside the instance, or anything costly to
reverse, read the accepted ADRs that cover it — the index in `adr/README.md` lists them. Code must
not contradict an accepted ADR: if the task requires it, stop and draft a superseding ADR instead
of diverging silently. When a task meets the triggers in `adr/README.md`, draft the ADR from
`adr/TEMPLATE.md` with `status: proposed` before writing implementation code, and reference it as
`ADR-NNNN` in the implementing PRs. Never edit the body of an accepted ADR — supersede it. Never
set `status: accepted` yourself; maintainers decide.
