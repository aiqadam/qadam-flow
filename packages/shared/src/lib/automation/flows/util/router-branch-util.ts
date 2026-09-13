import { RouterActionSettings, RouterActionSettingsWithValidation } from '../actions/action'

// ADD_BRANCH and DELETE_BRANCH are the only writes that change a router's settings without passing
// through `prepareRequest`'s UPDATE_ACTION / ADD_ACTION branches, which is where every other path
// recomputes `valid`. Before #429 that left a router marked valid from its creation no matter what
// was added to or removed from it — so the publish gate, which is `step.valid`, never saw a
// condition-less branch that had become unreachable. MOVE_BRANCH needs no recomputation: it only
// reorders branches and refuses to move the fallback, so it cannot change whether one has
// conditions. DUPLICATE_BRANCH and paste expand into ADD_BRANCH / ADD_ACTION and inherit this.
function isSettingsValid(settings: RouterActionSettings): boolean {
    return RouterActionSettingsWithValidation.safeParse(settings).success
}

export const routerBranchUtil = {
    isSettingsValid,
}
