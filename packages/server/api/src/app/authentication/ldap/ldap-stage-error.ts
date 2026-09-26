import { LdapTestStage } from '@aiqadam/shared'

// A single internal error shape carried through host-guard resolution, the connect/bind/search
// steps and the sign-in flow, so both callers — the public sign-in endpoint (which maps `stage` to
// one of the four public `ErrorCode`s and drops everything else) and the admin-only `/test`
// endpoint (which returns `stage`, `message` and `ldapResultCode` verbatim) — read the same
// failure information instead of two ad hoc shapes that drift apart.
export class LdapStageError extends Error {
    public readonly stage: LdapTestStage

    public readonly ldapResultCode?: number

    // Distinguishes "the search ran and matched nothing" from every other `SEARCH`-stage failure
    // (a protocol error, a filter matching more than one entry) — the one case the sign-in flow's
    // timing-oracle defense (`ldapAuthnService`'s dummy bind) needs to recognise specifically, since
    // it is the one case that would otherwise skip the second network round trip a matched-entry
    // wrong password always pays for.
    public readonly notFound?: boolean

    constructor({ stage, message, ldapResultCode, notFound }: LdapStageErrorParams) {
        super(message)
        this.name = 'LdapStageError'
        this.stage = stage
        this.ldapResultCode = ldapResultCode
        this.notFound = notFound
    }
}

type LdapStageErrorParams = {
    stage: LdapTestStage
    message: string
    ldapResultCode?: number
    notFound?: boolean
}
