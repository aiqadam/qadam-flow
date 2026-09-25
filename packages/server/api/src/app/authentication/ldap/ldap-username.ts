// One normalisation, used everywhere a username is compared or keyed on: the per-username rate
// limit bucket (`ldap-sign-in-rate-limit.ts`) and the directory search itself
// (`ldap-authn-service.ts`). Using two different normalisations for those two call sites would let
// an attacker dodge the rate limit with a Unicode-equivalent username that still resolves to the
// same directory entry — trim outer whitespace, collapse repeated internal whitespace to a single
// space, apply NFKC (folds full-width and compatibility variants to their canonical form) and
// lowercase, in that order, so the two call sites can never disagree about what "the same username"
// means.
function normalize(username: string): string {
    return username
        .trim()
        .replace(/\s+/g, ' ')
        .normalize('NFKC')
        .toLowerCase()
}

export const ldapUsernameUtils = {
    normalize,
}
