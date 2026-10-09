import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Builds archives shaped like #804's `--pack` output (`archive-index.json` + npm-pack tarballs with
// `package/package.json` and `package/metadata.json`), with `tar` as `npm pack` would lay them out.
export const catalogueFixtures = {
    tempDir: (prefix: string): Promise<string> => mkdtemp(path.join(tmpdir(), prefix)),

    metadata: ({ name, version, overrides = {} }: MetadataParams): Record<string, unknown> => ({
        name,
        version,
        displayName: `Fixture ${name}`,
        logoUrl: 'https://cdn.example.com/logo.svg',
        description: 'A fixture qadam',
        authors: ['fixture'],
        minimumSupportedRelease: '0.82.0',
        actions: { say_hello: { name: 'say_hello', displayName: 'Say hello', description: 'Says hello', props: {}, requireAuth: false } },
        triggers: {},
        categories: [],
        i18n: { ru: { 'Say hello': 'Скажи привет' } },
        contextInfo: { version: '2' },
        ...overrides,
    }),

    writeArchive: async ({ archiveDir, artifacts }: WriteArchiveParams): Promise<ArchiveEntry[]> => {
        await mkdir(archiveDir, { recursive: true })
        const entries: ArchiveEntry[] = []
        for (const artifact of artifacts) {
            entries.push(await packArtifact({ archiveDir, artifact }))
        }
        await writeFile(path.join(archiveDir, 'archive-index.json'), JSON.stringify({
            formatVersion: 1,
            artifacts: entries.map((entry) => ({ ...entry.indexEntry, ...entry.indexOverrides })),
        }, null, 2))
        return entries
    },

    sha512: (bytes: Buffer): string => `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
}

export const FIXTURE_COMMIT = 'a'.repeat(40)

async function packArtifact({ archiveDir, artifact }: { archiveDir: string, artifact: FixtureArtifact }): Promise<ArchiveEntry> {
    const { name, version, kind = 'bundle' } = artifact
    const staging = await mkdtemp(path.join(tmpdir(), 'catalogue-pack-'))
    try {
        const packageDir = path.join(staging, 'package')
        await mkdir(packageDir, { recursive: true })
        const packageJson = artifact.packageJson ?? {
            name,
            version,
            main: './src/index.js',
            qadamArtifact: { formatVersion: 1, kind },
        }
        await writeFile(path.join(packageDir, 'package.json'), JSON.stringify(packageJson, null, 2))
        const metadataBytes = Buffer.from(JSON.stringify(artifact.metadata ?? catalogueFixtures.metadata({ name, version })))
        if (artifact.withMetadata !== false) {
            await writeFile(path.join(packageDir, 'metadata.json'), metadataBytes)
        }
        await mkdir(path.join(packageDir, 'src'), { recursive: true })
        await writeFile(path.join(packageDir, 'src', 'index.js'), `module.exports = { marker: ${JSON.stringify(artifact.marker ?? `${name}@${version}`)} }\n`)
        const file = `${name.replace('@', '').replace('/', '-')}-${version}.tgz`
        execFileSync('tar', ['-czf', path.join(archiveDir, file), '-C', staging, 'package'])
        const tarball = await readFile(path.join(archiveDir, file))
        return {
            file,
            metadataBytes,
            indexEntry: {
                name,
                version,
                kind,
                file,
                integrity: catalogueFixtures.sha512(tarball),
                shasum: createHash('sha1').update(tarball).digest('hex'),
                size: tarball.length,
                commit: { sha: FIXTURE_COMMIT, dirtyQadams: false },
            },
            indexOverrides: artifact.indexOverrides ?? {},
        }
    }
    finally {
        await rm(staging, { recursive: true, force: true })
    }
}

type MetadataParams = {
    name: string
    version: string
    overrides?: Record<string, unknown>
}

export type FixtureArtifact = {
    name: string
    version: string
    kind?: string
    marker?: string
    metadata?: Record<string, unknown>
    packageJson?: Record<string, unknown>
    withMetadata?: boolean
    indexOverrides?: Record<string, unknown>
}

type WriteArchiveParams = {
    archiveDir: string
    artifacts: FixtureArtifact[]
}

export type ArchiveEntry = {
    file: string
    metadataBytes: Buffer
    indexEntry: Record<string, unknown>
    indexOverrides: Record<string, unknown>
}
