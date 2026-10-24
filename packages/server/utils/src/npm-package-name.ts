// npm's own limit on a package name. It lives in `shared` with the name grammar so the request
// schemas and the API/worker code use one number (#879); the limit alone does not keep a path
// segment short: see the worker's `qadamCache` and `qadamInstaller`.
export { NPM_PACKAGE_NAME_MAX_LENGTH } from '@aiqadam/shared'
