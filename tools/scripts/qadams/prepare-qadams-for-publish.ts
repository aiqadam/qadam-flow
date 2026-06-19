import { findAllQadamsDirectoryInSource } from '../utils/qadam-script-utils'
import { prepareQadamDistForPublish } from '../../../packages/cli/src/lib/utils/prepare-qadam-utils'

function getChangedQadamPaths(): string[] | null {
    const changedQadams = process.env['CHANGED_QADAMS']
    if (!changedQadams || changedQadams.trim() === '') {
        return null
    }
    return changedQadams.split('\n').filter(Boolean)
}

async function main(): Promise<void> {
    const changedPaths = getChangedQadamPaths()
    const qadamPaths = changedPaths ?? await findAllQadamsDirectoryInSource()

    console.info(`[prepareQadams] processing ${qadamPaths.length} qadams${changedPaths ? ' (scoped to changed)' : ' (all)'}`)

    for (const qadamPath of qadamPaths) {
        prepareQadamDistForPublish(qadamPath)
    }

    console.info(`[prepareQadams] done, prepared ${qadamPaths.length} qadams`)
}

main()
