import { ContextVersion } from '@aiqadam/qadams-framework'
import { describe, expect, it } from 'vitest'
import { NO_CONTEXT_INFO, qadamContextVersion } from '../../../../src/app/qadams/metadata/qadam-context-version'

describe('qadamContextVersion.fromContextInfo (#802)', () => {
    it.each([
        [{ version: ContextVersion.V2 }, ContextVersion.V2],
        [{ version: ContextVersion.V1 }, ContextVersion.V1],
    ])('stores the version a qadam reports: %j', (contextInfo, expected) => {
        expect(qadamContextVersion.fromContextInfo(contextInfo)).toBe(expected)
    })

    // What the executor runs through the oldest shim: `getContextInfo` absent (the key is dropped
    // on the way from the engine), or present and reporting no version.
    it.each([
        [undefined],
        [{}],
        [{ version: undefined }],
    ])('stores NONE for a qadam that reports no context version: %j', (contextInfo) => {
        expect(qadamContextVersion.fromContextInfo(contextInfo)).toBe(NO_CONTEXT_INFO)
    })

    // Anything that does not name a shim this server has is unknown, never a guess.
    it.each([
        [null],
        ['2'],
        [{ version: '3' }],
        [{ version: 2 }],
        [{ version: null }],
    ])('stores unknown (null) for an unrecognised context info: %j', (contextInfo) => {
        expect(qadamContextVersion.fromContextInfo(contextInfo)).toBeNull()
    })
})
