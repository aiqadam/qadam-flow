import semverMajor from 'semver/functions/major'
import semverMinor from 'semver/functions/minor'
import semverMinVersion from 'semver/ranges/min-version'

export const getQadamMajorAndMinorVersion = (qadamVersion: string): string => {
    const minimumSemver = semverMinVersion(qadamVersion)
    return minimumSemver
        ? `${semverMajor(minimumSemver)}.${semverMinor(minimumSemver)}`
        : `${semverMajor(qadamVersion)}.${semverMinor(qadamVersion)}`
}
