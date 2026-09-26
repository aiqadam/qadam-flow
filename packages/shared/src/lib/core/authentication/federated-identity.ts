import { z } from 'zod'
import { BaseModelSchema } from '../common/base-model'

// A generic join between a platform user and an external directory's own identifier for that
// user, so a JIT-provisioned account can be looked up on the next login without depending on the
// directory's own subject staying attached to the same email forever (an AD `objectGUID` survives
// a UPN rename; the email attribute this row was created from does not have to). Deliberately not
// `user.externalId` — that column is a project's own admin-writable embedding id, unrelated to
// directory identity and readable/writable by ordinary platform-admin routes.
export enum FederatedIdentityProvider {
    LDAP = 'LDAP',
}

export const UserFederatedIdentity = z.object({
    ...BaseModelSchema,
    platformId: z.string(),
    userId: z.string(),
    provider: z.enum(FederatedIdentityProvider),
    subject: z.string(),
    // Set only by the LDAP reconcile job (`.agents/features/ldap.md` Phase 2) when it deactivates
    // a user because the directory account is gone or disabled — never by a sign-in, and never by
    // an admin's own deactivation. Reconcile reads this back to decide whether *it* is allowed to
    // reactivate the user: only an account the directory itself deactivated is reactivated
    // automatically, so a manual admin deactivation always sticks.
    directoryDisabledAt: z.string().nullable(),
    // Round 3 (app-sec finding #5): stamped by the reconcile job every time it actually resolves
    // this identity's directory state within its per-platform time budget — the ordering
    // `listByPlatformAndProvider` reads it back with (oldest/never-reconciled first, `NULLS FIRST`)
    // is what rotates the starting point across ticks, so a slow/huge directory's time budget
    // starves a *different* slice of users each run instead of the same prefix forever.
    lastReconciledAt: z.string().nullable(),
})
export type UserFederatedIdentity = z.infer<typeof UserFederatedIdentity>
