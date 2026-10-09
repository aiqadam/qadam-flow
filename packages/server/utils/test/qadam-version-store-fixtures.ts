import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'

// Builds tarballs byte by byte, so a test can write exactly the hostile entry it means (a `..`
// path, a symlink, a duplicate) — a tar library would normalise or refuse most of them.
export const tarFixtures = {
    tarball: ({ entries }: { entries: TarEntry[] }): Buffer => {
        const blocks = entries.flatMap((entry) => {
            const content = Buffer.from(entry.content ?? '')
            const header = buildHeader({ ...entry, size: entry.type === '0' ? content.length : 0 })
            if (entry.type !== '0') {
                return [header]
            }
            const padding = Buffer.alloc((BLOCK - (content.length % BLOCK)) % BLOCK)
            return [header, content, padding]
        })
        return gzipSync(Buffer.concat([...blocks, Buffer.alloc(BLOCK * 2)]))
    },

    integrity: ({ data }: { data: Buffer }): string => `sha512-${createHash('sha512').update(data).digest('base64')}`,

    // The files of a qadam version in either format, as `package/<path>` tar entries.
    artifactEntries: ({ files }: { files: Record<string, string> }): TarEntry[] => {
        return Object.entries(files).map(([path, content]) => ({ path: `package/${path}`, type: '0', content, mode: 0o644 }))
    },

    bundleFiles: ({ name, version, kind = 'bundle', builtFor, extra = {} }: BundleFilesParams): Record<string, string> => ({
        'package.json': JSON.stringify({
            name,
            version,
            main: './src/index.js',
            peerDependencies: { '@aiqadam/qadams-framework': '^0.36.0', 'zod': '^4.3.6' },
            qadamArtifact: { formatVersion: 1, kind, ...(builtFor ? { builtFor } : {}) },
        }),
        'src/index.js': ENTRY_SOURCE,
        'metadata.json': JSON.stringify({ name, version, displayName: name, actions: {}, triggers: {} }),
        ...extra,
    }),

    legacyFiles: ({ name, version, extra = {} }: LegacyFilesParams): Record<string, string> => ({
        'package.json': JSON.stringify({
            name,
            version,
            main: './src/index.js',
            dependencies: { '@aiqadam/qadams-framework': '0.35.0', '@aiqadam/shared': '0.155.0', 'zod': '4.3.6', 'left-pad': '1.0.0' },
        }),
        'src/index.js': ENTRY_SOURCE,
        'metadata.json': JSON.stringify({ name, version, displayName: name, actions: {}, triggers: {} }),
        'node_modules/left-pad/package.json': JSON.stringify({ name: 'left-pad', version: '1.0.0', main: 'index.js' }),
        'node_modules/left-pad/index.js': 'exports.marker = "left-pad inside the version"\n',
        ...extra,
    }),

    writeFiles: async ({ dir, files }: { dir: string, files: Record<string, string> }): Promise<void> => {
        for (const [path, content] of Object.entries(files)) {
            await mkdir(dirname(join(dir, path)), { recursive: true })
            await writeFile(join(dir, path), content)
        }
    },
}

// What a qadam does at load: reach the framework the platform provides and, for the legacy format,
// a third-party dependency of its own.
const ENTRY_SOURCE = `
const framework = require('@aiqadam/qadams-framework')
let pad = null
try { pad = require('left-pad').marker } catch (e) { pad = null }
exports.loaded = { framework: framework.marker, pad }
`

const BLOCK = 512

function buildHeader({ path, type, size, mode = 0o644, linkname = '' }: TarEntry & { size: number }): Buffer {
    const header = Buffer.alloc(BLOCK)
    header.write(path, 0, 100, 'utf8')
    header.write(octal({ value: mode, width: 8 }), 100, 'ascii')
    header.write(octal({ value: 0, width: 8 }), 108, 'ascii')
    header.write(octal({ value: 0, width: 8 }), 116, 'ascii')
    header.write(octal({ value: size, width: 12 }), 124, 'ascii')
    header.write(octal({ value: 0, width: 12 }), 136, 'ascii')
    header.write(' '.repeat(8), 148, 'ascii')
    header.write(type, 156, 'ascii')
    header.write(linkname, 157, 100, 'utf8')
    header.write('ustar\u000000', 257, 'ascii')
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(`${checksum.toString(8).padStart(6, '0')}\u0000 `, 148, 'ascii')
    return header
}

function octal({ value, width }: { value: number, width: number }): string {
    return `${value.toString(8).padStart(width - 1, '0')}\u0000`
}

export type TarEntry = {
    path: string
    // '0' file, '1' hard link, '2' symlink, '5' directory, '3' character device, 'S' sparse (a type
    // node-tar does not know, and so skips)
    type: '0' | '1' | '2' | '3' | '5' | 'S'
    content?: string
    mode?: number
    linkname?: string
}

type BundleFilesParams = {
    name: string
    version: string
    kind?: string
    builtFor?: Record<string, string>
    extra?: Record<string, string>
}

type LegacyFilesParams = {
    name: string
    version: string
    extra?: Record<string, string>
}
