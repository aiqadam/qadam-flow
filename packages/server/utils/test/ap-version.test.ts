import fs from 'node:fs'
import path from 'node:path'
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
    vi.useRealTimers()
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

    it('falls back to 0.0.0 when the tag is not a parseable version (e.g. a stray "v1.2" release tag)', async () => {
        getMock.mockResolvedValue({ data: { tag_name: 'v1.2' } })
        const { apVersionUtil } = await import('../src/ap-version')
        expect(await apVersionUtil.getLatestRelease()).toBe('0.0.0')
    })

    it('falls back to 0.0.0 when the tag is a non-semver ref (e.g. a "nightly" tag), which would otherwise crash semver.gte in the UI', async () => {
        getMock.mockResolvedValue({ data: { tag_name: 'nightly' } })
        const { apVersionUtil } = await import('../src/ap-version')
        expect(await apVersionUtil.getLatestRelease()).toBe('0.0.0')
    })

    it('caches a resolved version across calls instead of refetching', async () => {
        getMock.mockResolvedValue({ data: { tag_name: 'v1.1.0' } })
        const { apVersionUtil } = await import('../src/ap-version')
        await apVersionUtil.getLatestRelease()
        await apVersionUtil.getLatestRelease()
        expect(getMock).toHaveBeenCalledTimes(1)
    })

    it('caches a failure too, so an unauthenticated /v1/flags poll cannot hammer a rate-limited endpoint', async () => {
        getMock.mockRejectedValue(new Error('boom'))
        const { apVersionUtil } = await import('../src/ap-version')
        await apVersionUtil.getLatestRelease()
        await apVersionUtil.getLatestRelease()
        await apVersionUtil.getLatestRelease()
        expect(getMock).toHaveBeenCalledTimes(1)
    })

    it('retries after the failure cache TTL expires and recovers on a later success', async () => {
        vi.useFakeTimers()
        getMock.mockRejectedValueOnce(new Error('boom'))
        const { apVersionUtil } = await import('../src/ap-version')

        expect(await apVersionUtil.getLatestRelease()).toBe('0.0.0')
        expect(getMock).toHaveBeenCalledTimes(1)

        vi.advanceTimersByTime(14 * 60 * 1000)
        expect(await apVersionUtil.getLatestRelease()).toBe('0.0.0')
        expect(getMock).toHaveBeenCalledTimes(1)

        vi.advanceTimersByTime(2 * 60 * 1000)
        getMock.mockResolvedValueOnce({ data: { tag_name: 'v1.1.0' } })
        expect(await apVersionUtil.getLatestRelease()).toBe('1.1.0')
        expect(getMock).toHaveBeenCalledTimes(2)
    })
})

describe('apVersionUtil.getCurrentRelease', () => {
    it('reads the version out of the working directory package.json', async () => {
        const { apVersionUtil } = await import('../src/ap-version')
        const packageJsonContents: unknown = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8'))
        const expectedVersion = typeof packageJsonContents === 'object' && packageJsonContents !== null && 'version' in packageJsonContents && typeof packageJsonContents.version === 'string'
            ? packageJsonContents.version
            : '0.0.0'
        expect(apVersionUtil.getCurrentRelease()).toBe(expectedVersion)
    })

    it('caches the result across calls', async () => {
        const { apVersionUtil } = await import('../src/ap-version')
        const first = apVersionUtil.getCurrentRelease()
        const second = apVersionUtil.getCurrentRelease()
        expect(second).toBe(first)
    })
})
