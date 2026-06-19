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

  await publishNpmPackage(directory)

  console.info(chalk.green.bold(`[publishQadam] success, name=${name}, version=${version}`))
}

const main = async (): Promise<void> => {
  const qadamName = argv[2]
  await publishQadam(qadamName)
}

if (require.main === module) {
  main()
}
