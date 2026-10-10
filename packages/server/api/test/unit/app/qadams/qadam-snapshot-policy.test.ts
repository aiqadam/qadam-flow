import { describe, expect, it } from 'vitest'
import { qadamSnapshotPolicy } from '../../../../src/app/qadams/pin-moves/qadam-snapshot-policy'

describe('qadamSnapshotPolicy.resolveDefault', () => {
    it('follows a `-main.<n>` build and pins a release', () => {
        expect(qadamSnapshotPolicy.resolveDefault({ version: '1.1.0-main.42' })).toBe('follow')
        expect(qadamSnapshotPolicy.resolveDefault({ version: '1.1.0' })).toBe('pin')
    })

    it('pins an unreadable version: it is not a `-main` build', () => {
        for (const version of ['0.0.0', '', 'not-a-version', '1.1.0-beta.1', '1.2.0 trailing']) {
            expect(qadamSnapshotPolicy.resolveDefault({ version })).toBe('pin')
        }
    })
})

describe('qadamSnapshotPolicy.isFollow', () => {
    it('follows only the exact `follow` value', () => {
        expect(qadamSnapshotPolicy.isFollow({ value: 'follow' })).toBe(true)
        for (const value of ['pin', 'FOLLOW', '', undefined]) {
            expect(qadamSnapshotPolicy.isFollow({ value })).toBe(false)
        }
    })
})
