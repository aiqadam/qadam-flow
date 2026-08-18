# Qadam Flow documentation

The source of https://docs.aiqadam.org. A [Mintlify](https://mintlify.com) project: 171 MDX
pages, an OpenAPI spec under `endpoints/`, and the navigation in `docs.json`.

## How it is published

The Mintlify GitHub App is installed on `aiqadam/qadam-flow` and watches the **`main`** branch
with `docs` as its content directory. Every merge to `main` that touches this folder redeploys
the site automatically — there is no workflow in `.github/workflows/` that builds or uploads
docs, and nothing to run by hand.

Two consequences worth internalising before editing:

- **A docs change is a production deploy.** There is no staging step and no approval gate. A
  broken link merged to `main` is a broken link on the public site minutes later.
- **A page is only reachable if `docs.json` lists it.** Adding an `.mdx` file is not enough;
  Mintlify builds its navigation from `docs.json`, so an unlisted page ships as a 404 for
  anyone without the direct URL.

## Working on the docs

```bash
npm i -g mint     # the Mintlify CLI
cd docs           # must be the folder holding docs.json
mint dev          # preview at http://localhost:3000
```

Before opening a PR, run the same check CI runs:

```bash
cd docs && npx mint broken-links
```

**Read its output, not its exit code.** `mint broken-links` exits `0` whether it finds six
broken links or none — the count is only in the text it prints. This is why the `Docs` job in
`.github/workflows/ci.yml` greps the output instead of trusting `$?`, and why six broken links
sat in this folder unnoticed until the site was first published.

## Conventions

Writing style, component usage and frontmatter rules are in
[`.agents/rules/mintlify.md`](../.agents/rules/mintlify.md). The `mintlify` skill
(`.agents/skills/mintlify/`) covers navigation and API-reference setup.

Brand colours in `docs.json` follow the AI Qadam brand teal, not the product's shipping
purple — see `.agents/skills/design/` for which of the two applies to a given surface.
