import { PropertyType, QadamMetadataModel } from '@aiqadam/qadams-framework'
import {
    ErrorCode,
    FlowActionType,
    FlowOperationRequest,
    FlowOperationType,
    PackageType,
    QadamFlowError,
    QadamType,
    tryCatch,
} from '@aiqadam/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const loadBundledQadams = vi.fn()
const loadRegistry = vi.fn()

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

import { flowVersionValidationUtil } from '../../../../../src/app/flows/flow-version/flow-version-validator-util'
import { qadamMetadataService } from '../../../../../src/app/qadams/metadata/qadam-metadata-service'

const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger

const QADAM_NAME = '@aiqadam/qadam-fixture'
// 0.3.1 is outside `^0.5.x`, so `qadamMetadataService.get()` (which never crosses a 0.x minor)
// answers nothing for it even though 0.5.1 is installed — the state #843 reports.
const UNAVAILABLE_PIN = '0.3.1'
const INSTALLED_VERSION = '0.5.1'

function installedQadam({ version, requiredProp }: { version: string, requiredProp: string }): QadamMetadataModel {
    return {
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
                    [requiredProp]: {
                        type: PropertyType.SHORT_TEXT,
                        required: true,
                        displayName: requiredProp,
                    },
                },
            },
        },
        triggers: {},
        contextInfo: undefined,
        projectUsage: 0,
        qadamType: QadamType.OFFICIAL,
        packageType: PackageType.REGISTRY,
    } as unknown as QadamMetadataModel
}

function updateStepRequest({ qadamVersion, input, displayName }: {
    qadamVersion: string
    input: Record<string, unknown>
    displayName: string
}): FlowOperationRequest {
    return {
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
    } as FlowOperationRequest
}

async function prepare(request: FlowOperationRequest) {
    const prepared = await flowVersionValidationUtil(log).prepareRequest({
        platformId: 'platform-1',
        userId: null,
        request,
    })
    return prepared.request as { valid: boolean, displayName: string, settings: { qadamVersion: string, input: Record<string, unknown> } }
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

    it('accepts a displayName-only edit and leaves the pin untouched', async () => {
        const request = await prepare(updateStepRequest({
            qadamVersion: UNAVAILABLE_PIN,
            displayName: 'Renamed',
            input: { subject: 'hello' },
        }))

        expect(request.displayName).toBe('Renamed')
        expect(request.settings.qadamVersion).toBe(UNAVAILABLE_PIN)
        expect(request.valid).toBe(true)
    })

    it('validates an input edit against the installed version\'s props, keeping the pin', async () => {
        const complete = await prepare(updateStepRequest({
            qadamVersion: UNAVAILABLE_PIN,
            displayName: 'Step',
            input: { subject: 'hello' },
        }))
        const missingRequired = await prepare(updateStepRequest({
            qadamVersion: UNAVAILABLE_PIN,
            displayName: 'Step',
            input: { somethingElse: 'x' },
        }))

        expect(complete.valid).toBe(true)
        expect(missingRequired.valid).toBe(false)
        expect(missingRequired.settings.input.somethingElse).toBe('x')
        expect(missingRequired.settings.qadamVersion).toBe(UNAVAILABLE_PIN)
    })

    it('keeps a caret range on the pin as written by the caller\'s exact-version normalisation, never re-pinning to the installed version', async () => {
        const request = await prepare(updateStepRequest({
            qadamVersion: `^${UNAVAILABLE_PIN}`,
            displayName: 'Step',
            input: { subject: 'hello' },
        }))

        expect(request.settings.qadamVersion).toBe(UNAVAILABLE_PIN)
        expect(request.settings.qadamVersion).not.toBe(INSTALLED_VERSION)
    })

    it('gives an actionable error, not qadam_metadata_not_found, when no version of the qadam is installed', async () => {
        loadBundledQadams.mockResolvedValue([])

        const { error } = await captureError(() => prepare(updateStepRequest({
            qadamVersion: UNAVAILABLE_PIN,
            displayName: 'Renamed',
            input: { subject: 'hello' },
        })))

        expect(error).toBeInstanceOf(QadamFlowError)
        expect(error?.error.code).toBe(ErrorCode.VALIDATION)
        const message = JSON.stringify(error?.error.params)
        expect(message).toContain('qadam_not_installed')
        expect(message).toContain(QADAM_NAME)
        expect(message).toContain(UNAVAILABLE_PIN)
        expect(message).not.toContain('qadam_metadata_not_found')
    })

    it('does not borrow another platform\'s private qadam as the installed version', async () => {
        loadBundledQadams.mockResolvedValue([])
        loadRegistry.mockResolvedValue([{
            name: QADAM_NAME,
            version: INSTALLED_VERSION,
            qadamType: QadamType.CUSTOM,
            platformId: 'another-platform',
        }])

        const { error } = await captureError(() => prepare(updateStepRequest({
            qadamVersion: UNAVAILABLE_PIN,
            displayName: 'Step',
            input: { subject: 'hello' },
        })))

        expect(error?.error.code).toBe(ErrorCode.VALIDATION)
    })

    it('behaviour for an available pin is unchanged: it validates against the pinned metadata', async () => {
        const request = await prepare(updateStepRequest({
            qadamVersion: INSTALLED_VERSION,
            displayName: 'Step',
            input: { somethingElse: 'x' },
        }))

        expect(request.settings.qadamVersion).toBe(INSTALLED_VERSION)
        expect(request.valid).toBe(false)
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
        const { error } = await captureError(() => qadamMetadataService(log).getOrThrow({ name: QADAM_NAME, version: UNAVAILABLE_PIN }))

        expect(error?.error.code).toBe(ErrorCode.ENTITY_NOT_FOUND)
        expect(JSON.stringify(error?.error.params)).toContain('qadam_metadata_not_found')
    })

    it('answers the installed version for an opted-in lookup', async () => {
        const qadam = await qadamMetadataService(log).getOrThrow({ name: QADAM_NAME, version: UNAVAILABLE_PIN, fallbackToInstalledVersion: true })

        expect(qadam.version).toBe(INSTALLED_VERSION)
    })
})

async function captureError(fn: () => Promise<unknown>): Promise<{ error: QadamFlowError | undefined }> {
    const { error } = await tryCatch(fn)
    return { error: error instanceof QadamFlowError ? error : undefined }
}
