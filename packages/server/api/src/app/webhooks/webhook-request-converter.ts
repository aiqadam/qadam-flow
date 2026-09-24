import {
    ApId,
    ApMultipartFile,
    EventPayload,
    FAIL_PARENT_ON_FAILURE_HEADER,
    FileCompression,
    FileType,
    FlowRun,
    isMultipartFile,
    isNil,
    PARENT_RUN_ID_HEADER,
    tryCatchSync,
} from '@aiqadam/shared'
import { FastifyBaseLogger, FastifyRequest } from 'fastify'
import mime from 'mime-types'
import { z } from 'zod'
import { fileService } from '../file/file.service'
import { filesService } from '../file/files-service'
import { projectService } from '../project/project-service'

// Every call-flow release sends `body: { data, callbackUrl }`, and `callbackUrl` is the same
// `/v1/flow-runs/<flowRunId>/waitpoints/<waitpointId>[/sync]` URL `waitpoint-controller.ts` hands
// back from the create call — present exactly when the caller is actually waiting on a response,
// same as `FAIL_PARENT_ON_FAILURE_HEADER`. Reading the proof from here, instead of a new header,
// means every already-published call-flow version supplies it: a new header would need a qadam
// version bump before any existing flow's call-flow step could ever send it, silently stranding
// every already-deployed flow's parent PAUSED until `AP_PAUSED_FLOW_TIMEOUT_DAYS`'s cap (which
// only applies to DELAY waitpoints in the first place; a WEBHOOK waitpoint has no such cap at all).
// A join waitpoint's child (#374) gets its own slot's URL instead, `.../waitpoints/<waitpointId>/slots/<slotId>`:
// the slot id is what proves which of the join's children this is.
const CALLBACK_URL_WAITPOINT_PATH_PATTERN = /\/v1\/flow-runs\/(?<flowRunId>[^/]+)\/waitpoints\/(?<waitpointId>[^/]+?)(?:\/slots\/(?<slotId>[^/]+?)|\/sync)?\/?$/
// Default (strip) mode is enough: only `callbackUrl` is ever read off the parsed result, so
// there is nothing to preserve unknown keys for. `.passthrough()` is deprecated in zod 4.
const CallbackUrlBody = z.object({ callbackUrl: z.string() })

const BINARY_CONTENT_TYPE_PATTERNS = [
    /^image\//,
    /^video\//,
    /^audio\//,
    /^application\/pdf$/,
    /^application\/zip$/,
    /^application\/gzip$/,
    /^application\/octet-stream$/,
]

export function isBinaryContentType(contentType: string | undefined): boolean {
    if (!contentType) return false
    const baseContentType = contentType.split(';')[0].trim().toLowerCase()
    return BINARY_CONTENT_TYPE_PATTERNS.some(pattern => pattern.test(baseContentType))
}

export async function convertRequest(
    request: FastifyRequest,
    projectId: string,
    flowId: string,
): Promise<EventPayload> {
    const contentType = request.headers['content-type']
    const isBinary = isBinaryContentType(contentType) && Buffer.isBuffer(request.body)
    return {
        method: request.method,
        headers: request.headers as Record<string, string>,
        body: await convertBody(request, projectId, flowId),
        queryParams: request.query as Record<string, string>,
        rawBody: isBinary ? undefined : request.rawBody,
    }
}

export function extractHeaderFromRequest(request: FastifyRequest): Pick<FlowRun, 'parentRunId' | 'failParentOnFailure'> & { parentWaitpointId?: string, parentSlotId?: string } {
    const parentRunIdHeader = request.headers[PARENT_RUN_ID_HEADER]
    const parentRunId = typeof parentRunIdHeader === 'string' ? parentRunIdHeader : undefined
    const proof = extractParentWaitpointProofFromBody({ body: request.body, parentRunId })
    return {
        parentRunId,
        failParentOnFailure: request.headers[FAIL_PARENT_ON_FAILURE_HEADER] === 'true',
        parentWaitpointId: proof?.waitpointId,
        parentSlotId: proof?.slotId,
    }
}

/**
 * Requires the callback URL's own `flowRunId` to equal `parentRunId` (already read from the
 * `ap-parent-run-id` header above) — a `callbackUrl` naming a different run proves nothing about
 * the run this request claims as its parent, so it must not be accepted as that run's proof.
 */
function extractParentWaitpointProofFromBody({ body, parentRunId }: ExtractParentWaitpointIdFromBodyParams): ParentWaitpointProof | undefined {
    if (isNil(parentRunId)) {
        return undefined
    }
    const parsedBody = CallbackUrlBody.safeParse(body)
    if (!parsedBody.success) {
        return undefined
    }
    const { data: url } = tryCatchSync(() => new URL(parsedBody.data.callbackUrl))
    if (isNil(url)) {
        return undefined
    }
    const match = CALLBACK_URL_WAITPOINT_PATH_PATTERN.exec(url.pathname)
    if (isNil(match) || isNil(match.groups)) {
        return undefined
    }
    const parsedFlowRunId = ApId.safeParse(match.groups.flowRunId)
    const parsedWaitpointId = ApId.safeParse(match.groups.waitpointId)
    if (!parsedFlowRunId.success || !parsedWaitpointId.success || parsedFlowRunId.data !== parentRunId) {
        return undefined
    }
    if (isNil(match.groups.slotId)) {
        return { waitpointId: parsedWaitpointId.data }
    }
    const parsedSlotId = ApId.safeParse(match.groups.slotId)
    if (!parsedSlotId.success) {
        return undefined
    }
    return { waitpointId: parsedWaitpointId.data, slotId: parsedSlotId.data }
}

async function convertBody(
    request: FastifyRequest,
    projectId: string,
    flowId: string,
): Promise<unknown> {
    if (request.isMultipart()) {
        const jsonResult: Record<string, unknown> = {}
        const requestBodyEntries = Object.entries(
            request.body as Record<string, unknown>,
        )

        const platformId = await projectService(request.log).getPlatformId(projectId)

        for (const [key, value] of requestBodyEntries) {
            if (isMultipartFile(value)) {
                jsonResult[key] = await saveMultipartFileAsUrl({
                    file: value,
                    request,
                    flowId,
                    projectId,
                    platformId,
                })
            }
            else if (Array.isArray(value) && value.every(isMultipartFile)) {
                jsonResult[key] = await Promise.all(value.map((file) => saveMultipartFileAsUrl({
                    file,
                    request,
                    flowId,
                    projectId,
                    platformId,
                })))
            }
            else {
                jsonResult[key] = value
            }
        }
        return jsonResult
    }
    const contentType = request.headers['content-type']
    if (isBinaryContentType(contentType) && Buffer.isBuffer(request.body)) {
        const platformId = await projectService(request.log).getPlatformId(projectId)
        const extension = mime.extension(contentType?.split(';')[0] || '') || 'bin'
        const fileName = `file.${extension}`

        const url = await saveStepFileAndConstructUrl({
            log: request.log,
            data: request.body,
            fileName,
            flowId,
            contentLength: request.body.length,
            platformId,
            projectId,
        })
        return {
            fileUrl: url,
        }
    }

    return request.body
}

async function saveMultipartFileAsUrl(params: SaveMultipartFileAsUrlParams): Promise<string> {
    const { file, request, flowId, projectId, platformId } = params
    return saveStepFileAndConstructUrl({
        log: request.log,
        data: file.data,
        fileName: file.filename,
        flowId,
        contentLength: file.data.length,
        platformId,
        projectId,
    })
}

async function saveStepFileAndConstructUrl(params: SaveStepFileParams): Promise<string> {
    const { log, data, fileName, flowId, contentLength, platformId, projectId } = params
    const file = await fileService(log).save({
        data,
        metadata: { stepName: 'trigger', flowId },
        fileName,
        type: FileType.FLOW_STEP_FILE,
        compression: FileCompression.NONE,
        projectId,
        platformId,
        size: contentLength,
    })
    return filesService.constructReadUrl({
        fileId: file.id,
        fileType: FileType.FLOW_STEP_FILE,
        platformId,
    })
}

type ExtractParentWaitpointIdFromBodyParams = {
    body: unknown
    parentRunId: string | undefined
}

type ParentWaitpointProof = {
    waitpointId: string
    slotId?: string
}

type SaveMultipartFileAsUrlParams = {
    file: ApMultipartFile
    request: FastifyRequest
    flowId: string
    projectId: string
    platformId: string
}

type SaveStepFileParams = {
    log: FastifyBaseLogger
    data: Buffer
    fileName: string
    flowId: string
    contentLength: number
    platformId: string
    projectId: string
}
