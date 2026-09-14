Before writing code for an issue, read **all of it**: `gh issue view <n> --comments`, plus
`gh pr list --state all --search "<n> in:title,body"` for closed PRs that already tried and
rejected an approach, plus `git branch -a` / `git worktree list` for work already in flight.
Open every issue, PR, run URL and SHA linked from the body **or the comments** — that is
paid-for context. The body is the hypothesis; the comments are the evidence, and where the two
disagree the comments win. Skipping this rebuilt an already-measured-and-rejected change from
scratch once (#155 / closed PR #157 / PR #191). See "Read the whole ticket" in AGENTS.md.
