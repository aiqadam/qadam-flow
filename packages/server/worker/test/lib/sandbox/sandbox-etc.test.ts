import { beforeEach, describe, expect, it, vi } from 'vitest'

const readFileMock = vi.fn()
const mkdirMock = vi.fn()
const chmodMock = vi.fn()
const writeFileAtomicMock = vi.fn()

vi.mock('node:fs/promises', () => ({
    readFile: (...args: unknown[]) => readFileMock(...args),
    mkdir: (...args: unknown[]) => mkdirMock(...args),
    chmod: (...args: unknown[]) => chmodMock(...args),
}))

vi.mock('write-file-atomic', () => ({
    default: (...args: unknown[]) => writeFileAtomicMock(...args),
}))

vi.mock('node:os', () => ({
    default: { tmpdir: () => '/tmp' },
}))

const SANDBOX_RESOLV_CONF = '/tmp/qadam-flow-sandbox-etc/resolv.conf'

async function loadSandboxEtc() {
    const { sandboxEtc } = await import('../../../src/lib/sandbox/sandbox-etc')
    return sandboxEtc
}

describe('sandboxEtc', () => {
    beforeEach(() => {
        vi.resetModules()
        readFileMock.mockReset()
        mkdirMock.mockReset()
        chmodMock.mockReset()
        writeFileAtomicMock.mockReset()
        mkdirMock.mockResolvedValue(undefined)
        chmodMock.mockResolvedValue(undefined)
        writeFileAtomicMock.mockResolvedValue(undefined)
    })

    it('materialises the container\'s resolv.conf so compose service names resolve', async () => {
        readFileMock.mockResolvedValue('nameserver 127.0.0.11\noptions ndots:0\n')
        const sandboxEtc = await loadSandboxEtc()

        const dir = await sandboxEtc.ensure()

        expect(dir).toBe('/tmp/qadam-flow-sandbox-etc')
        expect(readFileMock).toHaveBeenCalledWith('/etc/resolv.conf', 'utf8')
        expect(writeFileAtomicMock).toHaveBeenCalledWith(SANDBOX_RESOLV_CONF, 'nameserver 127.0.0.11\noptions ndots:0\n', { encoding: 'utf8', mode: 0o644 })
        expect(chmodMock).toHaveBeenCalledWith('/tmp/qadam-flow-sandbox-etc', 0o755)
        expect(chmodMock).toHaveBeenCalledWith(SANDBOX_RESOLV_CONF, 0o644)
    })

    it('falls back to the baked asset when the host resolv.conf cannot be read', async () => {
        readFileMock
            .mockRejectedValueOnce(new Error('ENOENT'))
            .mockResolvedValueOnce('nameserver 8.8.8.8\nnameserver 8.8.4.4\n')
        const sandboxEtc = await loadSandboxEtc()

        await sandboxEtc.ensure()

        expect(writeFileAtomicMock).toHaveBeenCalledWith(SANDBOX_RESOLV_CONF, 'nameserver 8.8.8.8\nnameserver 8.8.4.4\n', { encoding: 'utf8', mode: 0o644 })
    })

    it('falls back to the baked asset when the host resolv.conf has no nameserver', async () => {
        readFileMock
            .mockResolvedValueOnce('# empty\n')
            .mockResolvedValueOnce('nameserver 8.8.8.8\n')
        const sandboxEtc = await loadSandboxEtc()

        await sandboxEtc.ensure()

        expect(writeFileAtomicMock).toHaveBeenCalledWith(SANDBOX_RESOLV_CONF, 'nameserver 8.8.8.8\n', { encoding: 'utf8', mode: 0o644 })
    })

    it('throws when neither the host nor the baked asset names a nameserver', async () => {
        readFileMock
            .mockResolvedValueOnce('# empty\n')
            .mockResolvedValueOnce('# also empty\n')
        const sandboxEtc = await loadSandboxEtc()

        await expect(sandboxEtc.ensure()).rejects.toThrow('No usable nameserver')
        expect(writeFileAtomicMock).not.toHaveBeenCalled()
    })

    it('materialises once per process, so a second sandbox reuses the directory', async () => {
        readFileMock.mockResolvedValue('nameserver 127.0.0.11\n')
        const sandboxEtc = await loadSandboxEtc()

        await sandboxEtc.ensure()
        await sandboxEtc.ensure()

        expect(readFileMock).toHaveBeenCalledTimes(1)
        expect(writeFileAtomicMock).toHaveBeenCalledTimes(1)
    })

    it('retries after a failed materialisation instead of memoising the rejection', async () => {
        readFileMock
            .mockRejectedValueOnce(new Error('EACCES'))
            .mockRejectedValueOnce(new Error('ENOENT'))
            .mockResolvedValue('nameserver 127.0.0.11\n')
        const sandboxEtc = await loadSandboxEtc()

        await expect(sandboxEtc.ensure()).rejects.toThrow('ENOENT')
        await expect(sandboxEtc.ensure()).resolves.toBe('/tmp/qadam-flow-sandbox-etc')
        expect(writeFileAtomicMock).toHaveBeenCalledTimes(1)
    })
})
