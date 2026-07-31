import { isNil, McpToolDefinition, Permission, ProjectType } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { projectService } from '../project/project-service'
import { userService } from '../user/user-service'

// Mirrors what `authorize.ts:114-155` does for a normal REST route, because the tools reached
// through here are the same mutations those routes guard. It used to return ALLOW_ALL, which meant
// a project VIEWER driving these tools — over MCP, and now over chat — could create, publish and
// delete flows, tables and records that the REST API would have refused them. The tools declared
// their `permission` all along; nothing ever read it.
export async function resolvePermissionChecker({ userId, projectId, log }: ResolveParams): Promise<PermissionChecker> {
    const user = await userService(log).getOneOrFail({ id: userId })
    // Platform ADMIN/OPERATOR bypass per-project checks, exactly as they do on the REST path.
    if (userService(log).isUserPrivileged(user)) {
        return ALLOW_ALL
    }

    const project = await projectService(log).getOne(projectId)
    if (isNil(project) || project.platformId !== user.platformId) {
        return DENY_ALL
    }
    if (project.type === ProjectType.PERSONAL) {
        return project.ownerId === user.id ? ALLOW_ALL : DENY_ALL
    }

    const role = await projectService(log).getProjectRoleForUser({
        userId: user.id,
        projectId: project.id,
        platformId: project.platformId,
    })
    if (isNil(role)) {
        return DENY_ALL
    }
    return checkerForPermissions(role.permissions)
}

// `ProjectRole.permissions` is typed as `string[]` on the entity, so membership is tested as
// strings rather than casting the role's list into the enum.
function checkerForPermissions(granted: string[]): PermissionChecker {
    const check = (permission: Permission | undefined, toolTitle: string): McpToolErrorResult | null => {
        // A tool that declares no permission is allowed to anyone who already has access to the
        // project. All eight are metadata and discovery only — piece properties, piece research,
        // the AI model list, property options and chains, step-config validation, the setup guide,
        // project context — and none reads or writes project data. Everything that touches project
        // data declares a permission, and a unit test asserts that stays true so a new tool cannot
        // arrive unclassified and be allowed by default.
        if (isNil(permission) || granted.includes(permission)) {
            return null
        }
        return { content: [{ type: 'text', text: deniedMessage({ toolTitle, permission }) }], isError: true }
    }

    return {
        check,
        // Reported back to the model as a tool error rather than thrown, so the assistant can tell
        // the user why it stopped instead of the whole turn failing.
        wrapExecute: ({ execute, permission, toolTitle }) => async (args) => check(permission, toolTitle) ?? execute(args),
    }
}

function deniedMessage({ toolTitle, permission }: { toolTitle: string, permission?: Permission }): string {
    return isNil(permission)
        ? `You do not have access to this project, so ${toolTitle} cannot run here.`
        : `You do not have permission to use ${toolTitle} in this project. It needs ${permission}; ask a project admin to grant it or to run this for you.`
}

export const ALLOW_ALL: PermissionChecker = {
    check: () => null,
    wrapExecute: ({ execute }) => execute,
}

export const DENY_ALL: PermissionChecker = {
    check: (_permission, toolTitle) => ({
        content: [{ type: 'text', text: deniedMessage({ toolTitle }) }],
        isError: true,
    }),
    wrapExecute: ({ toolTitle }) => async () => ({
        content: [{ type: 'text', text: deniedMessage({ toolTitle }) }],
        isError: true,
    }),
}

export type PermissionChecker = {
    check: (permission: Permission | undefined, toolTitle: string) => McpToolErrorResult | null
    wrapExecute: (params: { execute: McpToolDefinition['execute'], permission: Permission | undefined, toolTitle: string }) => McpToolDefinition['execute']
}

type ResolveParams = {
    userId: string
    projectId: string
    log: FastifyBaseLogger
}

type McpToolErrorResult = {
    content: Array<{ type: 'text', text: string }>
    isError: boolean
}
