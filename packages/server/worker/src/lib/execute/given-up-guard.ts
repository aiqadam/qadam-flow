import { isNil, WorkerToApiContract } from '@aiqadam/shared'
import { SandboxManager } from './sandbox-manager'

/**
 * A job this worker gave up (its lease was lost, or a stop abandoned it) may already be running on
 * another worker. Nothing it does from then on may reach the API, or it would write over the copy:
 * a terminal INTERNAL_ERROR, a run log, a sync response, a child run (#585). These wrap what a job
 * handler is given, so the cut-off holds for every handler without each of them checking.
 *
 * The engine's own calls are cut off through the job context this puts on every acquire: a reused or
 * prewarmed sandbox was created with another client, so it forwards through the context's
 * `apiClient`, and `engineRunScope` refuses a call outright once `isGivenUp` is true.
 *
 * `apiClient` checks when a call is made; whoever composes it under a client that waits or resends
 * gets the check at send time too.
 */
export const givenUpGuard = {
    apiClient({ apiClient, isGivenUp }: ApiClientParams): WorkerToApiContract {
        return new Proxy(apiClient, {
            get(target, property, receiver): unknown {
                const value: unknown = Reflect.get(target, property, receiver)
                if (typeof property !== 'string' || typeof value !== 'function') {
                    return value
                }
                return async (input: unknown): Promise<unknown> => {
                    if (isGivenUp()) {
                        throw new JobGivenUpError(`RPC [${property}] not sent`)
                    }
                    return Reflect.apply(value, target, [input])
                }
            },
        })
    },
    sandboxManager({ sandboxManager, isGivenUp, apiClient }: SandboxManagerParams): SandboxManager {
        return {
            ...sandboxManager,
            // A job given up while it was still provisioning (installing qadams, waiting on the
            // shared cache lock) never gets a sandbox, fresh or prewarmed.
            acquire: (params) => {
                if (isGivenUp()) {
                    throw new JobGivenUpError('Sandbox not acquired')
                }
                const { jobContext } = params
                return sandboxManager.acquire({
                    ...params,
                    jobContext: isNil(jobContext) ? undefined : { ...jobContext, isGivenUp, apiClient },
                })
            },
        }
    },
}

export class JobGivenUpError extends Error {
    constructor(what: string) {
        super(`${what}: this worker gave the job up, it may be running elsewhere`)
        this.name = 'JobGivenUpError'
    }
}

type ApiClientParams = {
    apiClient: WorkerToApiContract
    isGivenUp: () => boolean
}

type SandboxManagerParams = {
    sandboxManager: SandboxManager
    isGivenUp: () => boolean
    /** The job's own client, which the engine's calls are forwarded through. */
    apiClient: WorkerToApiContract
}
