import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isNil, tryCatch, tryCatchSync } from '@aiqadam/shared'
import semver from 'semver'
import { z } from 'zod'
import { frameworkCensusPolicy } from './framework-census-policy'

// Which framework major a bundled official qadam build was compiled against, read from its own
// `package.json` (ADR-0002). Official qadams have no `qadam_metadata` row on an instance that only
// bundles them, so the build itself is the only record.
export const frameworkBuildMajor = {
    // Builds are cached by directory: the image's builds do not change while the process lives.
    async ofBuild({ directoryPath }: { directoryPath: string | undefined }): Promise<number | null> {
        if (isNil(directoryPath)) {
            return frameworkCensusPolicy.currentFrameworkMajor()
        }
        const cached = majorByBuild.get(directoryPath)
        if (!isNil(cached)) {
            return cached
        }
        const { data: content } = await tryCatch(() => readFile(path.join(directoryPath, 'package.json'), 'utf-8'))
        const major = frameworkBuildMajor.fromPackageJson({ content })
        majorByBuild.set(directoryPath, major)
        return major
    },

    // Bundled builds are compiled in this tree, so their `dist/package.json` names the framework as
    // `workspace:*`, which is the current major. A build layered in from elsewhere names a version
    // or a range, whose lowest version gives the major. Anything unreadable is unknown (`null`).
    fromPackageJson({ content }: { content: string | null }): number | null {
        if (isNil(content)) {
            return null
        }
        const { data: json } = tryCatchSync(() => JSON.parse(content))
        const parsed = buildPackageJson.safeParse(json)
        if (!parsed.success) {
            return null
        }
        const spec = parsed.data.dependencies?.[FRAMEWORK_PACKAGE] ?? parsed.data.peerDependencies?.[FRAMEWORK_PACKAGE]
        if (isNil(spec)) {
            return null
        }
        if (spec.startsWith('workspace:')) {
            return frameworkCensusPolicy.currentFrameworkMajor()
        }
        const { data: minimum } = tryCatchSync(() => semver.minVersion(spec))
        return minimum?.major ?? null
    },
}

const FRAMEWORK_PACKAGE = '@aiqadam/qadams-framework'

const majorByBuild = new Map<string, number | null>()

const buildPackageJson = z.object({
    dependencies: z.record(z.string(), z.string()).optional(),
    peerDependencies: z.record(z.string(), z.string()).optional(),
})
