import { apId, DefaultProjectRole, LdapConfig, LdapTlsMode, PlatformRole, PlatformRoleManagedBy, ProjectMemberManagedBy, ProjectType, UserIdentityProvider } from '@aiqadam/shared'
import pino from 'pino'
import { ldapGroupMappingService } from '../../../../src/app/authentication/ldap/ldap-group-mapping-service'
import { userIdentityService } from '../../../../src/app/authentication/user-identity/user-identity-service'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { projectService } from '../../../../src/app/project/project-service'
import { userService } from '../../../../src/app/user/user-service'
import { createMockProject, mockAndSaveBasicSetup } from '../../../helpers/mocks'
import { cleanDatabase, setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

// Exercises `ldapGroupMappingService.applyMapping` directly against real Postgres — the DB-side
// half of Phase 2's group mapping, independent of the LDAP wire protocol (irrelevant here) or the
// pure grant-resolution logic (covered by `ldap-group-mapping.test.ts`'s unit tests).
const log = pino({ level: 'silent' })

beforeAll(async () => {
    await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    await cleanDatabase()
})

function baseConfig(overrides: Partial<LdapConfig> = {}): LdapConfig {
    return {
        url: 'ldaps://ldap.example.com:636',
        tlsMode: LdapTlsMode.LDAPS,
        baseDn: 'dc=example,dc=com',
        bindDn: 'cn=service,dc=example,dc=com',
        userFilter: '(uid={username})',
        attributeMap: { subject: 'entryUUID', email: 'mail', firstName: 'givenName', lastName: 'sn' },
        tlsVerify: true,
        jitProvisioning: true,
        linkExistingByEmail: false,
        sessionTtlSeconds: 43200,
        enabled: true,
        nestedGroups: false,
        groupMappings: [],
        ...overrides,
    }
}

async function createDirectoryUser(platformId: string): Promise<string> {
    const identity = await userIdentityService(log).create({
        email: `directory-user-${apId()}@example.com`,
        firstName: 'Directory',
        lastName: 'User',
        password: apId(),
        provider: UserIdentityProvider.LDAP,
        verified: true,
        trackEvents: false,
        newsLetter: false,
    })
    const user = await userService(log).getOrCreateWithProject({ identity, platformId })
    return user.id
}

describe('ldapGroupMappingService.applyMapping — platform role', () => {
    it('grants the highest matched platform role', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        const userId = await createDirectoryUser(mockPlatform.id)
        const config = baseConfig({
            groupMappings: [
                { groupDn: 'cn=members,dc=example,dc=com', platformRole: PlatformRole.MEMBER, projects: [] },
                { groupDn: 'cn=operators,dc=example,dc=com', platformRole: PlatformRole.OPERATOR, projects: [] },
            ],
        })

        await ldapGroupMappingService(log).applyMapping({
            platformId: mockPlatform.id,
            userId,
            config,
            memberGroupDns: ['cn=members,dc=example,dc=com', 'cn=operators,dc=example,dc=com'],
        })

        const user = await userService(log).getOrThrow({ id: userId })
        expect(user.platformRole).toBe(PlatformRole.OPERATOR)
    })

    it('leaves the platform role untouched when no group matches', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        const userId = await createDirectoryUser(mockPlatform.id)
        const config = baseConfig({
            groupMappings: [{ groupDn: 'cn=admins,dc=example,dc=com', platformRole: PlatformRole.ADMIN, projects: [] }],
        })

        await ldapGroupMappingService(log).applyMapping({ platformId: mockPlatform.id, userId, config, memberGroupDns: [] })

        const user = await userService(log).getOrThrow({ id: userId })
        expect(user.platformRole).toBe(PlatformRole.MEMBER)
    })

    it('never changes the platform owner\'s role', async () => {
        const { mockPlatform, mockOwner } = await mockAndSaveBasicSetup()
        const config = baseConfig({
            groupMappings: [{ groupDn: 'cn=members,dc=example,dc=com', platformRole: PlatformRole.MEMBER, projects: [] }],
        })

        await ldapGroupMappingService(log).applyMapping({
            platformId: mockPlatform.id,
            userId: mockOwner.id,
            config,
            memberGroupDns: ['cn=members,dc=example,dc=com'],
        })

        const owner = await userService(log).getOrThrow({ id: mockOwner.id })
        expect(owner.platformRole).toBe(PlatformRole.ADMIN)
    })
})

describe('ldapGroupMappingService.applyMapping — project grants', () => {
    it('creates a directory-managed project_member row for a matched mapping', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        const userId = await createDirectoryUser(mockPlatform.id)
        const project = createMockProject({ platformId: mockPlatform.id, type: ProjectType.TEAM, ownerId: userId })
        await databaseConnection().getRepository('project').save(project)
        const config = baseConfig({
            groupMappings: [{ groupDn: 'cn=editors,dc=example,dc=com', projects: [{ projectId: project.id, role: DefaultProjectRole.EDITOR }] }],
        })

        await ldapGroupMappingService(log).applyMapping({
            platformId: mockPlatform.id,
            userId,
            config,
            memberGroupDns: ['cn=editors,dc=example,dc=com'],
        })

        const membership = await databaseConnection().getRepository('project_member').findOneBy({ userId, projectId: project.id })
        expect(membership).not.toBeNull()
        expect(membership?.managedBy).toBe(ProjectMemberManagedBy.LDAP)
        const projectRole = await databaseConnection().getRepository('project_role').findOneBy({ id: membership?.projectRoleId })
        expect(projectRole?.name).toBe(DefaultProjectRole.EDITOR)
    })

    it('removes a directory-managed project_member row once the mapping no longer grants it', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        const userId = await createDirectoryUser(mockPlatform.id)
        const project = createMockProject({ platformId: mockPlatform.id, type: ProjectType.TEAM, ownerId: userId })
        await databaseConnection().getRepository('project').save(project)
        const config = baseConfig({
            groupMappings: [{ groupDn: 'cn=editors,dc=example,dc=com', projects: [{ projectId: project.id, role: DefaultProjectRole.EDITOR }] }],
        })
        await ldapGroupMappingService(log).applyMapping({
            platformId: mockPlatform.id, userId, config, memberGroupDns: ['cn=editors,dc=example,dc=com'],
        })
        expect(await databaseConnection().getRepository('project_member').findOneBy({ userId, projectId: project.id })).not.toBeNull()

        // The user no longer belongs to the group that grants this project.
        await ldapGroupMappingService(log).applyMapping({ platformId: mockPlatform.id, userId, config, memberGroupDns: [] })

        expect(await databaseConnection().getRepository('project_member').findOneBy({ userId, projectId: project.id })).toBeNull()
    })

    it('never touches a manually-added membership, even when it also matches a mapping', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        const userId = await createDirectoryUser(mockPlatform.id)
        const project = createMockProject({ platformId: mockPlatform.id, type: ProjectType.TEAM, ownerId: userId })
        await databaseConnection().getRepository('project').save(project)
        const manualRole = await projectService(log).getOrCreateDefaultProjectRoleId({ platformId: mockPlatform.id, role: DefaultProjectRole.VIEWER })
        const manualMembershipId = apId()
        await databaseConnection().getRepository('project_member').save({
            id: manualMembershipId,
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            userId,
            projectId: project.id,
            projectRoleId: manualRole,
            platformId: mockPlatform.id,
            managedBy: ProjectMemberManagedBy.MANUAL,
        })
        const config = baseConfig({
            groupMappings: [{ groupDn: 'cn=editors,dc=example,dc=com', projects: [{ projectId: project.id, role: DefaultProjectRole.EDITOR }] }],
        })

        await ldapGroupMappingService(log).applyMapping({
            platformId: mockPlatform.id, userId, config, memberGroupDns: ['cn=editors,dc=example,dc=com'],
        })

        const membership = await databaseConnection().getRepository('project_member').findOneBy({ userId, projectId: project.id })
        expect(membership?.id).toBe(manualMembershipId)
        expect(membership?.managedBy).toBe(ProjectMemberManagedBy.MANUAL)
        expect(membership?.projectRoleId).toBe(manualRole)

        // Losing the group must not remove a manual membership either.
        await ldapGroupMappingService(log).applyMapping({ platformId: mockPlatform.id, userId, config, memberGroupDns: [] })
        expect(await databaseConnection().getRepository('project_member').findOneBy({ userId, projectId: project.id })).not.toBeNull()
    })

    it('silently skips a projectId that no longer belongs to this platform (defense in depth)', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        const otherPlatform = await mockAndSaveBasicSetup()
        const userId = await createDirectoryUser(mockPlatform.id)
        const config = baseConfig({
            groupMappings: [{ groupDn: 'cn=editors,dc=example,dc=com', projects: [{ projectId: otherPlatform.mockProject.id, role: DefaultProjectRole.EDITOR }] }],
        })

        await expect(ldapGroupMappingService(log).applyMapping({
            platformId: mockPlatform.id, userId, config, memberGroupDns: ['cn=editors,dc=example,dc=com'],
        })).resolves.toBeUndefined()

        expect(await databaseConnection().getRepository('project_member').findOneBy({ userId, projectId: otherPlatform.mockProject.id })).toBeNull()
    })

    it('ignores a mapping that targets a non-TEAM project, even when it is otherwise matched', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        const userId = await createDirectoryUser(mockPlatform.id)
        const nonTeamProject = createMockProject({ platformId: mockPlatform.id, type: ProjectType.PERSONAL, ownerId: userId })
        await databaseConnection().getRepository('project').save(nonTeamProject)
        const config = baseConfig({
            groupMappings: [{ groupDn: 'cn=editors,dc=example,dc=com', projects: [{ projectId: nonTeamProject.id, role: DefaultProjectRole.EDITOR }] }],
        })

        await ldapGroupMappingService(log).applyMapping({
            platformId: mockPlatform.id, userId, config, memberGroupDns: ['cn=editors,dc=example,dc=com'],
        })

        expect(await databaseConnection().getRepository('project_member').findOneBy({ userId, projectId: nonTeamProject.id })).toBeNull()
    })

    // The `ON CONFLICT ... DO UPDATE ... WHERE "managedBy" = 'LDAP'` clause is a defense-in-depth
    // guard against a race between this function's own JS-level "does a MANUAL row already exist"
    // check and the insert that follows it — a concurrent write (e.g. an invitation acceptance)
    // creating the MANUAL row in that exact window must still never be overwritten. `findOneBy` is
    // stubbed to return `null` for one call only, simulating that race window (the MANUAL row
    // already exists in Postgres by the time the upsert below runs, but this function's own
    // pre-check did not see it) — everything else in the call goes through the real function and
    // the real database.
    it('never flips a MANUAL row to LDAP even when the pre-check misses it under a race', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        const userId = await createDirectoryUser(mockPlatform.id)
        const project = createMockProject({ platformId: mockPlatform.id, type: ProjectType.TEAM, ownerId: userId })
        await databaseConnection().getRepository('project').save(project)
        const manualRole = await projectService(log).getOrCreateDefaultProjectRoleId({ platformId: mockPlatform.id, role: DefaultProjectRole.VIEWER })
        const manualMembershipId = apId()
        await databaseConnection().getRepository('project_member').save({
            id: manualMembershipId,
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            userId,
            projectId: project.id,
            projectRoleId: manualRole,
            platformId: mockPlatform.id,
            managedBy: ProjectMemberManagedBy.MANUAL,
        })
        const projectMemberRepo = databaseConnection().getRepository('project_member')
        const findOneBySpy = vi.spyOn(projectMemberRepo, 'findOneBy').mockResolvedValueOnce(null)
        const config = baseConfig({
            groupMappings: [{ groupDn: 'cn=editors,dc=example,dc=com', projects: [{ projectId: project.id, role: DefaultProjectRole.EDITOR }] }],
        })

        await ldapGroupMappingService(log).applyMapping({
            platformId: mockPlatform.id, userId, config, memberGroupDns: ['cn=editors,dc=example,dc=com'],
        })

        findOneBySpy.mockRestore()
        const membership = await databaseConnection().getRepository('project_member').findOneBy({ userId, projectId: project.id })
        expect(membership?.id).toBe(manualMembershipId)
        expect(membership?.managedBy).toBe(ProjectMemberManagedBy.MANUAL)
        expect(membership?.projectRoleId).toBe(manualRole)
    })
})

describe('ldapGroupMappingService.applyMapping — platform-role provenance and revocation', () => {
    it('marks a group-granted platform role as LDAP-managed, and reverts it to MEMBER once no group grants one anymore', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        const userId = await createDirectoryUser(mockPlatform.id)
        const config = baseConfig({
            groupMappings: [{ groupDn: 'cn=admins,dc=example,dc=com', platformRole: PlatformRole.ADMIN, projects: [] }],
        })

        await ldapGroupMappingService(log).applyMapping({
            platformId: mockPlatform.id, userId, config, memberGroupDns: ['cn=admins,dc=example,dc=com'],
        })
        const promoted = await userService(log).getOrThrow({ id: userId })
        expect(promoted.platformRole).toBe(PlatformRole.ADMIN)
        expect(promoted.platformRoleManagedBy).toBe(PlatformRoleManagedBy.LDAP)

        // The user no longer belongs to any group that grants a platform role.
        await ldapGroupMappingService(log).applyMapping({
            platformId: mockPlatform.id, userId, config, memberGroupDns: [],
        })
        const reverted = await userService(log).getOrThrow({ id: userId })
        expect(reverted.platformRole).toBe(PlatformRole.MEMBER)
        // The raise recorded MEMBER as the pre-raise baseline — `createDirectoryUser` starts every
        // user as a MANUAL MEMBER, the schema default, but that is still a real prior state to
        // restore, not a value the baseline logic special-cases away. Restoring a recorded
        // baseline is restoring a human decision, so provenance goes back to MANUAL, even though
        // the restored role (MEMBER) happens to look identical to the no-baseline fallback.
        expect(reverted.platformRoleManagedBy).toBe(PlatformRoleManagedBy.MANUAL)
    })

    it('never demotes a manually-granted ADMIN role when no mapping matches', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        const userId = await createDirectoryUser(mockPlatform.id)
        await userService(log).update({ id: userId, platformId: mockPlatform.id, platformRole: PlatformRole.ADMIN, source: 'ADMIN' })
        const config = baseConfig({
            groupMappings: [{ groupDn: 'cn=members,dc=example,dc=com', platformRole: PlatformRole.MEMBER, projects: [] }],
        })

        await ldapGroupMappingService(log).applyMapping({
            platformId: mockPlatform.id, userId, config, memberGroupDns: [],
        })

        const user = await userService(log).getOrThrow({ id: userId })
        expect(user.platformRole).toBe(PlatformRole.ADMIN)
        expect(user.platformRoleManagedBy).toBe(PlatformRoleManagedBy.MANUAL)
    })
})

// A MEMBER/OPERATOR-mapped group must never silently demote a MANUAL ADMIN just because that
// admin's own directory account happens to match it — the exact opposite of "a manually set role
// is never demoted by a mapping". These cases are the matched-role scenario the tests above don't
// cover (those only exercise the *no-match* revert path).
describe('ldapGroupMappingService.applyMapping — a mapping may only ever raise a MANUAL role, never lower it', () => {
    it('a manual ADMIN in a MEMBER-mapped group stays ADMIN and MANUAL', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        const userId = await createDirectoryUser(mockPlatform.id)
        await userService(log).update({ id: userId, platformId: mockPlatform.id, platformRole: PlatformRole.ADMIN, source: 'ADMIN' })
        const config = baseConfig({
            groupMappings: [{ groupDn: 'cn=members,dc=example,dc=com', platformRole: PlatformRole.MEMBER, projects: [] }],
        })

        await ldapGroupMappingService(log).applyMapping({
            platformId: mockPlatform.id, userId, config, memberGroupDns: ['cn=members,dc=example,dc=com'],
        })

        const user = await userService(log).getOrThrow({ id: userId })
        expect(user.platformRole).toBe(PlatformRole.ADMIN)
        expect(user.platformRoleManagedBy).toBe(PlatformRoleManagedBy.MANUAL)
    })

    it('a manual MEMBER in an ADMIN-mapped group becomes ADMIN and LDAP, then reverts to MEMBER once removed from the group', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        const userId = await createDirectoryUser(mockPlatform.id)
        // `createDirectoryUser` already starts as a MANUAL MEMBER (the default); the mapping raises it.
        const config = baseConfig({
            groupMappings: [{ groupDn: 'cn=admins,dc=example,dc=com', platformRole: PlatformRole.ADMIN, projects: [] }],
        })

        await ldapGroupMappingService(log).applyMapping({
            platformId: mockPlatform.id, userId, config, memberGroupDns: ['cn=admins,dc=example,dc=com'],
        })
        const raised = await userService(log).getOrThrow({ id: userId })
        expect(raised.platformRole).toBe(PlatformRole.ADMIN)
        expect(raised.platformRoleManagedBy).toBe(PlatformRoleManagedBy.LDAP)

        // Removed from the group on the directory side — the next sign-in/reconcile pass resolves
        // no platform role at all.
        await ldapGroupMappingService(log).applyMapping({
            platformId: mockPlatform.id, userId, config, memberGroupDns: [],
        })
        const reverted = await userService(log).getOrThrow({ id: userId })
        expect(reverted.platformRole).toBe(PlatformRole.MEMBER)
        // MEMBER was recorded as the pre-raise baseline (the same reasoning as the provenance test
        // above) — restoring a recorded baseline is restoring a human decision, so this goes back
        // to MANUAL, not LDAP.
        expect(reverted.platformRoleManagedBy).toBe(PlatformRoleManagedBy.MANUAL)
    })
})

// "Manual roles are never demoted" applies to a mapping-raised role too, once the group grant that
// raised it goes away — the revert must land back on the admin's own prior role, not fall all the
// way to MEMBER, which would itself be a demotion the admin never asked for.
describe('ldapGroupMappingService.applyMapping — a raised MANUAL role reverts to its own prior role, not MEMBER', () => {
    it('reverts a MANUAL OPERATOR raised to ADMIN back to OPERATOR, not MEMBER, once the group no longer grants a role', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        const userId = await createDirectoryUser(mockPlatform.id)
        await userService(log).update({ id: userId, platformId: mockPlatform.id, platformRole: PlatformRole.OPERATOR, source: 'ADMIN' })
        const config = baseConfig({
            groupMappings: [{ groupDn: 'cn=admins,dc=example,dc=com', platformRole: PlatformRole.ADMIN, projects: [] }],
        })

        await ldapGroupMappingService(log).applyMapping({
            platformId: mockPlatform.id, userId, config, memberGroupDns: ['cn=admins,dc=example,dc=com'],
        })
        const raised = await userService(log).getOrThrow({ id: userId })
        expect(raised.platformRole).toBe(PlatformRole.ADMIN)
        expect(raised.platformRoleManagedBy).toBe(PlatformRoleManagedBy.LDAP)
        expect(raised.platformRoleManualBaseline).toBe(PlatformRole.OPERATOR)

        // Removed from the group on the directory side — the next sign-in/reconcile pass resolves
        // no platform role at all.
        await ldapGroupMappingService(log).applyMapping({
            platformId: mockPlatform.id, userId, config, memberGroupDns: [],
        })
        const reverted = await userService(log).getOrThrow({ id: userId })
        expect(reverted.platformRole).toBe(PlatformRole.OPERATOR)
        // Restoring a recorded baseline restores a human decision — provenance goes back to
        // MANUAL, not LDAP. Leaving it LDAP would mean the *next* mapping pass treats this
        // already-restored MANUAL role as still eligible to raise unconditionally (silently
        // discarding that the mapping's own grant was just revoked), and would never record a
        // fresh baseline on a later raise either, since the raise branch only records one when
        // raising *from* MANUAL — a second raise-then-revert cycle would then fall all the way to
        // MEMBER instead of back to OPERATOR, which the third call below proves does not happen.
        expect(reverted.platformRoleManagedBy).toBe(PlatformRoleManagedBy.MANUAL)
        expect(reverted.platformRoleManualBaseline).toBeNull()

        // A third pass, still with no group match: the role is MANUAL again now, so
        // `applyPlatformRoleGrant`'s own `isManuallyManaged` guard makes this a pure no-op — proving
        // the revert really did restore MANUAL provenance, not just the OPERATOR role value. Under
        // the pre-fix bug (provenance staying LDAP), this same call would incorrectly demote the
        // user again, all the way to MEMBER (no baseline left to fall back on, since it was already
        // cleared by the second call).
        await ldapGroupMappingService(log).applyMapping({
            platformId: mockPlatform.id, userId, config, memberGroupDns: [],
        })
        const afterThirdPass = await userService(log).getOrThrow({ id: userId })
        expect(afterThirdPass.platformRole).toBe(PlatformRole.OPERATOR)
        expect(afterThirdPass.platformRoleManagedBy).toBe(PlatformRoleManagedBy.MANUAL)
    })

    it('an admin role write in between forgets the recorded baseline, so the next raise captures the new manual role instead of the stale one', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        const userId = await createDirectoryUser(mockPlatform.id)
        await userService(log).update({ id: userId, platformId: mockPlatform.id, platformRole: PlatformRole.OPERATOR, source: 'ADMIN' })
        const config = baseConfig({
            groupMappings: [{ groupDn: 'cn=admins,dc=example,dc=com', platformRole: PlatformRole.ADMIN, projects: [] }],
        })
        await ldapGroupMappingService(log).applyMapping({
            platformId: mockPlatform.id, userId, config, memberGroupDns: ['cn=admins,dc=example,dc=com'],
        })
        expect((await userService(log).getOrThrow({ id: userId })).platformRoleManualBaseline).toBe(PlatformRole.OPERATOR)

        // An admin, unaware this ADMIN role came from a group, explicitly sets it by hand — a fresh
        // manual decision that must forget the stale OPERATOR baseline a since-superseded mapping
        // recorded, not merely leave it lying around unread.
        await userService(log).update({ id: userId, platformId: mockPlatform.id, platformRole: PlatformRole.MEMBER, source: 'ADMIN' })
        const afterAdminWrite = await userService(log).getOrThrow({ id: userId })
        expect(afterAdminWrite.platformRoleManagedBy).toBe(PlatformRoleManagedBy.MANUAL)
        expect(afterAdminWrite.platformRoleManualBaseline).toBeNull()

        // The same group raises the role again — the baseline it now records must be the fresh
        // MANUAL MEMBER the admin just left it at, not the stale OPERATOR from before.
        await ldapGroupMappingService(log).applyMapping({
            platformId: mockPlatform.id, userId, config, memberGroupDns: ['cn=admins,dc=example,dc=com'],
        })
        expect((await userService(log).getOrThrow({ id: userId })).platformRoleManualBaseline).toBe(PlatformRole.MEMBER)

        await ldapGroupMappingService(log).applyMapping({
            platformId: mockPlatform.id, userId, config, memberGroupDns: [],
        })
        const reverted = await userService(log).getOrThrow({ id: userId })
        expect(reverted.platformRole).toBe(PlatformRole.MEMBER)
    })
})
