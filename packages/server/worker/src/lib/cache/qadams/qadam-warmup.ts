import { partition, QadamPackage, tryCatch, WorkerToApiContract } from '@aiqadam/shared'
import { Logger } from 'pino'
import { qadamInstaller } from './qadam-installer'

export const qadamWarmup = {
    warmupUsedQadams,
}

async function warmupUsedQadams({ apiClient, log }: WarmupUsedQadamsParams): Promise<void> {
    const { data: pieces, error } = await tryCatch(() => apiClient.getUsedQadams({}))
    if (error) {
        log.error({ error }, 'Failed to fetch used pieces for warmup')
        return
    }
    if (!pieces || pieces.length === 0) {
        log.info('No pieces to warm up')
        return
    }
    const installer = qadamInstaller(log, apiClient)
    // The used list is one batch for the whole workspace, and the installer refuses a batch
    // holding coordinates it cannot turn into a member directory. Setting those entries aside
    // keeps one such entry from blocking the warmup of every other qadam that shares the list.
    const [installable, refused] = partition(pieces, (piece) => installer.hasInstallableCoordinates(piece))
    if (refused.length > 0) {
        log.warn({ refused: refused.map(describeCoordinates) }, 'Skipping used pieces whose name or version is outside the installable grammar')
    }
    if (installable.length === 0) {
        log.info('No installable pieces to warm up')
        return
    }
    log.info({ count: installable.length }, 'Starting piece cache warmup')
    const { error: installError } = await tryCatch(() =>
        // Filtered, like the provisioner's install: without `--filter`, bun installs every
        // workspace in the shared cache, and it does so while holding the cross-replica
        // fileLock that job provisioning also waits on. That was inert while the workspaces
        // glob matched nothing; it is not any more.
        installer.install({ pieces: installable, includeFilters: true }),
    )
    if (installError) {
        log.error({ error: installError }, 'Failed to install pieces during startup warmup')
    }
    else {
        void tryCatch(() => apiClient.markQadamAsUsed({ pieces: installable }))
    }
    log.info({ count: installable.length }, 'Piece cache warmup complete')
}

function describeCoordinates(piece: QadamPackage): { qadamName: string, qadamVersion: string } {
    return { qadamName: piece.qadamName, qadamVersion: piece.qadamVersion }
}

type WarmupUsedQadamsParams = {
    apiClient: WorkerToApiContract
    log: Logger
}
