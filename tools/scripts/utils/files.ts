import { readFile } from 'node:fs/promises'

export type PackageJson = {
  name: string
  version: string
  keywords: string[]
}


const readJsonFile = async <T> (path: string): Promise<T> => {
  const jsonFile = await readFile(path, { encoding: 'utf-8' })
  return JSON.parse(jsonFile) as T
}

export const readPackageJson = async (path: string): Promise<PackageJson> => {
  return await readJsonFile(`${path}/package.json`)
}
