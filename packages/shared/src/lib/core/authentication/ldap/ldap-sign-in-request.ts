import { z } from 'zod'
import { formErrors } from '../../../form-errors'

// Deliberately its own schema rather than reusing `SignInRequest` (`EmailType`/`PasswordType`): a
// directory username is not necessarily an email address, and the password bound here is
// forwarded to the directory's own bind, whose length limits differ from the local bcrypt path —
// `min(1)` matters more than usual, since an empty password must be refused before any I/O
// (RFC 4513 §5.1.2's unauthenticated-bind bypass).
export const LdapSignInRequest = z.object({
    username: z.string().min(1, formErrors.required).max(256, 'invalidLdapUsername'),
    password: z.string().min(1, formErrors.required).max(1024, 'invalidLdapPassword'),
})
export type LdapSignInRequest = z.infer<typeof LdapSignInRequest>
