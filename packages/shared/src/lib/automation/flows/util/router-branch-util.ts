import { RouterActionSettings, RouterActionSettingsWithValidation } from '../actions/action'

// The branch operations are the only writes that change a router's settings without passing
// through `prepareRequest`'s UPDATE_ACTION / ADD_ACTION branches, which is where every other path
// recomputes `valid`. Before #429 that left a router marked valid from its creation even after a
// branch was added, deleted or moved — so the publish gate, which is `step.valid`, never saw a
// condition-less branch that had become unreachable.
function isSettingsValid(settings: RouterActionSettings): boolean {
    return RouterActionSettingsWithValidation.safeParse(settings).success
}

export const routerBranchUtil = {
    isSettingsValid,
}
