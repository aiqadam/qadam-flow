Package manager is **bun** (see `packageManager` in `package.json`). Use `bun install` to install deps.
Never run `npm install` — it fails in npm arborist dedup (`TypeError: Cannot read properties of null (reading 'matches')`).
`npm run <script>` entries in `package.json` are fine to invoke — they just delegate to turbo.
