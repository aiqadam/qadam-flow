import { describe, expect, it } from 'vitest'
import { createAction } from '../../src/lib/action/action'
import { ActionBase } from '../../src/lib/qadam-metadata'

function action(extra: Record<string, unknown>) {
    return createAction({
        name: 'demo',
        displayName: 'Demo',
        description: 'fixture',
        props: {},
        async run() {
            return {}
        },
        ...extra,
    })
}

// The marker is what `ap_validate_flow` reads to tell an author an inline subflow cannot run this
// step (#426); it has to survive `createAction` and the metadata schema unchanged, and stay absent
// when the author did not declare it — absence is how the API knows to fall back to its frozen
// pre-marker table for older pins.
describe('createAction — pauses marker', () => {
    it('carries `true` and `conditional` through to the action and its metadata', () => {
        expect(action({ pauses: true }).pauses).toBe(true)
        expect(action({ pauses: 'conditional' }).pauses).toBe('conditional')
        expect(ActionBase.parse({ ...action({ pauses: 'conditional' }) }).pauses).toBe('conditional')
    })

    it('leaves the marker undefined when the action does not declare it', () => {
        expect(action({}).pauses).toBeUndefined()
        expect(ActionBase.parse({ ...action({}) }).pauses).toBeUndefined()
    })

    it('rejects any other value in the metadata schema', () => {
        expect(ActionBase.safeParse({ ...action({}), pauses: false }).success).toBe(false)
        expect(ActionBase.safeParse({ ...action({}), pauses: 'always' }).success).toBe(false)
    })
})
