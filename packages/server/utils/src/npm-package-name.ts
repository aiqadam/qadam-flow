// npm's own limit on a package name. `NPM_PACKAGE_NAME_REGEX` in shared has no length bound, so
// whoever builds a path or a message from a name that a flow author typed checks this as well (#779).
// The limit alone does not keep a path segment short: see the worker's `qadamCache`.
export const NPM_PACKAGE_NAME_MAX_LENGTH = 214
