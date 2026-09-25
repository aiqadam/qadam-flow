import { isNil, LdapAttributeMap } from '@aiqadam/shared'
import { Entry } from 'ldapts'

// Active Directory's `objectGUID` is a raw 16-byte value in "mixed-endian" order: the first three
// components (a 32-bit and two 16-bit integers) are little-endian on the wire, the way every
// Windows GUID API reads and prints them, while the last two components (an 8-byte byte string)
// are big-endian. This reorders the first three groups and prints the canonical
// `XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX` form — the same string `Convert-ObjectGUIDToString` / a
// PowerShell `[GUID]$bytes` cast produces, not a plain hex dump of the raw bytes (which would come
// out byte-reversed in the first three groups and fail to match the GUID an AD admin sees
// anywhere else).
function objectGuidBufferToCanonicalString(buffer: Buffer): string {
    const hex = (start: number, end: number): string => buffer.subarray(start, end).toString('hex')
    const group1 = swapByteOrder(hex(0, 4))
    const group2 = swapByteOrder(hex(4, 6))
    const group3 = swapByteOrder(hex(6, 8))
    const group4 = hex(8, 10)
    const group5 = hex(10, 16)
    return `${group1}-${group2}-${group3}-${group4}-${group5}`
}

function swapByteOrder(hex: string): string {
    const bytes = hex.match(/.{2}/g) ?? []
    return bytes.reverse().join('')
}

function readStringAttribute({ entry, name }: ReadAttributeParams): string | undefined {
    const value = entry[name]
    if (isNil(value)) {
        return undefined
    }
    if (Buffer.isBuffer(value)) {
        return value.toString('utf8')
    }
    if (Array.isArray(value)) {
        const [first] = value
        if (isNil(first)) {
            return undefined
        }
        return Buffer.isBuffer(first) ? first.toString('utf8') : first
    }
    return value
}

function resolveSubject({ entry, attributeMap }: ResolveSubjectParams): string | undefined {
    if (attributeMap.subject === 'objectGUID') {
        const value = entry[attributeMap.subject]
        const buffer = Array.isArray(value) ? value[0] : value
        if (isNil(buffer) || !Buffer.isBuffer(buffer)) {
            return undefined
        }
        return objectGuidBufferToCanonicalString(buffer)
    }
    return readStringAttribute({ entry, name: attributeMap.subject })
}

export const ldapAttributeUtils = {
    objectGuidBufferToCanonicalString,
    readStringAttribute,
    resolveSubject,
}

type ReadAttributeParams = {
    entry: Entry
    name: string
}

type ResolveSubjectParams = {
    entry: Entry
    attributeMap: LdapAttributeMap
}
