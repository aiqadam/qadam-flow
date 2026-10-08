# Architecture Decision Records

Scope: `adr/**/*.md`. Source: `adr/README.md`, `.agents/rules/adr.md`. File names, statuses,
`deciders`, supersession and index parity are also enforced by `npm run check-agent-docs`;
immutability of accepted ADRs is checked only in review (ocr does not apply rules to Markdown).

- A new ADR is `adr/NNNN-kebab-case-title.md`, numbered one above the highest existing file. A
  reused, skipped or renumbered number is a finding.
- Frontmatter must carry `status`, `date`, `deciders`, `issue`, `supersedes`, `superseded-by`, and
  `status` must be one of `proposed`, `accepted`, `rejected`, `superseded`, `deprecated`.
- Sections follow `adr/TEMPLATE.md`. Missing `Options considered`, or a rejected option with no
  reason it lost, is a finding — that section is what stops the debate from restarting.
- Editing the body of an `accepted` ADR is a finding. Only `status`, `superseded-by` and broken
  links may change; a changed decision is a new ADR with `supersedes`, and the old one flips to
  `superseded` in the PR that accepts the new one. Reopening a `rejected` or `deprecated` ADR names
  it in `supersedes` but leaves its status as it was.
- Setting `accepted` or `rejected` without a maintainer decision recorded in `deciders` (and in
  the PR or issue thread) is a finding, whoever authored the diff.
- The index table in `adr/README.md` must list every ADR file with its current status.
- Claims need evidence: numbers say how they were measured, code is cited as `path:line` at a
  commit, history cites the issue or PR. An unsupported "this is faster / safer / standard" is a
  finding.
