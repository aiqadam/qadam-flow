import {
    DATA_TYPE_KEY_IN_FILE_METADATA,
    FlowActionType,
    FlowTriggerType,
    FlowVersion,
    FlowVersionState,
    SampleDataDataType,
    SampleDataFileType,
} from '@aiqadam/shared'
import pino from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetDataOrUndefined } = vi.hoisted(() => ({
    mockGetDataOrUndefined: vi.fn(),
}))

vi.mock('../../../../../src/app/file/file.service', () => ({
    fileRepo: vi.fn(),
    fileService: () => ({
        getDataOrUndefined: mockGetDataOrUndefined,
    }),
}))

// `sample-data.service.ts` imports `flowVersionService` but `getSampleDataForFlow` never calls it —
// mocked only so this unit test never touches a real DB connection through its transitive imports.
vi.mock('../../../../../src/app/flows/flow-version/flow-version.service', () => ({
    flowVersionService: () => ({}),
}))

// #489: `step.name` can be `__proto__` (`STEP_NAME_REGEX` admits it, and it survives
// `ap_import_flow` verbatim). `Object.assign({}, ...sampleDataArray)` walks the prototype chain for
// that key, silently replacing the merged object's own prototype instead of giving it an own
// `__proto__` property — so the step's sample data vanishes from `Object.keys`/`JSON.stringify`
// (and from the queued job that carries it to the engine) even though it is briefly live in memory.
describe('sampleDataService#getSampleDataForFlow — step named __proto__', () => {
    beforeEach(() => {
        mockGetDataOrUndefined.mockReset()
    })

    it('keeps a __proto__-named step as an own, serializable property', async () => {
        mockGetDataOrUndefined.mockImplementation(async ({ fileId }: { fileId: string }) => {
            const payload = fileId === 'file-proto' ? { a: 1 } : { c: 3 }
            return {
                data: Buffer.from(JSON.stringify(payload)),
                metadata: { [DATA_TYPE_KEY_IN_FILE_METADATA]: SampleDataDataType.JSON },
            }
        })

        const flowVersion: FlowVersion = {
            id: 'flowVersionId',
            created: '2024-01-01T00:00:00Z',
            updated: '2024-01-01T00:00:00Z',
            flowId: 'flowId',
            displayName: 'Test Flow',
            trigger: {
                name: '__proto__',
                displayName: 'Trigger',
                type: FlowTriggerType.EMPTY,
                valid: true,
                lastUpdatedDate: '2024-01-01T00:00:00Z',
                settings: { sampleData: { sampleDataFileId: 'file-proto' } },
                nextAction: {
                    name: 'step_1',
                    displayName: 'Step 1',
                    type: FlowActionType.CODE,
                    valid: true,
                    lastUpdatedDate: '2024-01-01T00:00:00Z',
                    settings: {
                        sourceCode: { packageJson: '{}', code: '' },
                        input: {},
                        errorHandlingOptions: undefined,
                        sampleData: { sampleDataFileId: 'file-1' },
                    },
                },
            },
            updatedBy: null,
            valid: true,
            schemaVersion: null,
            agentIds: [],
            state: FlowVersionState.DRAFT,
            connectionIds: [],
            backupFiles: null,
            notes: [],
        }

        const { sampleDataService } = await import('../../../../../src/app/flows/step-run/sample-data.service')
        const result = await sampleDataService(pino({ level: 'silent' })).getSampleDataForFlow(
            'projectId',
            flowVersion,
            SampleDataFileType.OUTPUT,
        )

        expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
        expect(Object.hasOwn(result, '__proto__')).toBe(true)
        expect(result['__proto__']).toEqual({ a: 1 })
        expect(result.step_1).toEqual({ c: 3 })
        expect(JSON.parse(JSON.stringify(result))).toEqual({ ['__proto__']: { a: 1 }, step_1: { c: 3 } })
    })
})
