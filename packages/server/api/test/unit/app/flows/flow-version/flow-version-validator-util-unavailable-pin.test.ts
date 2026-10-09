import { PropertyType, QadamMetadataModel } from '@aiqadam/qadams-framework'
import {
    ErrorCode,
    FlowActionType,
    FlowOperationRequest,
    FlowOperationType,
    FlowTrigger,
    FlowTriggerType,
    FlowVersion,
    PackageType,
    QadamFlowError,
    QadamType,
    TriggerStrategy,
    TriggerTestStrategy,
    tryCatch,
} from '@aiqadam/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const loadBundledQadams = vi.fn()
const loadRegistry = vi.fn()
const findOneQadamRow = vi.fn()

vi.mock('../../../../../src/app/qadams/metadata/utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../../src/app/qadams/metadata/utils')>()
    return {
        ...actual,
        loadBundledQadams: (...args: unknown[]) => loadBundledQadams(...args),
    }
})

vi.mock('../../../../../src/app/qadams/metadata/qadam-cache', () => ({
    qadamCache: () => ({
        setup: async () => undefined,
        loadRegistry: (...args: unknown[]) => loadRegistry(...args),
        invalidate: async () => undefined,
    }),
}))

vi.mock('../../../../../src/app/core/db/repo-factory', () => ({
    repoFactory: () => () => ({ findOne: (...args: unknown[]) => findOneQadamRow(...args) }),
}))

import { flowVersionValidationUtil } from '../../../../../src/app/flows/flow-version/flow-version-validator-util'
import { qadamMetadataService } from '../../../../../src/app/qadams/metadata/qadam-metadata-service'
import { createMockFlowVersion } from '../../../../helpers/mocks'

const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger

const QADAM_NAME = '@aiqadam/qadam-fixture'
// 0.3.1 is outside `^0.5.x`, so `qadamMetadataService.get()` (which never crosses a 0.x minor)
// answers nothing for it even though 0.5.1 is installed — the state #843 reports.
const UNAVAILABLE_PIN = '0.3.1'
const INSTALLED_VERSION = '0.5.1'
const PLATFORM_ID = 'platform-1'

function installedQadam({ version, requiredProp }: { version: string, requiredProp: string }) {
    const parsed = QadamMetadataModel.parse({
        name: QADAM_NAME,
        displayName: QADAM_NAME,
        logoUrl: '',
        description: '',
        authors: [],
        version,
        actions: {
            do_thing: {
                name: 'do_thing',
                displayName: 'Do thing',
                description: '',
                requireAuth: false,
                props: {
                    [requiredProp]: { type: PropertyType.SHORT_TEXT, required: true, displayName: requiredProp },
                },
            },
        },
        triggers: {
            on_thing: {
                name: 'on_thing',
                displayName: 'On thing',
                description: '',
                requireAuth: false,
                type: TriggerStrategy.POLLING,
                testStrategy: TriggerTestStrategy.TEST_FUNCTION,
                sampleData: {},
                props: {
                    [requiredProp]: { type: PropertyType.SHORT_TEXT, required: true, displayName: requiredProp },
                },
            },
        },
        projectUsage: 0,
        qadamType: QadamType.OFFICIAL,
        packageType: PackageType.REGISTRY,
    })
    return { ...parsed, contextInfo: undefined }
}

function storedFlowVersion({ qadamVersion }: { qadamVersion: string }): FlowVersion {
    const action = {
        name: 'step_1',
        displayName: 'Do thing',
        valid: true,
        type: FlowActionType.PIECE,
        settings: {
            qadamName: QADAM_NAME,
            qadamVersion,
            actionName: 'do_thing',
            input: { subject: 'hello' },
            propertySettings: {},
        },
    }
    const trigger = FlowTrigger.parse({
        name: 'trigger',
        displayName: 'On thing',
        valid: true,
        lastUpdatedDate: '2026-10-01T00:00:00.000Z',
        type: FlowTriggerType.PIECE,
        settings: {
            qadamName: QADAM_NAME,
            qadamVersion,
            triggerName: 'on_thing',
            input: { subject: 'hello' },
            propertySettings: {},
        },
        nextAction: action,
    })
    return createMockFlowVersion({ trigger })
}

function updateActionRequest({ qadamVersion, input, displayName }: {
    qadamVersion: string
    input: Record<string, unknown>
    displayName: string
}): FlowOperationRequest {
    return FlowOperationRequest.parse({
        type: FlowOperationType.UPDATE_ACTION,
        request: {
            type: FlowActionType.PIECE,
            name: 'step_1',
            displayName,
            valid: true,
            settings: {
                qadamName: QADAM_NAME,
                qadamVersion,
                actionName: 'do_thing',
                input,
                propertySettings: {},
                errorHandlingOptions: {
                    continueOnFailure: { value: false },
                    retryOnFailure: { value: false },
                },
            },
        },
    })
}

function addActionRequest({ qadamVersion }: { qadamVersion: string }): FlowOperationRequest {
    return FlowOperationRequest.parse({
        type: FlowOperationType.ADD_ACTION,
        request: {
            parentStep: 'trigger',
            stepLocationRelativeToParent: 'AFTER',
            action: {
                type: FlowActionType.PIECE,
                name: 'step_2',
                displayName: 'New step',
                valid: true,
                settings: {
                    qadamName: QADAM_NAME,
                    qadamVersion,
                    actionName: 'do_thing',
                    input: { subject: 'hello' },
                    propertySettings: {},
                },
            },
        },
    })
}

function updateTriggerRequest({ qadamVersion }: { qadamVersion: string }): FlowOperationRequest {
    return FlowOperationRequest.parse({
        type: FlowOperationType.UPDATE_TRIGGER,
        request: {
            type: FlowTriggerType.PIECE,
            name: 'trigger',
            displayName: 'On thing',
            valid: true,
            lastUpdatedDate: '2026-10-01T00:00:00.000Z',
            settings: {
                qadamName: QADAM_NAME,
                qadamVersion,
                triggerName: 'on_thing',
                input: { subject: 'hello' },
                propertySettings: {},
            },
        },
    })
}

async function prepare({ request, storedVersion }: { request: FlowOperationRequest, storedVersion?: string }): Promise<FlowOperationRequest> {
    return flowVersionValidationUtil(log).prepareRequest({
        platformId: PLATFORM_ID,
        userId: null,
        request,
        storedFlowVersion: storedVersion === undefined ? undefined : storedFlowVersion({ qadamVersion: storedVersion }),
    })
}

function readUpdatedAction(prepared: FlowOperationRequest): { valid: boolean, displayName: string, qadamVersion: string, input: Record<string, unknown> | undefined } {
    if (prepared.type !== FlowOperationType.UPDATE_ACTION || prepared.request.type !== FlowActionType.PIECE) {
        throw new Error('expected a PIECE UPDATE_ACTION')
    }
    const { valid, displayName, settings } = prepared.request
    return { valid, displayName, qadamVersion: settings.qadamVersion, input: settings.input }
}

function readUpdatedTrigger(prepared: FlowOperationRequest): { valid: boolean, qadamVersion: string } {
    if (prepared.type !== FlowOperationType.UPDATE_TRIGGER || prepared.request.type !== FlowTriggerType.PIECE) {
        throw new Error('expected a PIECE UPDATE_TRIGGER')
    }
    return { valid: prepared.request.valid, qadamVersion: prepared.request.settings.qadamVersion }
}

async function captureError(fn: () => Promise<unknown>): Promise<QadamFlowError | undefined> {
    const { error } = await tryCatch(fn)
    return error instanceof QadamFlowError ? error : undefined
}

describe('flowVersionValidationUtil.prepareRequest — step pinned to an unavailable qadam version (#843)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        loadRegistry.mockResolvedValue([])
        loadBundledQadams.mockResolvedValue([installedQadam({ version: INSTALLED_VERSION, requiredProp: 'subject' })])
    })

    it('control: the pin is unresolvable through get(), which is what made every edit fail', async () => {
        const resolved = await qadamMetadataService(log).get({ name: QADAM_NAME, version: UNAVAILABLE_PIN })

        expect(resolved).toBeUndefined()
    })

    describe('an UPDATE_ACTION that keeps the step\'s stored pin', () => {
        it('accepts a displayName-only edit and leaves the pin untouched', async () => {
            const prepared = await prepare({
                storedVersion: UNAVAILABLE_PIN,
                request: updateActionRequest({ qadamVersion: UNAVAILABLE_PIN, displayName: 'Renamed', input: { subject: 'hello' } }),
            })

            const action = readUpdatedAction(prepared)
            expect(action.displayName).toBe('Renamed')
            expect(action.qadamVersion).toBe(UNAVAILABLE_PIN)
            expect(action.valid).toBe(true)
        })

        it('validates an input edit against the installed version\'s props, keeping the pin', async () => {
            const complete = readUpdatedAction(await prepare({
                storedVersion: UNAVAILABLE_PIN,
                request: updateActionRequest({ qadamVersion: UNAVAILABLE_PIN, displayName: 'Step', input: { subject: 'hello' } }),
            }))
            const missingRequired = readUpdatedAction(await prepare({
                storedVersion: UNAVAILABLE_PIN,
                request: updateActionRequest({ qadamVersion: UNAVAILABLE_PIN, displayName: 'Step', input: { somethingElse: 'x' } }),
            }))

            expect(complete.valid).toBe(true)
            expect(missingRequired.valid).toBe(false)
            expect(missingRequired.input?.somethingElse).toBe('x')
            expect(missingRequired.qadamVersion).toBe(UNAVAILABLE_PIN)
        })

        it('strips a caret from the request\'s pin as it always did, and never re-pins to the installed version', async () => {
            const action = readUpdatedAction(await prepare({
                storedVersion: UNAVAILABLE_PIN,
                request: updateActionRequest({ qadamVersion: `^${UNAVAILABLE_PIN}`, displayName: 'Step', input: { subject: 'hello' } }),
            }))

            expect(action.qadamVersion).toBe(UNAVAILABLE_PIN)
        })

        it('picks the highest installed version from the persisted registry path, for the caller\'s platform only', async () => {
            loadBundledQadams.mockResolvedValue([])
            loadRegistry.mockResolvedValue([
                { name: QADAM_NAME, version: '0.4.0', qadamType: QadamType.CUSTOM, platformId: PLATFORM_ID },
                { name: QADAM_NAME, version: '0.6.0', qadamType: QadamType.CUSTOM, platformId: PLATFORM_ID },
                { name: QADAM_NAME, version: '9.0.0', qadamType: QadamType.CUSTOM, platformId: 'another-platform' },
            ])
            findOneQadamRow.mockResolvedValue(installedQadam({ version: '0.6.0', requiredProp: 'subject' }))

            const action = readUpdatedAction(await prepare({
                storedVersion: '0.1.0',
                request: updateActionRequest({ qadamVersion: '0.1.0', displayName: 'Step', input: { subject: 'hello' } }),
            }))

            expect(findOneQadamRow).toHaveBeenCalledWith({ where: { name: QADAM_NAME, version: '0.6.0', platformId: PLATFORM_ID } })
            expect(action.valid).toBe(true)
            expect(action.qadamVersion).toBe('0.1.0')
        })

        it('documents the cross-major case: it validates against whatever is installed (3.0.0 for a 0.0.1 pin), pin unchanged', async () => {
            loadBundledQadams.mockResolvedValue([installedQadam({ version: '3.0.0', requiredProp: 'recipient' })])

            const withOldProps = readUpdatedAction(await prepare({
                storedVersion: '0.0.1',
                request: updateActionRequest({ qadamVersion: '0.0.1', displayName: 'Step', input: { subject: 'hello' } }),
            }))
            const withInstalledProps = readUpdatedAction(await prepare({
                storedVersion: '0.0.1',
                request: updateActionRequest({ qadamVersion: '0.0.1', displayName: 'Step', input: { recipient: 'a' } }),
            }))

            expect(withOldProps.valid).toBe(false)
            expect(withInstalledProps.valid).toBe(true)
            expect(withInstalledProps.qadamVersion).toBe('0.0.1')
        })

        it('gives an actionable error, not qadam_metadata_not_found, when no version of the qadam is installed', async () => {
            loadBundledQadams.mockResolvedValue([])

            const error = await captureError(() => prepare({
                storedVersion: UNAVAILABLE_PIN,
                request: updateActionRequest({ qadamVersion: UNAVAILABLE_PIN, displayName: 'Renamed', input: { subject: 'hello' } }),
            }))

            expect(error?.error.code).toBe(ErrorCode.VALIDATION)
            const params = JSON.stringify(error?.error.params)
            expect(params).toContain('qadam_not_installed')
            expect(params).toContain(QADAM_NAME)
            expect(params).toContain(UNAVAILABLE_PIN)
            expect(params).not.toContain('qadam_metadata_not_found')
        })

        it('does not borrow another platform\'s private qadam as the installed version', async () => {
            loadBundledQadams.mockResolvedValue([])
            loadRegistry.mockResolvedValue([
                { name: QADAM_NAME, version: INSTALLED_VERSION, qadamType: QadamType.CUSTOM, platformId: 'another-platform' },
            ])

            const error = await captureError(() => prepare({
                storedVersion: UNAVAILABLE_PIN,
                request: updateActionRequest({ qadamVersion: UNAVAILABLE_PIN, displayName: 'Step', input: { subject: 'hello' } }),
            }))

            expect(error?.error.code).toBe(ErrorCode.VALIDATION)
            expect(findOneQadamRow).not.toHaveBeenCalled()
        })
    })

    describe('an operation that sets a pin stays strict', () => {
        it('refuses an UPDATE_ACTION that repoints the step to a version that is not installed', async () => {
            const error = await captureError(() => prepare({
                storedVersion: UNAVAILABLE_PIN,
                request: updateActionRequest({ qadamVersion: '9.9.9', displayName: 'Step', input: { subject: 'hello' } }),
            }))

            expect(error?.error.code).toBe(ErrorCode.ENTITY_NOT_FOUND)
            expect(JSON.stringify(error?.error.params)).toContain('qadam_metadata_not_found')
        })

        it('refuses an UPDATE_ACTION that moves the pin to another unavailable version', async () => {
            const error = await captureError(() => prepare({
                storedVersion: UNAVAILABLE_PIN,
                request: updateActionRequest({ qadamVersion: '0.2.0', displayName: 'Step', input: { subject: 'hello' } }),
            }))

            expect(error?.error.code).toBe(ErrorCode.ENTITY_NOT_FOUND)
        })

        it('refuses an ADD_ACTION with a version that is not installed', async () => {
            const unknownVersion = await captureError(() => prepare({ storedVersion: UNAVAILABLE_PIN, request: addActionRequest({ qadamVersion: '9.9.9' }) }))
            const sameAsAnotherStepsPin = await captureError(() => prepare({ storedVersion: UNAVAILABLE_PIN, request: addActionRequest({ qadamVersion: UNAVAILABLE_PIN }) }))

            expect(unknownVersion?.error.code).toBe(ErrorCode.ENTITY_NOT_FOUND)
            expect(sameAsAnotherStepsPin?.error.code).toBe(ErrorCode.ENTITY_NOT_FOUND)
        })

        it('stays strict when the caller did not pass the stored flow version', async () => {
            const error = await captureError(() => prepare({
                request: updateActionRequest({ qadamVersion: UNAVAILABLE_PIN, displayName: 'Step', input: { subject: 'hello' } }),
            }))

            expect(error?.error.code).toBe(ErrorCode.ENTITY_NOT_FOUND)
        })
    })

    describe('UPDATE_TRIGGER', () => {
        it('accepts an edit that keeps the trigger\'s stored pin', async () => {
            const trigger = readUpdatedTrigger(await prepare({
                storedVersion: UNAVAILABLE_PIN,
                request: updateTriggerRequest({ qadamVersion: UNAVAILABLE_PIN }),
            }))

            expect(trigger.valid).toBe(true)
            expect(trigger.qadamVersion).toBe(UNAVAILABLE_PIN)
        })

        it('refuses an edit that repoints the trigger to a version that is not installed', async () => {
            const error = await captureError(() => prepare({
                storedVersion: UNAVAILABLE_PIN,
                request: updateTriggerRequest({ qadamVersion: '9.9.9' }),
            }))

            expect(error?.error.code).toBe(ErrorCode.ENTITY_NOT_FOUND)
        })
    })

    it('behaviour for an available pin is unchanged: it validates against the pinned metadata and logs no fallback', async () => {
        const action = readUpdatedAction(await prepare({
            storedVersion: INSTALLED_VERSION,
            request: updateActionRequest({ qadamVersion: INSTALLED_VERSION, displayName: 'Step', input: { somethingElse: 'x' } }),
        }))

        expect(action.qadamVersion).toBe(INSTALLED_VERSION)
        expect(action.valid).toBe(false)
        expect(log.warn).not.toHaveBeenCalledWith(
            expect.objectContaining({ pinnedVersion: INSTALLED_VERSION }),
            expect.stringContaining('pinned qadam version unavailable'),
        )
    })
})

describe('qadamMetadataService.getOrThrow — default lookup is unchanged', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        loadRegistry.mockResolvedValue([])
        loadBundledQadams.mockResolvedValue([installedQadam({ version: INSTALLED_VERSION, requiredProp: 'subject' })])
    })

    it('still throws ENTITY_NOT_FOUND for an unavailable pin unless the caller opts in', async () => {
        const error = await captureError(() => qadamMetadataService(log).getOrThrow({ name: QADAM_NAME, version: UNAVAILABLE_PIN }))

        expect(error?.error.code).toBe(ErrorCode.ENTITY_NOT_FOUND)
        expect(JSON.stringify(error?.error.params)).toContain('qadam_metadata_not_found')
    })

    it('answers the installed version for an opted-in lookup', async () => {
        const qadam = await qadamMetadataService(log).getOrThrow({ name: QADAM_NAME, version: UNAVAILABLE_PIN, fallbackToInstalledVersion: true })

        expect(qadam.version).toBe(INSTALLED_VERSION)
    })
})
