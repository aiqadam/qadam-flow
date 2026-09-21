import { readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { cwd } from 'node:process'

// The official catalogue, and only it. `packages/qadams` also holds `framework/` and `common/`
// — two of the three packages step 1a already publishes (#475) — and `custom/`, which is where
// a locally authored qadam lands and is by definition not official. Naming the two official
// roots is what keeps all three out; the alternative spelling, traversing `packages/qadams` and
// then subtracting a denylist of package names, is a second list to keep in step with
// FRAMEWORK_PACKAGE_PATHS by hand. When it drifts the symptom is two tarballs for the same
// name@version in one publish manifest: the second 403s after the first has already uploaded,
// so a stale denylist reads as a mid-publish build failure rather than as a duplicate.
const OFFICIAL_QADAM_ROOTS = ['packages/qadams/core', 'packages/qadams/community']

// Deliberately NOT `findAllQadamsDirectoryInSource` from qadam-script-utils, for two reasons.
// It returns the framework packages too — its callers filter them out afterwards with
// NON_QADAM_PACKAGES, which a publish cannot rely on for the reason above — and importing that
// module pulls in `@aiqadam/qadams-framework` at load time, which would make the publish script
// unrunnable until the framework is built. `tools/ci/test-publish-workspace-invariants.sh`
// invokes that script to assert a refusal that must happen before anything is built.
export async function findOfficialQadamPackagePaths(): Promise<string[]> {
    const roots = OFFICIAL_QADAM_ROOTS.map((root) => resolve(cwd(), root))
    const found = await Promise.all(roots.map((root) => collectPackageDirectories(root)))

    // Sorted so the publish manifest is byte-identical between two runs of the same tree.
    // Directory order from `readdir` is filesystem order, not lexical, and a manifest that
    // reshuffles run to run makes "did this change" unanswerable by diffing two artifacts.
    return found.flat().map((path) => relative(cwd(), path)).sort()
}

// Stops descending at the first package.json rather than continuing through it: a qadam is a
// leaf package, so anything below one is its own fixture or test tree and is not publishable.
async function collectPackageDirectories(directory: string): Promise<string[]> {
    const stats = await stat(directory).catch(() => null)
    if (stats === null || !stats.isDirectory()) {
        return []
    }

    const entries = await readdir(directory, { withFileTypes: true })
    if (entries.some((entry) => entry.isFile() && entry.name === 'package.json')) {
        return [directory]
    }

    const nested = await Promise.all(
        entries
            .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist')
            .map((entry) => collectPackageDirectories(join(directory, entry.name))),
    )
    return nested.flat()
}
