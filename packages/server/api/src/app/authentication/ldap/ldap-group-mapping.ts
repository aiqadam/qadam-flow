import { DefaultProjectRole, isNil, LdapGroupMapping, PlatformRole } from '@aiqadam/shared'

export const ldapGroupMappingUtils = {
    normalizeGroupDn,
    resolveGrants,
}

const PLATFORM_ROLE_RANK: Record<PlatformRole, number> = {
    [PlatformRole.MEMBER]: 0,
    [PlatformRole.OPERATOR]: 1,
    [PlatformRole.ADMIN]: 2,
}

const PROJECT_ROLE_RANK: Record<DefaultProjectRole, number> = {
    [DefaultProjectRole.VIEWER]: 0,
    [DefaultProjectRole.EDITOR]: 1,
    [DefaultProjectRole.ADMIN]: 2,
}

// Deliberately not full RFC 4514 DN parsing (escaped commas inside a value, multi-valued RDNs,
// attribute-type OID vs. name equivalence) — trimming each comma-separated component and
// lowercasing the whole string is a pragmatic approximation that covers the common case: the same
// DN string reported by `memberOf`/a group search, however an admin happened to space it out when
// typing the mapping's own `groupDn`.
function normalizeGroupDn(dn: string): string {
    return dn
        .trim()
        .toLowerCase()
        .split(',')
        .map((part) => part.trim())
        .join(',')
}

// The platform role is the *highest* matched mapping's role (never lower than what a lower-ranked
// matching group would grant); a project's role is likewise the highest among every matching
// mapping that names that project. A mapping with no `platformRole` at all contributes nothing to
// the platform-role decision — "no mapping sets a platform role" (distinct from "every mapping
// grants MEMBER") is exactly what leaves the caller's existing platform role untouched.
function resolveGrants({ groupMappings, memberGroupDns }: ResolveGrantsParams): ResolvedGrants {
    const normalizedMemberDns = new Set(memberGroupDns.map(normalizeGroupDn))
    const matchedMappings = groupMappings.filter((mapping) => normalizedMemberDns.has(normalizeGroupDn(mapping.groupDn)))

    const platformRole = matchedMappings.reduce<PlatformRole | null>((highest, mapping) => {
        if (isNil(mapping.platformRole)) {
            return highest
        }
        if (isNil(highest) || PLATFORM_ROLE_RANK[mapping.platformRole] > PLATFORM_ROLE_RANK[highest]) {
            return mapping.platformRole
        }
        return highest
    }, null)

    const projectRoles = new Map<string, DefaultProjectRole>()
    for (const mapping of matchedMappings) {
        for (const project of mapping.projects) {
            const existing = projectRoles.get(project.projectId)
            if (isNil(existing) || PROJECT_ROLE_RANK[project.role] > PROJECT_ROLE_RANK[existing]) {
                projectRoles.set(project.projectId, project.role)
            }
        }
    }

    return { platformRole, projectRoles }
}

type ResolveGrantsParams = {
    groupMappings: LdapGroupMapping[]
    memberGroupDns: string[]
}

type ResolvedGrants = {
    platformRole: PlatformRole | null
    projectRoles: Map<string, DefaultProjectRole>
}
