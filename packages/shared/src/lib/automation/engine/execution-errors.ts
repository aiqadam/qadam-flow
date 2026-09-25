import { STORE_KEY_MAX_LENGTH } from '../../core/store-entry/store-entry'

export enum ExecutionErrorType {
    ENGINE = 'ENGINE',
    USER = 'USER',
}
export class ExecutionError extends Error {

    public type: ExecutionErrorType

    constructor(name: string, message: string, type: ExecutionErrorType, public override cause?: unknown) {
        super(message)
        this.name = name
        this.type = type
    }
}

function formatMessage(message: string) {
    return JSON.stringify({
        message,
    }, null, 2)
}



export class ConnectionNotFoundError extends ExecutionError {
    constructor(connectionName: string, cause?: unknown) {
        super('ConnectionNotFound', formatMessage(`connection (${connectionName}) not found`), ExecutionErrorType.USER, cause)
    }
}

export class ConnectionLoadingError extends ExecutionError {
    constructor(connectionName: string, cause?: unknown) {
        super('ConnectionLoadingFailure', formatMessage(`Failed to load connection (${connectionName})`), ExecutionErrorType.USER, cause)
    }
}

export class ConnectionExpiredError extends ExecutionError {
    constructor(connectionName: string, cause?: unknown) {
        super('ConnectionExpired', formatMessage(`connection (${connectionName}) expired, reconnect again`), ExecutionErrorType.USER, cause)
    }
}

export class StorageLimitError extends ExecutionError {

    public maxStorageSizeInBytes: number

    constructor(key: string, maxStorageSizeInBytes: number, cause?: unknown) {
        super('StorageLimitError', formatMessage(`Failed to read/write key "${key}", the value you are trying to read/write is larger than ${Math.floor(maxStorageSizeInBytes / 1024)} KB`), ExecutionErrorType.USER, cause)
        this.maxStorageSizeInBytes = maxStorageSizeInBytes
    }
}

export class StorageInvalidKeyError extends ExecutionError {
    constructor(key: string, cause?: unknown) {
        super('StorageInvalidKeyError', formatMessage(`Failed to read/write key "${key}", the key is empty or longer than ${STORE_KEY_MAX_LENGTH} characters`), ExecutionErrorType.USER, cause)
    }
}

export class StorageError extends ExecutionError {
    constructor(key: string, cause?: unknown) {
        super('StorageError', formatMessage(`Failed to read/write key "${key}" due to ${JSON.stringify(cause)}`), ExecutionErrorType.ENGINE, cause)
    }
}

export class FileStoreError extends ExecutionError {
    constructor(cause?: unknown) {
        super('FileStoreError', formatMessage(`Failed to store file due to ${JSON.stringify(cause)}`), ExecutionErrorType.ENGINE, cause)
    }
}

export class PausedFlowTimeoutError extends ExecutionError {
    constructor(cause?: unknown, maximumPauseDurationDays?: number) {
        super('PausedFlowTimeoutError', `The flow cannot be paused for more than ${maximumPauseDurationDays} days`, ExecutionErrorType.USER, cause)
    }
}

export class FileSizeError extends ExecutionError {
    constructor(currentFileSize: number, maximumSupportSize: number, cause?: unknown) {
        super('FileSizeError', JSON.stringify({
            message: 'File size is larger than maximum supported size',
            currentFileSize: `${currentFileSize} MB`,
            maximumSupportSize: `${maximumSupportSize} MB`,
        }), ExecutionErrorType.USER, cause)
    }
}

export class FetchError extends ExecutionError {
    constructor(url: string, cause?: unknown) {
        super('FetchError', formatMessage(`Failed to fetch from ${url}`), ExecutionErrorType.ENGINE, cause)
    }
}

export class InvalidCronExpressionError extends ExecutionError {
    constructor(cronExpression: string, cause?: unknown) {
        super('InvalidCronExpressionError', formatMessage(`Invalid cron expression: ${cronExpression}`), ExecutionErrorType.USER, cause)
    }
}

export class FormulaEvaluationError extends ExecutionError {
    constructor({ expression, message, cause }: { expression: string, message: string, cause?: unknown }) {
        super('FormulaEvaluationError', formatMessage(`Formula error: ${message} (expression: ${expression})`), ExecutionErrorType.USER, cause)
    }
}

// USER, not ENGINE: a name that does not exist is an authoring mistake, and an ENGINE error
// escapes every step handler and fails the whole run as INTERNAL_ERROR with no step list, so the
// author had nothing pointing at the step that referenced it (#392).
export class VariableNotFoundError extends ExecutionError {
    constructor(name: string, cause?: unknown) {
        super('VariableNotFound', formatMessage(`project variable (${name}) not found — check the name in Settings → Variables, or create it`), ExecutionErrorType.USER, cause)
    }
}

// USER, mirroring VariableNotFoundError: a `$t['key']` naming a key that does not exist at all, or
// one that has no value in the resolved default locale (the last link in the resolution chain), is
// an authoring mistake that must fail the step rather than the whole run.
export class TranslationKeyNotFoundError extends ExecutionError {
    constructor({ key, cause }: { key: string, cause?: unknown }) {
        super('TranslationKeyNotFound', formatMessage(`translation key (${key}) not found, or has no value in the default locale — check the key in Settings → Translations, or create it`), ExecutionErrorType.USER, cause)
    }
}

// `{{VAR}}` is not a project variable reference: the short form is evaluated against the run's
// step outputs, finds no such name, and used to resolve to an empty string. An empty string is a
// valid value everywhere, so the mistake surfaced as wrong data rather than as an error — and
// where the value was key material, as an HMAC keyed with `""` that still verified against itself.
export class UnresolvedTemplateReferenceError extends ExecutionError {
    constructor({ expression, reference, cause }: { expression: string, reference?: string, cause?: unknown }) {
        super('UnresolvedTemplateReference', formatMessage(buildUnresolvedReferenceMessage({ expression, reference })), ExecutionErrorType.USER, cause)
    }
}

// Without a `reference` the expression did declare a context root — `variables[…]` or
// `connections[…]` — and then named nothing readable inside it, which is the same mistake one level
// further in and deserves the syntax rather than a name it cannot quote back.
function buildUnresolvedReferenceMessage({ expression, reference }: { expression: string, reference?: string }): string {
    if (reference === undefined) {
        return `{{${expression}}} does not name anything this run can read. A project variable is written {{variables['NAME']}}, a connection {{connections['NAME']}} and a translation {{$t['key']}}, with the exact name in quotes.`
    }
    return `"${reference}" is not defined (in {{${expression}}}). It is neither a step in this flow nor a built-in. To read a project variable use {{variables['${reference}']}}; to read a translation use {{$t['key']}}; to read a step's output use {{stepName['output'].field}}.`
}

export class EngineGenericError extends ExecutionError {
    constructor(name: string, message: string, cause?: unknown) {
        super(name, formatMessage(message), ExecutionErrorType.ENGINE, cause)
    }
}

export class SSRFBlockedError extends ExecutionError {
    constructor({ host, ip, cause }: { host: string, ip: string, cause?: unknown }) {
        super(
            'SSRFBlockedError',
            formatMessage(`SSRF protection: refusing to connect to ${host} (resolved ${ip}) — private, loopback, link-local, or multicast address`),
            ExecutionErrorType.USER,
            cause,
        )
    }
}