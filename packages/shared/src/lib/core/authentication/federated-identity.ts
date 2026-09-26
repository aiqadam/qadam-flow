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
})
export type UserFederatedIdentity = z.infer<typeof UserFederatedIdentity>
