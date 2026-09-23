import { createServer, IncomingMessage, Server } from 'http'
import { FlowRunStatus, QadamAction, StepOutputStatus } from '@aiqadam/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FlowExecutorContext } from '../../src/lib/handler/context/flow-execution-context'
import { qadamExecutor } from '../../src/lib/handler/qadam-executor'
import { buildQadamAction, generateMockEngineConstants } from './test-helper'

// #388 end to end: `buildQadamAction` stores `propertySettings` with `schema: undefined` — the shape
// MCP tools, REST and the engine's own AI tools write. The http qadam's `body` is a DynamicProperties
// whose form_data `fileFieldValue` is a FILE; before the fix it reached the qadam as the raw string
// and the multipart part carried nothing.
describe('qadamExecutor — FILE nested in DynamicProperties with no stored schema', () => {
    let server: Server
    let baseUrl: string
    let uploads: string[]

    beforeAll(async () => {
        server = createServer((req, res) => {
            if (req.url?.startsWith('/files/')) {
                res.statusCode = 401
                res.end('{"message":"unauthorized"}')
                return
            }
            void readBody(req).then((body) => {
                uploads.push(body)
                res.setHeader('content-type', 'application/json')
                res.end('{"ok":true}')
            })
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
        const address = server.address()
        if (address === null || typeof address === 'string') {
            throw new Error('test server failed to bind to a TCP port')
        }
        baseUrl = `http://127.0.0.1:${address.port}`
    })

    beforeEach(() => {
        uploads = []
    })

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    it('uploads the decoded bytes of a data URI', async () => {
        const result = await qadamExecutor.handle({
            action: buildFormDataUpload({ url: `${baseUrl}/upload`, fileFieldValue: 'data:text/plain;base64,aGVsbG8gZmlsZQ==' }),
            executionState: FlowExecutorContext.empty(),
            constants: generateMockEngineConstants(),
        })

        expect(result.verdict).toStrictEqual({ status: FlowRunStatus.RUNNING })
        expect(uploads).toHaveLength(1)
        expect(uploads[0]).toContain('filename="unknown.txt"')
        expect(uploads[0]).toContain('hello file')
    }, 30000)

    it('fails the step, not the run, when the file URL answers non-2xx — and keeps the token out of the message', async () => {
        const result = await qadamExecutor.handle({
            action: buildFormDataUpload({ url: `${baseUrl}/upload`, fileFieldValue: `${baseUrl}/files/abc?token=secret-jwt` }),
            executionState: FlowExecutorContext.empty(),
            constants: generateMockEngineConstants(),
        })

        const verdict = result.verdict
        expect(verdict.status).toBe(FlowRunStatus.FAILED)
        if (verdict.status !== FlowRunStatus.FAILED) {
            throw new Error('Expected a FAILED verdict')
        }
        expect(result.steps.upload.status).toBe(StepOutputStatus.FAILED)
        expect(verdict.failedStep.message).toContain(`Failed to download file from ${baseUrl}/…/abc: HTTP 401`)
        expect(verdict.failedStep.message).not.toContain('secret-jwt')
        expect(uploads).toHaveLength(0)
    }, 30000)
})

function buildFormDataUpload({ url, fileFieldValue }: { url: string, fileFieldValue: string }): QadamAction {
    return buildQadamAction({
        name: 'upload',
        qadamName: '@aiqadam/qadam-http',
        actionName: 'send_request',
        input: {
            url,
            method: 'POST',
            headers: {},
            queryParams: {},
            body_type: 'form_data',
            body: {
                data: [{ fieldName: 'document', fieldType: 'file', fileFieldValue }],
            },
        },
    })
}

async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
        chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks).toString('utf8')
}
