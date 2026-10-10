import { isDeepStrictEqual } from 'node:util'
import { isNil } from '@aiqadam/shared'
import { z } from 'zod'

// The props check of ADR-0004 "Export and import" and ADR-0003 "Unavailable version": can a step
// built on one version of a qadam run on another? It compares the two versions' own `metadata.json`
// for the one action or trigger the step uses, by the rules gate 2 (#797) applies to a diff of the
// source: a prop the step may rely on must still exist with the same type, a required prop with no
// default must not appear or become required, and a static dropdown must not lose a value.
//
// It reads metadata the instance did not write (the catalogue's, a stored snapshot's, an export's),
// so it parses what it needs leniently and answers "not compatible" for anything it cannot read.
// What it cannot see, like gate 2: output shape and behaviour.
export const qadamPropsCompatibility = {
    // Whether a version's metadata describes the action or trigger at all, so a caller can stop
    // before it fetches anything to compare it with.
    describes: ({ metadata, target }: { metadata: unknown, target: StepTarget }): boolean => findProps({ metadata, target }) !== null,

    check: ({ from, to, target }: CheckParams): PropsCompatibilityResult => {
        const before = findProps({ metadata: from, target })
        const after = findProps({ metadata: to, target })
        if (before === null) {
            return incompatible({ reason: 'the earlier version does not describe this step' })
        }
        if (after === null) {
            return incompatible({ reason: `the later version has no ${target.kind} ${target.name}` })
        }
        for (const [name, was] of Object.entries(before)) {
            const now = Object.hasOwn(after, name) ? after[name] : undefined
            if (isNil(now)) {
                return incompatible({ reason: `prop ${name} was removed` })
            }
            if (now.type !== was.type) {
                return incompatible({ reason: `prop ${name} changed type` })
            }
            if (mustBeSet({ prop: now }) && !mustBeSet({ prop: was })) {
                return incompatible({ reason: `prop ${name} became required with no default` })
            }
            if (valuesLost({ was, now })) {
                return incompatible({ reason: `prop ${name} lost a dropdown value` })
            }
        }
        const added = Object.entries(after).find(([name, now]) => !Object.hasOwn(before, name) && mustBeSet({ prop: now }))
        return isNil(added) ? { compatible: true } : incompatible({ reason: `prop ${added[0]} was added as required with no default` })
    },
}

function findProps({ metadata, target }: { metadata: unknown, target: StepTarget }): Record<string, Prop> | null {
    const parsed = Surface.safeParse(metadata)
    if (!parsed.success) {
        return null
    }
    const owners = target.kind === 'action' ? parsed.data.actions : parsed.data.triggers
    return Object.hasOwn(owners, target.name) ? owners[target.name].props : null
}

function mustBeSet({ prop }: { prop: Prop }): boolean {
    return prop.required === true && isNil(prop.defaultValue)
}

function valuesLost({ was, now }: { was: Prop, now: Prop }): boolean {
    const before = optionValues({ prop: was })
    const after = optionValues({ prop: now })
    if (isNil(before) || isNil(after)) {
        return false
    }
    return before.some((value) => !after.some((candidate) => isDeepStrictEqual(candidate, value)))
}

function optionValues({ prop }: { prop: Prop }): unknown[] | null {
    return prop.options?.options?.map((option) => option.value) ?? null
}

function incompatible({ reason }: { reason: string }): PropsCompatibilityResult {
    return { compatible: false, reason }
}

const Prop = z.looseObject({
    type: z.string(),
    required: z.boolean().optional(),
    defaultValue: z.unknown().optional(),
    options: z.looseObject({
        options: z.array(z.looseObject({ value: z.unknown() })).optional(),
    }).optional(),
})

const Owner = z.looseObject({ props: z.record(z.string(), Prop) })

const Surface = z.looseObject({
    actions: z.record(z.string(), Owner),
    triggers: z.record(z.string(), Owner),
})

type Prop = z.infer<typeof Prop>

type CheckParams = {
    // The version the step was built on (a snapshot) and the version it would move to (a release).
    from: unknown
    to: unknown
    target: StepTarget
}

export type StepTarget = {
    kind: 'action' | 'trigger'
    name: string
}

export type PropsCompatibilityResult =
    | { compatible: true }
    | { compatible: false, reason: string }
