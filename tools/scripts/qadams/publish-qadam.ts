// Local, single-qadam publisher: `npm run publish-qadam <name>` builds one qadam from this tree
// and publishes it straight to npm through `publishNpmPackage` — the same pack-and-publish call
// that CI wraps in its pack (#486, no credential) / publish (credential) split. It stays for two
// reasons. First, it is still referenced: `package.json`'s `publish-qadam` script and
// docs/build-qadams/sharing-qadams/community.mdx, which routes a community author through
// `npm run publish-qadam PIECE_FOLDER_NAME`. Second, there is no replacement for that flow — the
// CLI's `publish-qadam-to-api` targets a platform's API, not npm, and the CI path publishes the
// whole official catalogue through one pack manifest, not one community package. Removing it
// means migrating that doc first; tracked by #787, not deleted here.
import assert from 'node:assert'
import { argv } from 'node:process'
import { exec } from '../utils/exec'
import { readPackageJson } from '../utils/files'
import { findAllQadamsDirectoryInSource } from '../utils/qadam-script-utils'
import { isNil } from '@aiqadam/shared'
import chalk from 'chalk'
import path from 'node:path'
import { publishNpmPackage } from '../utils/publish-npm-package'

export const publishQadam = async (name: string): Promise<void> => {
  assert(name, '[publishQadam] parameter "name" is required')

  const distPaths = await findAllQadamsDirectoryInSource()
  const directory = distPaths.find(p => path.basename(p) === name)
  if (isNil(directory)) {
    console.error(chalk.red(`[publishQadam] can't find the directory with name ${name}`))
    return
  }

  const { name: packageName, version } = await readPackageJson(directory)
  await exec(`turbo run build --filter=${packageName}`)

  await publishNpmPackage({ path: directory })

  console.info(chalk.green.bold(`[publishQadam] success, name=${name}, version=${version}`))
}

const main = async (): Promise<void> => {
  const qadamName = argv[2]
  await publishQadam(qadamName)
}

if (require.main === module) {
  main()
}
