import { FrameworkContextVersion } from '@aiqadam/qadams-framework'
import { frameworkCensusPolicy } from '../../src/app/qadams/census/framework-census-policy'

// A stand-in for a release whose engine runs only `contextVersions` — passing fewer than the
// support table lists is how a test plays a release that has retired a shim. Every census reader
// goes through `engineContextVersions()` exactly so the engine itself need not change.
export async function withEngineContextVersions({ contextVersions, run }: {
    contextVersions: FrameworkContextVersion[]
    run: () => unknown
}): Promise<void> {
    const spy = vi.spyOn(frameworkCensusPolicy, 'engineContextVersions').mockReturnValue(contextVersions)
    try {
        await run()
    }
    finally {
        spy.mockRestore()
    }
}
