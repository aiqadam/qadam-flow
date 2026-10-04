import { ApplicationEventName } from '@aiqadam/shared'
import type { Mock } from 'vitest'

export function actionsEmitted(spy: Mock): ApplicationEventName[] {
    return spy.mock.calls.map((call) => (call[1] as { action: ApplicationEventName }).action)
}
