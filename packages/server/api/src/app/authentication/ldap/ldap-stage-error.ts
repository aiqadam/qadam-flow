import { LdapTestStage } from '@aiqadam/shared'

// A single internal error shape carried through host-guard resolution, the connect/bind/search
// steps and the sign-in flow, so both callers — the public sign-in endpoint (which maps `stage` to
// one of the four public `ErrorCode`s and drops everything else) and the admin-only `/test`
// endpoint (which returns `stage`, `message` and `ldapResultCode` verbatim) — read the same
// failure information instead of two ad hoc shapes that drift apart.
export class LdapStageError extends Error {
    public readonly stage: LdapTestStage

    public readonly ldapResultCode?: number

    constructor({ stage, message, ldapResultCode }: LdapStageErrorParams) {
        super(message)
        this.name = 'LdapStageError'
        this.stage = stage
        this.ldapResultCode = ldapResultCode
    }
}

type LdapStageErrorParams = {
    stage: LdapTestStage
    message: string
    ldapResultCode?: number
}
