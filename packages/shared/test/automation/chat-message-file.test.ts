import { formErrors } from '../../src/lib/form-errors'
import { SendChatMessageRequest } from '../../src/lib/automation/chat'

// #942: `file.data` used to accept any string, and `streamText` tries a string file part as a URL
// before falling back to inline data — so an attacker-controlled URL there made the API server
// fetch it with the AI SDK's own downloader, never `safeHttp`. The legitimate client only ever
// posts bare base64 (`FileReader.readAsDataURL`, split after the comma), so narrowing to that
// breaks nothing it does.
describe('SendChatMessageRequest.files[].data', () => {
    const baseFile = { name: 'a.png', mimeType: 'image/png' as const }

    it.each([
        ['short base64', 'aGVsbG8='],
        ['base64 with double padding', 'YQ=='],
    ])('accepts %s', (_label, data) => {
        const result = SendChatMessageRequest.safeParse({ content: '', files: [{ ...baseFile, data }] })

        expect(result.success).toBe(true)
    })

    it.each([
        ['an http URL', 'http://example.com/x.png'],
        ['an https URL', 'https://169.254.169.254/latest/meta-data/'],
        ['a data URI', 'data:image/png;base64,aGVsbG8='],
        ['base64 with an embedded space', 'aGVs bG8='],
        ['base64 with invalid padding placement', 'aGVsbG8=A'],
        // `readAsDataURL` always pads; an unpadded string is rejected rather than tolerated.
        ['unpadded base64', 'aGVsbG8'],
        ['empty string', ''],
    ])('rejects %s', (_label, data) => {
        const result = SendChatMessageRequest.safeParse({ content: '', files: [{ ...baseFile, data }] })

        expect(result.success).toBe(false)
        expect(result.success ? undefined : result.error.issues[0]?.message).toBe(formErrors.invalidFileData)
    })
})
