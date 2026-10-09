// The qadam version store on its own, for the engine (#779). The engine is one esbuild bundle and
// takes this entry from source (its `esbuild.config.mjs` and `vitest.config.ts` alias it), so it
// carries the store's reader without the rest of server-utils. Servers import the package root.
export { DEFAULT_QADAM_VERSION_STORE_LIMITS, QadamVersionOrigin, QadamVersionPutStatus, QadamVersionReadStatus, qadamVersionStore } from './qadam-version-store'
export type { QadamVersionReadResult, QadamVersionStore, QadamVersionStoreLogger, QadamVersionStoreReader, StoredQadamVersion } from './qadam-version-store'
export { PLATFORM_PROVIDED_PACKAGES, QadamArtifactFormat, QadamArtifactKind } from './qadam-version-store-format'
export { QADAM_VERSION_STORE_LAYOUT, qadamVersionStoreLayout } from './qadam-version-store-layout'
export type { QadamVersionCoordinates } from './qadam-version-store-layout'
