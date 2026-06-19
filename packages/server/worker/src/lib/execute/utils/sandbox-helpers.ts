import { ErrorCode, QadamFlowError } from '@aiqadam/shared'

export function isSandboxTimeout(e: unknown): boolean {
    return e instanceof QadamFlowError && e.error.code === ErrorCode.SANDBOX_EXECUTION_TIMEOUT
}
