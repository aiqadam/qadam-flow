import { readPackageJson } from '../utils/files'
import { findAllQadamsDirectoryInSource, NON_QADAM_PACKAGES, AP_CLOUD_API_BASE } from '../utils/qadam-script-utils'

const main = async () => {
  const release = (await readPackageJson('.')).version
  console.info(`[findChangedQadams] release=${release}`)

  const registry = await fetchRegistry(release)
  console.info(`[findChangedQadams] registry has ${registry.size} name@version entries`)

  const allQadamDirs = await findAllQadamsDirectoryInSource()
  const changedDirs: string[] = []
  const turboFilters: string[] = []

  for (const dir of allQadamDirs) {
    const pkg = await readPackageJson(dir)
    if (NON_QADAM_PACKAGES.includes(pkg.name)) {
      continue
    }
    const key = `${pkg.name}@${pkg.version}`
    if (!registry.has(key)) {
      changedDirs.push(dir)
      turboFilters.push(`--filter=${pkg.name}`)
      console.info(`[findChangedQadams] changed: ${key} (${dir})`)
    }
  }

  console.info(`[findChangedQadams] ${changedDirs.length} qadams not on cloud`)

  const output = {
    count: changedDirs.length,
    dirs: changedDirs,
    turboFilter: turboFilters.join(' '),
  }
  console.log(`::set-output-json::${JSON.stringify(output)}`)
  if (changedDirs.length > 0) {
    console.log(`CHANGED_DIRS:\n${changedDirs.join('\n')}`)
    console.log(`TURBO_FILTER:${turboFilters.join(' ')}`)
  }
}

async function fetchRegistry(release: string): Promise<Set<string>> {
  const url = `${AP_CLOUD_API_BASE}/qadams/registry?release=${release}&edition=ee`
  console.info(`[fetchRegistry] fetching ${url}`)
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch registry: ${response.status} ${response.statusText}`)
  }
  const entries: RegistryEntry[] = await response.json()
  const set = new Set<string>()
  for (const entry of entries) {
    set.add(`${entry.name}@${entry.version}`)
  }
  return set
}

main()

type RegistryEntry = {
  name: string
  version: string
}
