// Read directly from process.env, the same way ap-version.ts reads package.json: this is
// build provenance, not an operator-configurable setting, so it deliberately sits outside
// AppSystemProp/environmentMigrations (no AP_ prefix, no QF_ rename, no startup validator
// entry). The Dockerfile's `run` stage bakes these in unconditionally, so a plain local
// `docker build` with no --build-arg produces an empty string rather than an absent
// variable — callers must treat '' the same as unset.
export const buildInfoUtil = {
    getCommitSha(): string | undefined {
        return process.env['COMMIT_SHA'] || undefined
    },
    getBuildTimestamp(): string | undefined {
        return process.env['BUILD_TIMESTAMP'] || undefined
    },
}
