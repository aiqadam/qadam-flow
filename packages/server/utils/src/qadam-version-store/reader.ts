// The engine's entry into the qadam version store (#779): the reader and the layout, never the
// writer, the seed or tarball extraction. The engine is one esbuild bundle and takes this file from
// source through `@aiqadam/server-utils/qadam-version-store-reader` (its `esbuild.config.mjs` and
// `vitest.config.ts` alias it, `tsconfig.base.json` maps it). That subpath does not exist at run
// time for any other package, and lint forbids it outside the engine: servers import the root.
export { QadamVersionReadStatus, qadamVersionStoreReader } from './qadam-version-store-read'
export type { QadamVersionReadResult, QadamVersionStoreReader, StoredQadamVersion } from './qadam-version-store-read'
export { PLATFORM_PROVIDED_PACKAGES } from './qadam-version-store-format'
export { QADAM_VERSION_STORE_LAYOUT, qadamVersionStoreLayout } from './qadam-version-store-layout'
export type { QadamVersionCoordinates } from './qadam-version-store-layout'
