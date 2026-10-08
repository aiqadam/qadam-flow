# Architecture Decision Records

An ADR records one architectural decision: what was decided, why, what was rejected, and what it
costs. It is the place a decision lives once it is made — not the issue thread where it was argued,
and not the PR that implemented it. Issue threads get long, get corrected, and get read from the
top; an ADR is the short, current answer.

## When an ADR is required

Write one when a change meets **any** of these:

- **It changes a contract other code or other people build against** — the engine ↔ qadam
  contract (`context`, framework/common API), the public REST/MCP surface, the shape of stored
  flows, or the published package layout.
- **It changes how something is versioned, distributed, installed or upgraded** — qadams, images,
  registries, migrations that rewrite stored flows.
- **It adds a runtime dependency on something outside the instance** — a registry, a CDN, a hosted
  service — or removes one. Qadam Flow is self-hosted; every such dependency is a decision about
  someone else's network.
- **It is expensive or impossible to reverse** — anything published, anything that rewrites user
  data, anything self-hosted operators must act on during an upgrade.
- **It picks between options that reasonable people disagree on**, and the losing options will be
  proposed again unless the reason they lost is written down.

Not required: bug fixes, refactors inside one module, and features that follow an existing ADR.
Rule of thumb — if a future contributor would need to know *why* before changing it, it is an ADR.

Some `.agents/features/*.md` files carry an "Architecture Decisions" section written before this
directory existed. They stay as module documentation. When one of those decisions is revisited,
the new decision is an ADR, and the feature doc links to it.

## Files

- `adr/NNNN-kebab-case-title.md` — four digits, sequential, never reused, never renumbered once
  merged. Next number: one above the highest file on `main`. If another PR merges that number
  first, renumber yours on rebase.
- Start from [`TEMPLATE.md`](./TEMPLATE.md). Keep its frontmatter and section order.
- One decision per file. A decision with independent parts that could be accepted or rejected
  separately is two ADRs.
- **Number order is dependency order.** An ADR that relies on others says so under its title
  (`Builds on: ADR-NNNN`) and references only lower numbers; the one relied on is numbered, read
  and accepted first. While proposed, ADRs may be renumbered to keep this true.
- English, like the rest of the repo.

## Status lifecycle

```
proposed ──► accepted ──► superseded (by NNNN)
    │             └─────► deprecated
    └──────► rejected
```

| Status | Meaning |
| --- | --- |
| `proposed` | Written, under discussion. Not binding. |
| `accepted` | Decided. Binding on new code until superseded. |
| `rejected` | Considered and declined. Kept so the option is not re-proposed without new evidence. |
| `superseded` | Replaced by a later ADR named in `superseded-by`. |
| `deprecated` | No longer applies and nothing replaces it (the subsystem is gone). |

## Process

1. **Discuss in an issue first.** Exploration, measurements and dead ends belong in the issue.
2. **Open a PR that adds the ADR with `status: proposed`**, linked from that issue. The PR carries
   only the ADR (and this index); implementation goes in separate PRs.
3. **Decide.** Maintainers decide — at an architecture session or in the PR review. Record who
   decided in `deciders`.
4. **Flip to `accepted`** (or `rejected`), set `date` to the decision date, update the index below,
   merge, and comment on the issue with a link to the ADR.
5. **Implementation tickets and PRs reference the ADR** as `ADR-NNNN` with a link. Implementation
   may be prototyped while the ADR is `proposed`, but it merges only after the ADR is `accepted`.

## Rules that keep ADRs useful

- **An accepted ADR is immutable.** Only `status`, `superseded-by` and broken links may change.
  Changing the decision means writing a new ADR with `supersedes: "NNNN"` (a list such as
  `["0003", "0005"]` when one decision replaces several). Reopening a `rejected` or `deprecated`
  ADR names it in `supersedes` too, but that one keeps its status. The old one flips to
  `superseded` (with `superseded-by`) in the PR that accepts the new one — not while it is still
  `proposed`.
- **Evidence over assertion.** Numbers say how they were measured; claims about code cite
  `path:line` at a commit; claims about history cite the issue, PR or run. An ADR that will be
  read in a year must not depend on what everyone remembers today.
- **Rejected options are mandatory.** Each one says why it lost. That section is what stops the
  same debate from restarting.
- **Consequences include the costs.** What gets harder, what new obligations appear (API
  stability, migrations, docs), and what is now irreversible.
- **Agents propose, maintainers decide.** An agent may draft an ADR and open the PR. It sets
  `accepted` or `rejected` only after a maintainer has decided and told it to, and records them in
  `deciders`.

## Index

One row per ADR, in number order: ``| [`0001`](0001-title.md) | Title | `accepted` |``.
`npm run check-agent-docs` fails when a file is missing from this table, a row has no file, a
row shows a status other than the file's, a file name or status is invalid, a decided ADR has no
`deciders`, a row is duplicated or the placeholder row outlives the first ADR, or supersession is
not recorded on both sides (`superseded-by` on the old ADR, `supersedes` on the new one) or loops.
Immutability of accepted ADRs is checked in review.

| ADR | Title | Status |
| --- | --- | --- |
| — | No ADRs yet | — |
