import { vi } from 'vitest'

const getMock = vi.fn()

vi.mock('../src/safe-http', () => ({
    safeHttp: {
        axios: {
            get: getMock,
        },
    },
}))

beforeEach(() => {
    vi.resetModules()
    getMock.mockReset()
})

describe('apVersionUtil.getLatestRelease', () => {
    it('strips the leading "v" from the GitHub release tag so it is comparable via semver', async () => {
        getMock.mockResolvedValue({ data: { tag_name: 'v1.1.0' } })
        const { apVersionUtil } = await import('../src/ap-version')
        expect(await apVersionUtil.getLatestRelease()).toBe('1.1.0')
    })

    it('requests the latest release of this fork, not upstream activepieces', async () => {
        getMock.mockResolvedValue({ data: { tag_name: 'v1.1.0' } })
        const { apVersionUtil } = await import('../src/ap-version')
        await apVersionUtil.getLatestRelease()
        expect(getMock).toHaveBeenCalledWith(
            'https://api.github.com/repos/aiqadam/qadam-flow/releases/latest',
            expect.objectContaining({ timeout: expect.any(Number) }),
        )
    })

    it('falls back to 0.0.0 when the response has no tag_name', async () => {
        getMock.mockResolvedValue({ data: {} })
        const { apVersionUtil } = await import('../src/ap-version')
        expect(await apVersionUtil.getLatestRelease()).toBe('0.0.0')
    })

    it('falls back to 0.0.0 when the response is a non-JSON 200 (e.g. an HTML error page)', async () => {
        getMock.mockResolvedValue({ data: '<html>not found</html>' })
        const { apVersionUtil } = await import('../src/ap-version')
        expect(await apVersionUtil.getLatestRelease()).toBe('0.0.0')
    })

    it('falls back to 0.0.0 when the request throws (network error, SSRF block, timeout, ...)', async () => {
        getMock.mockRejectedValue(new Error('boom'))
        const { apVersionUtil } = await import('../src/ap-version')
        expect(await apVersionUtil.getLatestRelease()).toBe('0.0.0')
    })

    it('caches the resolved version across calls instead of refetching', async () => {
        getMock.mockResolvedValue({ data: { tag_name: 'v1.1.0' } })
        const { apVersionUtil } = await import('../src/ap-version')
        await apVersionUtil.getLatestRelease()
        await apVersionUtil.getLatestRelease()
        expect(getMock).toHaveBeenCalledTimes(1)
    })
})
