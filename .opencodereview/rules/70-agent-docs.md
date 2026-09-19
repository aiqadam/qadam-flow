# Agent-facing documentation conventions

Scope: `AGENTS.md`, `**/AGENTS.md`, `.agents/**`. Source: root `AGENTS.md`,
`.agents/rules/skill-usage.md`, `.agents/rules/agent-delegation.md`.

- `.agents/` is the single source. `.claude/` and `.cursor/` are git symlinks into
  it — a diff that edits a mirror, or replaces a mirror symlink with a real
  directory, is a finding.
- A new or renamed skill must appear in the trigger registry in
  `.agents/rules/skill-usage.md`, and a new or renamed charter in the delegation
  matrix in `.agents/rules/agent-delegation.md`. A new rule file must appear in
  the rules index in the root `AGENTS.md`. `npm run check-agent-docs` enforces all
  three in both directions; a PR that adds one of these files without its row is a
  finding even when the gate has not run yet.
- Every `SKILL.md` and charter needs YAML frontmatter with `name` matching its path
  and a `description` that states **when to use it** ("Use when …", "Use before …").
  A description that only names the topic is a finding: it is the only text a
  harness reads when deciding whether to load the file.
- Instructions must be stated as obligations, not as availability. "When invoked",
  "if you want to", "you may consider" applied to a mandatory skill or a mandatory
  review is a finding — that phrasing is why half the skills here went unused.
- Do not restate the trigger registry or the delegation matrix in the root
  `AGENTS.md`: it carries the mandate and a link, the rule file carries the table.
  A per-package `AGENTS.md` may carry a short routing table of the skills and
  agents that apply to that package — those are covered by the gate, which
  verifies that every `` `<name>` skill ``, `` `<name>` agent ``,
  `` `<name>` reviewer `` and `.agents/skills|agents/<name>` reference in any
  `AGENTS.md` resolves to a file that exists. Write a charter reference in one of
  those shapes; prose the gate cannot see is how the first version of it missed
  every `code-quality` / `app-sec` mention in the repo.
- The product is Qadam Flow. "Activepieces" in agent-facing prose is a finding
  unless it is explicitly about the upstream fork or its Enterprise licence.
- A skill's supporting files live in the skill's own directory and are linked from
  its `SKILL.md`; a deep dive under `.agents/docs/` must be linked from the root
  `AGENTS.md`.
