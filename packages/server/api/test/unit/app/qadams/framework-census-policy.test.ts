import { ContextVersion, LATEST_CONTEXT_VERSION, PREDATES_CONTEXT_INFO } from '@aiqadam/qadams-framework'
import { FastifyBaseLogger } from 'fastify'
import { frameworkCensusMarking } from '../../../../src/app/qadams/census/framework-census-marking'
import { frameworkCensusPolicy } from '../../../../src/app/qadams/census/framework-census-policy'
import { UNRECOGNISED_CONTEXT_VERSION } from '../../../../src/app/qadams/metadata/qadam-context-version'
import { withEngineContextVersions } from '../../../helpers/framework-census'

describe('frameworkCensusPolicy (#803)', () => {
    it('reports no retirement while the engine runs every context version the table lists', () => {
        expect(frameworkCensusPolicy.hasRetiredContextVersion()).toBe(false)
        expect(frameworkCensusPolicy.retiredContextVersions()).toEqual([])
    })

    it('reports the context versions the table lists but the engine no longer runs', async () => {
        await withEngineContextVersions({
            contextVersions: [LATEST_CONTEXT_VERSION],
            run: () => {
                expect(frameworkCensusPolicy.hasRetiredContextVersion()).toBe(true)
                expect(frameworkCensusPolicy.retiredContextVersions()).toEqual([PREDATES_CONTEXT_INFO, ContextVersion.V1])
            },
        })
    })

    it('maps a stored context version, NONE and UNRECOGNISED to the table vocabulary', () => {
        expect(frameworkCensusPolicy.fromStoredContextVersion({ value: ContextVersion.V2 })).toBe(ContextVersion.V2)
        expect(frameworkCensusPolicy.fromStoredContextVersion({ value: ContextVersion.V1 })).toBe(ContextVersion.V1)
        expect(frameworkCensusPolicy.fromStoredContextVersion({ value: 'NONE' })).toBe(PREDATES_CONTEXT_INFO)
        // A measurement of something no shim here matches is unknown, like a row never measured.
        expect(frameworkCensusPolicy.fromStoredContextVersion({ value: UNRECOGNISED_CONTEXT_VERSION })).toBeNull()
        expect(frameworkCensusPolicy.fromStoredContextVersion({ value: null })).toBeNull()
    })

    it('treats an unknown context version as legacy before the retirement and unsupported after it', async () => {
        expect(frameworkCensusPolicy.statusOf({ contextVersion: null })).toBe('legacy')
        await withEngineContextVersions({
            contextVersions: [LATEST_CONTEXT_VERSION],
            run: () => {
                expect(frameworkCensusPolicy.statusOf({ contextVersion: null })).toBe('unsupported')
            },
        })
    })

    it('classifies known context versions by whether this release runs them', async () => {
        expect(frameworkCensusPolicy.statusOf({ contextVersion: LATEST_CONTEXT_VERSION })).toBe('current')
        expect(frameworkCensusPolicy.statusOf({ contextVersion: ContextVersion.V1 })).toBe('legacy')
        expect(frameworkCensusPolicy.statusOf({ contextVersion: PREDATES_CONTEXT_INFO })).toBe('legacy')

        await withEngineContextVersions({
            contextVersions: [LATEST_CONTEXT_VERSION],
            run: () => {
                expect(frameworkCensusPolicy.statusOf({ contextVersion: ContextVersion.V1 })).toBe('unsupported')
                expect(frameworkCensusPolicy.statusOf({ contextVersion: PREDATES_CONTEXT_INFO })).toBe('unsupported')
            },
        })
    })

    it('maps an official framework major through the support table, V2 for the pre-1.0 row', () => {
        expect(frameworkCensusPolicy.contextOfOfficialMajor({ major: 0 })).toBe(ContextVersion.V2)
        expect(frameworkCensusPolicy.contextOfOfficialMajor({ major: 99 })).toBeNull()
    })

    it('logs a boot warning only once a context version is retired', async () => {
        const log = { warn: vi.fn() } as unknown as FastifyBaseLogger
        frameworkCensusMarking(log).logRetirement()
        expect(log.warn).not.toHaveBeenCalled()

        await withEngineContextVersions({
            contextVersions: [LATEST_CONTEXT_VERSION],
            run: () => {
                frameworkCensusMarking(log).logRetirement()
                expect(log.warn).toHaveBeenCalledTimes(1)
            },
        })
    })
})
