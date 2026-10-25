import { ChildProcess, spawn } from 'node:child_process'
import { CodeSandbox } from '../../core/code/code-sandbox-common'

// The runner is long-lived: it serves the CODE steps of one engine operation (one job)
// instead of being spawned per execution. `spawn` of a Node process costs ~56 ms on a
// warm host and dominated the ~71 ms per-CODE-step floor issue #421 measured; the IPC
// round-trip replacing it costs ~1.6 ms.
//
// Reuse is only safe while an execution leaves nothing behind. A fresh process used to
// guarantee that by dying. Three mechanisms stand in for it:
//
//   - the whole require cache is cleared before each execution, so every execution gets
//     a fresh module graph;
//   - async resources created during an execution and still alive after it are detected
//     with `async_hooks`, and the runner then exits rather than serving another step.
//     Leaky code pays the spawn it used to pay anyway; clean code keeps the win;
//   - `uncaughtException` / `unhandledRejection` fail the in-flight execution and exit,
//     saying so with `terminal` even when nothing is in flight, so the parent never
//     dispatches to a process that has already started dying.
//
// The leftover detection is **best-effort, not an enforced invariant**, and its gap is
// specific. `PIPEWRAP`, `WRITEWRAP` and `SHUTDOWNWRAP` are excluded because the runner's
// own stdout/stderr plumbing surfaces as all three the moment a write cannot complete
// synchronously — without that, any step logging more than a trickle would be read as
// leaky and respawn, which is most of the win. Two things escape through that exclusion,
// both reproduced: an open unix-domain *client* socket (a unix **server** is caught, as
// `PIPESERVERWRAP`), and a pending `process.stdout.write(data, callback)` whose callback
// throws. Either can fire during a later step of the same job and fail it with an error
// that names the earlier step. Plain `console.log` passes no callback and cannot.
//
// It is also not a boundary against deliberate code: user code shares this process with
// the hook and can sidestep it outright. Nothing is lost by that in either mode this
// sandbox serves (`code-sandbox.ts` maps both UNSANDBOXED and SANDBOX_PROCESS to it) —
// evading the check only affects later steps of the same job, which is the same flow run
// of the same project, and under UNSANDBOXED such code already has full host privileges
// anyway. It is, though, why "best-effort" is the honest phrasing.
//
// Everything that reaches user code by its own scheduling is caught: timers (ref'd and
// `unref()`'d alike — `unref` is why `process.getActiveResourcesInfo()` was not enough,
// since it only reports what keeps the loop alive), TCP sockets, servers, fs watchers,
// workers, message ports, and child processes via `PROCESSWRAP`.
//
// Consequence worth knowing before quoting the speed-up: a step that makes a **network
// call** leaves a keep-alive socket in the agent pool, which is a leftover by this
// definition, so it respawns every time and gains nothing. The win is for compute steps.
// Such a step is no worse off than before — it pays the spawn it always paid.
//
// Not restored between executions of one job, and a real behaviour change rather than a
// preserved semantic: `globalThis`, `process.env`, mutated builtins, and listeners added
// to `process` — including on the IPC channel, which is where a later step's resolved
// inputs cross. A job is one flow run of one project, so none of it crosses a tenant
// boundary, but it did not exist when every step had its own process.
//
// `disconnect` is the backstop for the parent dying without running its teardown —
// `main.ts` turns an uncaught engine exception straight into `process.exit`, which would
// otherwise leave this process orphaned and still executing the tenant's code.
const LEFTOVER_SETTLE_TURNS = 3

// Half of the 256 KiB `ERROR_OFFSET` budget `helper/logging-utils.ts` reserves for an
// error message, applied per stream, so stdout and stderr together stay the same order
// as that reserve instead of growing without bound — multiplied across the child buffer,
// the JSON IPC payload and the host's own copy (app-sec, #609). Measured in UTF-16 code
// units (`String#length`, `String#slice`), so a non-ASCII stream can encode to a few
// times this many bytes; the cap exists to bound the multiplication, not to be
// byte-exact. The tail is kept rather than the head: the lines immediately before the
// failure are the diagnostics worth paying for.
const MAX_CAPTURED_OUTPUT_CODE_UNITS = 128 * 1024

const CODE_RUNNER_SCRIPT = `
const asyncHooks = require('async_hooks')
const inspect = require('util').inspect
let inFlightId = null

// Captured here, synchronously at the write call, rather than left to the parent's
// 'data' listener on the stdio pipes: a pipe write is async on Linux, so its 'data'
// event can reach the parent after the IPC 'message' carrying the verdict already did,
// which would silently drop the tail of a failing step's output (#609). Capturing at
// the call site has no such race — by the time \`mod.code()\` returns, everything it
// wrote is already in the buffer. Capped so the buffer, the IPC frame built from it, and
// the resulting error message can't grow unbounded, which also keeps \`stdoutBuf += ...\`
// under V8's string-length ceiling — a direct \`process.stdout.write\` of enough data
// would otherwise hit that ceiling before \`realStdoutWrite\` ever ran.
const MAX_CAPTURED_OUTPUT_CODE_UNITS = ${MAX_CAPTURED_OUTPUT_CODE_UNITS}
// Appending is a rope concat in O(1); the copy to drop the head is paid only once the
// rope passes twice the cap, which amortises it over a whole cap's worth of writes. A
// chatty step logging 100-byte lines must not copy 128 K on every single line.
function tailCapped(text) {
    if (text.length <= MAX_CAPTURED_OUTPUT_CODE_UNITS) return text
    const start = text.length - MAX_CAPTURED_OUTPUT_CODE_UNITS
    // A tail cut through a surrogate pair would start with a lone low surrogate.
    const lowSurrogate = text.charCodeAt(start)
    return lowSurrogate >= 0xDC00 && lowSurrogate <= 0xDFFF ? text.slice(start + 1) : text.slice(start)
}
function decodeChunk(chunk) {
    if (typeof chunk === 'string') {
        return chunk.length > MAX_CAPTURED_OUTPUT_CODE_UNITS * 4 ? chunk.slice(-MAX_CAPTURED_OUTPUT_CODE_UNITS * 4) : chunk
    }
    // Slice the bytes before decoding: \`buf + chunk.toString()\` on a non-Buffer
    // Uint8Array yields its numbers ("104,101,..."), not its text, and decoding a huge
    // buffer first would defeat the cap's memory bound. UTF-8 needs at most four bytes
    // per code unit, so a bounded byte tail is enough to fill the code-unit budget.
    const byteBudget = MAX_CAPTURED_OUTPUT_CODE_UNITS * 4
    const bytes = chunk.byteLength > byteBudget ? chunk.subarray(chunk.byteLength - byteBudget) : chunk
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString()
}
function appendCapped(buf, chunk) {
    const next = buf + decodeChunk(chunk)
    return next.length > MAX_CAPTURED_OUTPUT_CODE_UNITS * 2 ? tailCapped(next) : next
}
let stdoutBuf = ''
let stderrBuf = ''
const realStdoutWrite = process.stdout.write.bind(process.stdout)
const realStderrWrite = process.stderr.write.bind(process.stderr)
process.stdout.write = (chunk, ...args) => {
    stdoutBuf = appendCapped(stdoutBuf, chunk)
    return realStdoutWrite(chunk, ...args)
}
process.stderr.write = (chunk, ...args) => {
    stderrBuf = appendCapped(stderrBuf, chunk)
    return realStderrWrite(chunk, ...args)
}

process.on('disconnect', () => process.exit(0))

const liveResources = new Set()
asyncHooks.createHook({
    init(asyncId, type) {
        if (type === 'PROMISE' || type === 'TickObject' || type === 'Microtask') return
        if (type === 'PIPEWRAP' || type === 'WRITEWRAP' || type === 'SHUTDOWNWRAP') return
        liveResources.add(asyncId)
    },
    destroy(asyncId) { liveResources.delete(asyncId) },
}).enable()

function failInFlight(error) {
    const id = inFlightId
    inFlightId = null
    process.send({ id: id === null ? -1 : id, success: false, error, stdout: tailCapped(stdoutBuf), stderr: tailCapped(stderrBuf), terminal: true }, () => process.exit(1))
}

process.on('unhandledRejection', (reason) => failInFlight(inspect(reason)))
process.on('uncaughtException', (err) => failInFlight(inspect(err)))

function leftBehind({ baseline, ownYields }) {
    for (const asyncId of liveResources) {
        if (!baseline.has(asyncId) && !ownYields.has(asyncId)) return true
    }
    return false
}

process.on('message', async function(msg) {
    inFlightId = msg.id
    stdoutBuf = ''
    stderrBuf = ''
    const baseline = new Set(liveResources)
    let outcome

    try {
        for (const cached of Object.keys(require.cache)) {
            delete require.cache[cached]
        }

        const mod = require(msg.codeFilePath)
        const result = await mod.code(msg.inputs)
        outcome = { id: msg.id, success: true, result: JSON.parse(JSON.stringify(result ?? null)) }
    } catch(e) {
        outcome = { id: msg.id, success: false, error: inspect(e) }
    }

    // Yield so unhandledRejection fires before we report success.
    const ownYields = new Set()
    await new Promise(resolve => setImmediate(() => { ownYields.add(asyncHooks.executionAsyncId()); resolve() }))

    // Extra turns are spent only once something already looks left over: libuv destroys a
    // handle the step closed properly in its close phase, which can land one or more turns
    // after the first check and would otherwise cost a needless respawn. One turn cleared
    // this ~90 % of the time and three made it reliable. A clean step never pays for any of
    // them, and each is a whole timer phase (~1 ms) — most of a clean execution's cost.
    let leftover = leftBehind({ baseline, ownYields })
    for (let settle = 0; leftover && settle < ${LEFTOVER_SETTLE_TURNS}; settle++) {
        await new Promise(resolve => setTimeout(() => { ownYields.add(asyncHooks.executionAsyncId()); resolve() }, 0))
        leftover = leftBehind({ baseline, ownYields })
    }

    if (inFlightId !== msg.id) return
    inFlightId = null

    // Read live, not snapshotted in the catch above: the yield and settle turns just spent
    // can themselves run more of the failing step's own queued callbacks, and anything they
    // write still belongs to this verdict.
    if (!outcome.success) {
        outcome.stdout = tailCapped(stdoutBuf)
        outcome.stderr = tailCapped(stderrBuf)
    }

    if (leftover) {
        process.send(Object.assign({ terminal: true }, outcome), () => process.exit(0))
        return
    }
    process.send(outcome)
})
`

const SHUTDOWN_CLOSE_WAIT_MS = 2000

let runner: Runner | null = null
let lastExecutionId = 0
// Every executor path in the engine is sequential today — `loop-executor.ts` is a `for`
// with an `await`, `router-executor.ts` likewise, and no handler uses `Promise.all` — so
// serialising costs nothing. It leaves exactly one in-flight execution, which is what
// lets the crash handlers name the execution they are failing.
let executionQueue: Promise<unknown> = Promise.resolve()

// Mirrors the runner's cap, including its tail-preserving direction and amortised trim,
// so the pipe copy stays comparable to the IPC capture instead of being cut at a
// different point or copying the whole buffer on every `data` event.
function tailCapped(text: string): string {
    if (text.length <= MAX_CAPTURED_OUTPUT_CODE_UNITS) {
        return text
    }
    const start = text.length - MAX_CAPTURED_OUTPUT_CODE_UNITS
    const lowSurrogate = text.charCodeAt(start)
    return lowSurrogate >= 0xDC00 && lowSurrogate <= 0xDFFF ? text.slice(start + 1) : text.slice(start)
}

function appendCapped({ buffer, chunk }: { buffer: string, chunk: string }): string {
    const next = buffer + chunk
    return next.length > MAX_CAPTURED_OUTPUT_CODE_UNITS * 2 ? tailCapped(next) : next
}

function startRunner(): Runner {
    const child = spawn(process.execPath, ['--eval', CODE_RUNNER_SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    })
    const started: Runner = { child, inFlight: null, usable: true }

    child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString()
        if (started.inFlight) {
            started.inFlight.stdout = appendCapped({ buffer: started.inFlight.stdout, chunk: text })
        }
        console.log(text.trimEnd())
    })

    child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString()
        if (started.inFlight) {
            started.inFlight.stderr = appendCapped({ buffer: started.inFlight.stderr, chunk: text })
        }
        console.error(text.trimEnd())
    })

    child.on('message', (message) => {
        if (!isRunnerMessage(message)) {
            return
        }
        const execution = takeInFlight({ runner: started, id: message.id })
        // Honoured even when the id matched nothing: that is the runner reporting a crash
        // it took with nothing in flight, and it is already exiting. Gating this on the id
        // would leave `usable` true on a process inside `process.exit`.
        if (message.terminal) {
            retire(started)
        }
        if (!execution) {
            return
        }
        if (message.success) {
            execution.resolve(message.result)
        }
        else {
            execution.reject(buildError({
                message: message.error,
                stdout: pickMoreComplete({ messageValue: message.stdout, pipeValue: tailCapped(execution.stdout) }),
                stderr: pickMoreComplete({ messageValue: message.stderr, pipeValue: tailCapped(execution.stderr) }),
            }))
        }
    })

    // 'close' rather than 'exit': it fires once stdio is drained, so a failure caused by
    // user code calling process.exit() still carries whatever that code logged first.
    child.on('close', (code, signal) => {
        retire(started)
        const execution = started.inFlight
        started.inFlight = null
        if (execution) {
            execution.reject(buildError({ message: `Code process exited with code ${code} and signal ${signal}`, stdout: tailCapped(execution.stdout), stderr: tailCapped(execution.stderr) }))
        }
    })

    child.on('error', (error) => {
        retire(started)
        const execution = started.inFlight
        started.inFlight = null
        if (execution) {
            execution.reject(buildError({ message: error.message, stdout: tailCapped(execution.stdout), stderr: tailCapped(execution.stderr) }))
        }
    })

    return started
}

// Retiring must KILL, not just forget. Dropping the reference alone would leave a live
// process no teardown path can reach — `shutdown()` only sees whatever `runner` currently
// points at — still running the tenant's code and still piping its stdout into whichever
// operation the engine has moved on to.
function retire(target: Runner): void {
    target.usable = false
    if (runner === target) {
        runner = null
    }
    if (target.child.exitCode === null && target.child.signalCode === null) {
        target.child.kill('SIGKILL')
    }
}

function takeInFlight({ runner: target, id }: { runner: Runner, id: number }): InFlightExecution | null {
    const execution = target.inFlight
    if (!execution || execution.id !== id) {
        return null
    }
    target.inFlight = null
    return execution
}

function isRunnerMessage(message: unknown): message is RunnerMessage {
    if (typeof message !== 'object' || message === null) {
        return false
    }
    const candidate: Record<string, unknown> = { ...message }
    // `stdout`/`stderr` are read with `.trim()` below, and the message a runner sends is
    // tenant-authored-code-reachable (`process.send` is as forgeable as the existing
    // `forgeTerminal` test already proves) — a non-string value here must not reach
    // `buildError` and crash the host with an uncaught `TypeError`. The cap matches the
    // runner's own, so an honest message always passes and an oversized forged one is
    // ignored rather than retained in the host's error.
    const isCapturedOutput = (value: unknown): boolean => value === undefined
        || (typeof value === 'string' && value.length <= MAX_CAPTURED_OUTPUT_CODE_UNITS)
    return typeof candidate.id === 'number'
        && typeof candidate.success === 'boolean'
        && (candidate.error === undefined || typeof candidate.error === 'string')
        && isCapturedOutput(candidate.stdout)
        && isCapturedOutput(candidate.stderr)
}

function dispatchToRunner({ codeFilePath, inputs }: { codeFilePath: string, inputs: Record<string, unknown> }): Promise<unknown> {
    return new Promise((resolve, reject) => {
        if (runner === null || !runner.usable) {
            runner = startRunner()
        }
        const target = runner
        const id = ++lastExecutionId
        target.inFlight = { id, resolve, reject, stdout: '', stderr: '' }

        target.child.send({ id, codeFilePath, inputs }, (error) => {
            if (!error) {
                return
            }
            retire(target)
            const execution = takeInFlight({ runner: target, id })
            if (execution) {
                execution.reject(buildError({ message: error.message, stdout: tailCapped(execution.stdout), stderr: tailCapped(execution.stderr) }))
            }
        })
    })
}

// Serialised so at most one execution is in flight, which is what makes stdout
// attribution and crash reporting unambiguous.
function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const settled = executionQueue.then(task, task)
    executionQueue = settled.then(() => undefined, () => undefined)
    return settled
}

// The runner's own capture (`messageValue`) only sees output written through
// `process.stdout`/`stderr.write`, so it misses `fs.writeSync(1, ...)` and a grandchild
// spawned with `stdio: 'inherit'` — both still land on the real fd and so still reach the
// host's pipe-accumulated `pipeValue`. Take the pipe copy only when it is the IPC capture
// plus extra bytes, or when the capture is empty (fd-only output): a pipe copy that does
// not start with the capture may carry a previous execution's late-delivered tail — the
// very race #609 is about — which must not be attributed to this execution. Content
// alone cannot tell such a stale prefix from fd-only output written before the step's
// first `process.stdout` write, so that prefix is dropped; the alternative is leaking
// another step's output into this one's error.
function pickMoreComplete({ messageValue, pipeValue }: { messageValue: string | undefined, pipeValue: string }): string {
    const fromMessage = messageValue ?? ''
    if (!fromMessage) {
        return pipeValue
    }
    return pipeValue.startsWith(fromMessage) ? pipeValue : fromMessage
}

function buildError({ message, stdout, stderr }: { message: string | undefined, stdout: string, stderr: string }): Error {
    // `message` reaches here from tenant code (`inspect(e)`) or a forged IPC frame and had
    // no size bound before the captures did; bound it on the same budget, keeping the head
    // because that is where the error type and the first stack frames live (app-sec, #609).
    const parts: string[] = [(message ?? 'Code execution failed').slice(0, MAX_CAPTURED_OUTPUT_CODE_UNITS)]
    if (stdout.trim()) {
        parts.push(`\n--- stdout ---\n${stdout.trim()}`)
    }
    if (stderr.trim()) {
        parts.push(`\n--- stderr ---\n${stderr.trim()}`)
    }
    return new Error(parts.join(''))
}

export const noOpCodeSandbox: CodeSandbox = {
    async runCodeModule({ codeFilePath, inputs }) {
        return enqueue(() => dispatchToRunner({ codeFilePath, inputs }))
    },

    async runScript({ script, scriptContext, functions }) {
        const newContext = {
            ...scriptContext,
            ...functions,
        }
        const params = Object.keys(newContext)
        const args = Object.values(newContext)
        const body = `return (${script})`
        const fn = Function(...params, body)
        return fn(...args)
    },

    // Called at the end of every engine operation. The runner must not outlive the job:
    // engine processes are reused across jobs — and therefore across projects — whenever
    // `canReuseSandbox()` is true, which includes the UNSANDBOXED default
    // (`sandbox-manager.ts:79`). A runner that survived would carry one tenant's
    // `globalThis` and leftover timers into the next tenant's code.
    async shutdown() {
        const target = runner
        runner = null
        if (target === null) {
            return
        }
        retire(target)
        await new Promise<void>((resolve) => {
            if (target.child.exitCode !== null || target.child.signalCode !== null) {
                resolve()
                return
            }
            // SIGKILL cannot be trapped, so this only guards against `close` having
            // already fired before the listener was attached.
            const guard = setTimeout(resolve, SHUTDOWN_CLOSE_WAIT_MS)
            guard.unref()
            target.child.once('close', () => {
                clearTimeout(guard)
                resolve()
            })
        })
    },
}

type Runner = {
    child: ChildProcess
    inFlight: InFlightExecution | null
    usable: boolean
}

type InFlightExecution = {
    id: number
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    stdout: string
    stderr: string
}

type RunnerMessage = {
    id: number
    success: boolean
    terminal?: boolean
    result?: unknown
    error?: string
    stdout?: string
    stderr?: string
}
