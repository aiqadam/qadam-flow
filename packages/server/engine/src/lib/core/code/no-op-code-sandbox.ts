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

const CODE_RUNNER_SCRIPT = `
const asyncHooks = require('async_hooks')
const inspect = require('util').inspect
let inFlightId = null

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
    process.send({ id: id === null ? -1 : id, success: false, error, terminal: true }, () => process.exit(1))
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

function startRunner(): Runner {
    const child = spawn(process.execPath, ['--eval', CODE_RUNNER_SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    })
    const started: Runner = { child, inFlight: null, usable: true }

    child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString()
        if (started.inFlight) {
            started.inFlight.stdout += text
        }
        console.log(text.trimEnd())
    })

    child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString()
        if (started.inFlight) {
            started.inFlight.stderr += text
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
            execution.reject(buildError({ message: message.error, execution }))
        }
    })

    // 'close' rather than 'exit': it fires once stdio is drained, so a failure caused by
    // user code calling process.exit() still carries whatever that code logged first.
    child.on('close', (code, signal) => {
        retire(started)
        const execution = started.inFlight
        started.inFlight = null
        execution?.reject(buildError({ message: `Code process exited with code ${code} and signal ${signal}`, execution }))
    })

    child.on('error', (error) => {
        retire(started)
        const execution = started.inFlight
        started.inFlight = null
        execution?.reject(buildError({ message: error.message, execution }))
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
    return typeof candidate.id === 'number' && typeof candidate.success === 'boolean'
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
            execution?.reject(buildError({ message: error.message, execution }))
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

function buildError({ message, execution }: { message: string | undefined, execution: InFlightExecution | null }): Error {
    const parts: string[] = [message ?? 'Code execution failed']
    const stdout = execution?.stdout ?? ''
    const stderr = execution?.stderr ?? ''
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
}
