// Runs the SSRF / PUT-PATCH probe forms against the real ESLint config of each server package.
// `no-restricted-syntax` selectors fail silently when they stop matching, so a lint pass on the
// codebase proves nothing about them: this proves they still report the forms in
// .agents/rules/safe-http.md, and that the sanctioned exemptions are still exempt.
//
//   node tools/eslint/check-safe-http-probes.mjs
import { ESLint } from 'eslint'
import { rmSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const probeDir = path.join(import.meta.dirname, 'probes')
const RESTRICTED = /^no-restricted-/

// `expect` lists `<rule>@<line>` with lines relative to the probe file. `append` probes are added
// to the end of a real file (the exemptions are keyed on its path), so their lines are shifted.
const CASES = [
    { probe: 'raw-fetch', in: 'server/api/src/__probe__/raw-fetch.ts', expect: ['no-restricted-syntax@1'] },
    { probe: 'globalthis-fetch', in: 'server/api/src/__probe__/globalthis-fetch.ts', expect: ['no-restricted-syntax@1'] },
    { probe: 'obj-fetch', in: 'server/api/src/__probe__/obj-fetch.ts', expect: ['no-restricted-syntax@2'] },
    { probe: 'axios-create', in: 'server/api/src/__probe__/axios-create.ts', expect: ['no-restricted-syntax@3'] },
    { probe: 'axios-call', in: 'server/api/src/__probe__/axios-call.ts', expect: ['no-restricted-syntax@2'] },
    { probe: 'axios-default-import', in: 'server/api/src/__probe__/axios-default-import.ts', expect: ['no-restricted-imports@1'] },
    { probe: 'httpclient-named-import', in: 'server/api/src/__probe__/httpclient-named-import.ts', expect: ['no-restricted-imports@1', 'no-restricted-syntax@1'] },
    { probe: 'httpclient-deep-import', in: 'server/api/src/__probe__/httpclient-deep-import.ts', expect: ['no-restricted-syntax@1'] },
    { probe: 'httpclient-namespace', in: 'server/api/src/__probe__/httpclient-namespace.ts', expect: ['no-restricted-imports@1', 'no-restricted-syntax@2'] },
    { probe: 'httpclient-require-destructure', in: 'server/api/src/__probe__/httpclient-require-destructure.ts', expect: ['no-restricted-syntax@2'] },
    { probe: 'httpclient-dynamic-import-destructure', in: 'server/api/src/__probe__/httpclient-dynamic-import-destructure.ts', expect: ['no-restricted-syntax@2'] },
    { probe: 'put-route', in: 'server/api/src/__probe__/put-route.ts', expect: ['no-restricted-syntax@2', 'no-restricted-syntax@3', 'no-restricted-syntax@4', 'no-restricted-syntax@5', 'no-restricted-syntax@6'] },
    { probe: 'put-fileid-allowed', in: 'server/api/src/__probe__/put-fileid-allowed.ts', expect: [] },
    { probe: 'clean-safehttp', in: 'server/api/src/__probe__/clean-safehttp.ts', expect: [] },
    { probe: 'safehttp-fetch-call', in: 'server/api/src/__probe__/safehttp-fetch-call.ts', expect: ['no-restricted-syntax@2'] },
    { probe: 'zone-engine', in: 'server/engine/src/__probe__/zone-engine.ts', expect: [] },
    { probe: 'zone-shared', in: 'shared/src/__probe__/zone-shared.ts', expect: ['no-restricted-properties@2', 'no-restricted-syntax@3'] },
    { probe: 'zone-api-test', in: 'server/api/test/__probe__/zone-api-test.ts', expect: ['no-restricted-syntax@5'] },
    { probe: 'zone-utils-src', in: 'server/utils/src/__probe__/zone-utils-src.ts', expect: ['no-restricted-imports@1', 'no-restricted-syntax@2', 'no-restricted-syntax@3'] },
    { probe: 'zone-safe-http-file', append: 'server/utils/src/safe-http.ts', expect: ['no-restricted-syntax@2', 'no-restricted-syntax@3'] },
    { probe: 'zone-safe-http-test', append: 'server/utils/test/safe-http-fetch.test.ts', expect: ['no-restricted-syntax@1', 'no-restricted-syntax@2', 'no-restricted-syntax@4'] },
]

// A probe interrupted mid-run would leave bypass code appended to the SSRF wrapper itself, or a stray probe directory.
let restoreInterrupted = () => {}
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
        restoreInterrupted()
        process.exit(130)
    })
}

const failures = []
for (const probeCase of CASES) {
    const failure = await runCase(probeCase)
    if (failure) {
        failures.push(failure)
    }
}

if (failures.length > 0) {
    console.error(failures.join('\n'))
    process.exit(1)
}
console.log(`safe-http lint probes: all ${CASES.length} cases report what they should`)

async function runCase({ probe, in: newFile, append, expect }) {
    const source = await readFile(path.join(probeDir, `${probe}.probe`), 'utf8')
    const relativePath = newFile ?? append
    const file = path.join(root, 'packages', relativePath)
    const original = append ? await readFile(file, 'utf8') : null
    const lineOffset = original === null ? 0 : original.split('\n').length
    const packageDir = path.join(root, 'packages', relativePath.split('/').slice(0, relativePath.startsWith('server/') ? 2 : 1).join('/'))
    restoreInterrupted = () => (original === null ? rmSync(path.dirname(file), { recursive: true, force: true }) : writeFileSync(file, original))
    try {
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, original === null ? source : `${original}\n${source}`)
        const [result] = await new ESLint({ cwd: packageDir }).lintFiles([file])
        // A parse error carries no ruleId, so without this the cases that expect nothing would pass on a file that never parsed.
        const fatal = result.messages.find((message) => message.fatal)
        if (fatal) {
            return `FAIL ${probe}: could not be linted: ${fatal.message}`
        }
        const actual = result.messages
            .filter((message) => RESTRICTED.test(message.ruleId ?? ''))
            .map((message) => `${message.ruleId}@${message.line - lineOffset}`)
            .sort()
        const wanted = [...expect].sort()
        return JSON.stringify(actual) === JSON.stringify(wanted)
            ? null
            : `FAIL ${probe}: expected [${wanted.join(', ')}], got [${actual.join(', ')}]`
    }
    finally {
        if (original === null) {
            await rm(path.dirname(file), { recursive: true, force: true })
        }
        else {
            await writeFile(file, original)
        }
        restoreInterrupted = () => {}
    }
}
