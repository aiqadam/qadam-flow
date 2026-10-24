import { getPackageAliasForQadam } from '@aiqadam/shared'

// One path segment is at most 255 bytes on the filesystems a worker runs on. A qadam's install
// workspace member is `qadams/<name>@<version>`; `/` inside a scoped name starts a new segment,
// so each segment is measured on its own (the scope is its own directory) (#879).
const MAX_QADAM_MEMBER_SEGMENT_BYTES = 255

export const qadamMemberSegmentFits = ({ qadamName, qadamVersion }: {
    qadamName: string
    qadamVersion: string
}): boolean => {
    return getPackageAliasForQadam({ qadamName, qadamVersion })
        .split('/')
        .every((segment) => Buffer.byteLength(segment) <= MAX_QADAM_MEMBER_SEGMENT_BYTES)
}
