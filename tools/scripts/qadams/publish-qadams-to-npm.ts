import { publishNpmPackage } from '../utils/publish-npm-package'
import { findAllQadamsDirectoryInSource } from '../utils/qadam-script-utils'
import { chunk } from '../../../packages/shared/src/lib/core/common/utils/utils'

function getChangedQadamPaths(): string[] | null {
  const changedQadams = process.env['CHANGED_QADAMS']
  if (!changedQadams || changedQadams.trim() === '') {
    return null
  }
  return changedQadams.split('\n').filter(Boolean)
}

const main = async () => {
  const changedPaths = getChangedQadamPaths()
  const qadamsSource = changedPaths ?? await findAllQadamsDirectoryInSource()

  console.info(`[publishQadams] publishing ${qadamsSource.length} qadams${changedPaths ? ' (scoped to changed)' : ' (all)'}`)

  const qadamsSourceChunks = chunk(qadamsSource, 30)

  for (const c of qadamsSourceChunks) {
    await Promise.all(c.map((path) => publishNpmPackage(path)))
    await new Promise(resolve => setTimeout(resolve, 5000))
  }
}

main()
