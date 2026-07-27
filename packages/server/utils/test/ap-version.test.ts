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

    it.each([
        ['v1.2', 'a stray non-3-segment release tag'],
        ['nightly', 'a non-numeric ref'],
        ['01.2.3', 'a leading zero on the major segment'],
        ['00.0.0', 'a leading zero on every segment'],
        ['1.02.3', 'a leading zero on the minor segment'],
        ['1.2.03', 'a leading zero on the patch segment'],
        ['2026.07.1', 'a CalVer-style date tag'],
        ['1.2.3-01', 'a leading zero in a numeric prerelease identifier'],
        ['1.2.3-alpha..1', 'an empty prerelease identifier between dots'],
        ['1.2.3-alpha.', 'a trailing empty prerelease identifier'],
        ['1.2.3-.', 'a lone empty prerelease identifier'],
        ['1.2.3+build..1', 'an empty build-metadata identifier between dots'],
        ['999999999999999999999.1.1', 'a major segment beyond the safe integer range'],
    ])(
        'falls back to 0.0.0 for a tag that is not valid semver: %s (%s) — this would otherwise crash semver.gte in the UI',
        async (tagName) => {
            getMock.mockResolvedValue({ data: { tag_name: tagName } })
            const { apVersionUtil } = await import('../src/ap-version')
            expect(await apVersionUtil.getLatestRelease()).toBe('0.0.0')
        },
    )

    it.each([
        ['v1.1.0', '1.1.0'],
        ['1.2.3-alpha.1', '1.2.3-alpha.1'],
        ['1.2.3-0.3.7', '1.2.3-0.3.7'],
        ['1.2.3-beta+exp.sha.5114f85', '1.2.3-beta'],
        ['1.2.3----', '1.2.3----'],
        ['1.2.3-0A.is.legal', '1.2.3-0A.is.legal'],
    ])('accepts a genuinely valid semver tag: %s', async (tagName, expected) => {
        getMock.mockResolvedValue({ data: { tag_name: tagName } })
        const { apVersionUtil } = await import('../src/ap-version')
        expect(await apVersionUtil.getLatestRelease()).toBe(expected)
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
