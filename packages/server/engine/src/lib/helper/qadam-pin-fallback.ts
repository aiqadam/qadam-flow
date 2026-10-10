import { qadamPinFallbackDecision } from '@aiqadam/server-utils/qadam-pin-fallback-decision'

// The run-time net under #808's audited move. The API moves a step whose exact pin cannot be had to
// the image's build inside the pin's caret range (props and load checked, an audit record with a
// revert, `qadamPinMoveService`) when its flow is published or enabled. A step that has not been
// through that yet, such as one in a flow that is already enabled, still reaches the engine with
// its stale pin, and this module is what runs it on the image's build meanwhile: loudly (the loader
// warns once per pin), never outside the caret range, and with no write. It cannot audit or revert,
// so it is a net, not the fallback. Deleting it makes every unavailable pin fail with the pin
// named, and nothing else in the loader has to change.
//
// The caret rule is the one `qadamPinFallbackDecision` applies to the audited move. This net is
// stricter on purpose: a snapshot pin never gets a substitute here, because moving one needs its own
// `metadata.json` and a props check (ADR-0004), and a release pin never gets a snapshot build (a
// release number names released bytes).
export const qadamPinFallback = {
    check: (params: CheckParams): QadamPinFallbackVerdict => qadamPinFallbackDecision.checkNet(params),
}

type CheckParams = Parameters<typeof qadamPinFallbackDecision.checkNet>[0]

export type QadamPinFallbackVerdict = ReturnType<typeof qadamPinFallbackDecision.checkNet>
