import { apId, DefaultProjectRole, LdapConfig, LdapTlsMode, PlatformRole, ProjectMemberManagedBy, ProjectType, UserIdentityProvider } from '@aiqadam/shared'
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
})
