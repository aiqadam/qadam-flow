import { ApFile, Property, TriggerStrategy } from '@aiqadam/qadams-framework'
import { FlowTriggerType, FlowVersionState, TriggerHookType } from '@aiqadam/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { triggerHelper } from '../../src/lib/helper/trigger-helper'
import { generateMockEngineConstants } from '../handler/test-helper'

const state = vi.hoisted(() => ({
    props: vi.fn(),
    run: vi.fn(),
}))

vi.mock('../../src/lib/helper/qadam-loader', () => ({
    qadamLoader: {
        getQadamAndTriggerOrThrow: async () => ({
            qadam: { auth: undefined },
            qadamTrigger: {
                type: TriggerStrategy.POLLING,
                requireAuth: false,
                props: {
                    media: Property.DynamicProperties({
                        auth: undefined,
                        displayName: 'Media',
                        required: false,
                        refreshers: [],
                        props: state.props,
                    }),
                },
                run: state.run,
            },
        }),
    },
}))

// #388, trigger side: `prepareTriggerExecution` runs the same propsProcessor as actions, so a
// trigger saved without a stored schema must get its DYNAMIC sub-fields processed too.
describe('triggerHelper.executeTrigger — DYNAMIC props without a stored schema', () => {
    afterEach(() => {
        vi.clearAllMocks()
    })

    it('computes the schema with the trigger\'s property context and resolves a nested FILE', async () => {
        state.props.mockResolvedValue({ photo: Property.File({ displayName: 'Photo', required: true }) })
        state.run.mockImplementation(async (ctx: { propsValue: unknown }) => [ctx.propsValue])
        const constants = generateMockEngineConstants()

        const result = await triggerHelper.executeTrigger({
            params: buildRunParams({ media: { photo: 'data:image/png;base64,aGVsbG8=' } }),
            constants,
        })

        expect(result).toEqual({
            output: [{ media: { photo: new ApFile('unknown.png', Buffer.from('hello'), 'png') } }],
        })
        expect(state.props).toHaveBeenCalledTimes(1)
        const ctx = state.props.mock.calls[0][1]
        expect(ctx.server).toEqual({ token: constants.engineToken, apiUrl: constants.internalApiUrl, publicUrl: constants.publicApiUrl })
        expect(ctx.project.id).toBe(constants.projectId)
        expect(ctx.step).toEqual({ name: 'new_item' })
    })

    it('fails with the props validation errors when a nested value is invalid', async () => {
        state.props.mockResolvedValue({ photo: Property.File({ displayName: 'Photo', required: true }) })

        await expect(triggerHelper.executeTrigger({
            params: buildRunParams({ media: { photo: { url: 'https://example.com/a.png' } } }),
            constants: generateMockEngineConstants(),
        })).rejects.toThrow(/Expected a file as an http\(s\) URL or a data:<mime>;base64,<data> URI/)
        expect(state.run).not.toHaveBeenCalled()
    })
})

function buildRunParams(input: Record<string, unknown>) {
    return {
        hookType: TriggerHookType.RUN,
        test: false,
        projectId: 'projectId',
        engineToken: 'engineToken',
        publicApiUrl: 'http://127.0.0.1:4200/api/',
        internalApiUrl: 'http://127.0.0.1:3000/',
        platformId: 'platformId',
        timeoutInSeconds: 10,
        triggerPayload: {},
        flowVersion: {
            id: 'flowVersionId',
            flowId: 'flowId',
            state: FlowVersionState.DRAFT,
            trigger: {
                name: 'trigger',
                type: FlowTriggerType.PIECE,
                valid: true,
                displayName: 'Trigger',
                settings: {
                    qadamName: '@aiqadam/qadam-test',
                    qadamVersion: '0.0.1',
                    triggerName: 'new_item',
                    input,
                    propertySettings: {},
                },
            },
        },
    }
}
