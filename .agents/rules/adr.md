Architectural decisions live in `adr/`; the standard, the triggers and the index are in
`adr/README.md`. Before a change that meets any trigger listed there, read the accepted ADRs in the
index that cover it. Code must not contradict an accepted ADR: if the task requires it, stop and
draft a superseding ADR instead of diverging silently. When a task meets a trigger and no ADR
covers it, draft one from `adr/TEMPLATE.md` with `status: proposed` before writing implementation
code, and reference it as `ADR-NNNN` in the implementing PRs. Never edit the body of an accepted
ADR — supersede it. Set `accepted` or `rejected` only after a maintainer has decided and told you
to, and record them in `deciders`.
