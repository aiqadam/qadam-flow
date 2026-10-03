import path from 'node:path';
import { isMarkedAsUntransferable, Worker } from 'node:worker_threads';
import { ConversionRequest, conversionProtocol, ConvertedSheet } from './conversion-protocol';

// What one conversion may use. The engine runs a step with its heap capped at 1 GB
// (SANDBOX_MEMORY_LIMIT). A worker's heap is separate from the engine's but is counted against
// the same 1 GB, the memory an operator sized for one step: the engine's share holds the
// uploaded file (up to 25 MB by default, about 60 MB with its base64 text), the extracted parts
// and the returned CSV. 512 MB for the worker leaves the engine about half of the 1 GB.
export const CONVERSION_LIMITS: ConversionLimits = {
  heapLimitMb: 512,
  timeLimitMs: 60_000,
};

// Runs the workbook load and the CSV build in a worker thread, so a workbook that needs more
// memory or time than a conversion may use stops the worker, not the engine.
export const conversionWorker = {
  run({ request, limits = CONVERSION_LIMITS, entry = WORKER_ENTRY }: RunParams): Promise<ConvertedSheet> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(entry, {
        workerData: request,
        transferList: transferableBuffers(request.parts),
        env: {},
        resourceLimits: {
          maxOldGenerationSizeMb: limits.heapLimitMb,
          maxYoungGenerationSizeMb: YOUNG_GENERATION_MB,
          stackSizeMb: STACK_SIZE_MB,
        },
      });
      supervise({
        worker,
        limits,
        onOutcome: (outcome) => (outcome.ok ? resolve(outcome.sheet) : reject(outcome.error)),
      });
    });
  },
};

const MEBIBYTE = 1024 * 1024;
const YOUNG_GENERATION_MB = 32;
const STACK_SIZE_MB = 4;

// Node 24 does not lower a worker's heap limit below the process's own for
// maxOldGenerationSizeMb (the worker reports the setting, but its heap grows to the process
// limit), so the heap limit is enforced from here as well: the worker's heap is sampled at
// this interval while it runs, and the worker is stopped once the heap passes the limit.
// getHeapStatistics interrupts the worker's JavaScript to answer, so it is answered during a
// long synchronous parse too. The process limit still applies as a backstop, and reaching it
// ends only the worker (ERR_WORKER_OUT_OF_MEMORY).
const HEAP_SAMPLE_INTERVAL_MS = 25;

const OUT_OF_MEMORY_CODE = 'ERR_WORKER_OUT_OF_MEMORY';

// Compiled next to this module, so it ships in the qadam's dist with it.
const WORKER_ENTRY = path.join(__dirname, 'excel-to-csv-worker.js');

function supervise({ worker, limits, onOutcome }: SuperviseParams): void {
  let settled = false;
  const settle = (outcome: Outcome): void => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(deadline);
    clearInterval(heapSampler);
    void worker.terminate();
    onOutcome(outcome);
  };
  const deadline = setTimeout(() => settle({ ok: false, error: tooComplexError(limits) }), limits.timeLimitMs);
  const heapSampler = setInterval(() => {
    worker.getHeapStatistics().then(
      (statistics) => {
        if (statistics.total_heap_size > limits.heapLimitMb * MEBIBYTE) {
          settle({ ok: false, error: tooLargeError(limits) });
        }
      },
      () => undefined
    );
  }, HEAP_SAMPLE_INTERVAL_MS);

  worker.on('message', (message: unknown) => settle(replyToOutcome(message)));
  worker.on('error', (error: Error) => settle({ ok: false, error: isOutOfMemory(error) ? tooLargeError(limits) : workerFailedError(error) }));
  worker.on('exit', () => settle({ ok: false, error: stoppedEarlyError() }));
}

// A part that owns its whole buffer moves to the worker instead of being copied, so the
// engine's thread does not hold a second copy of it while the worker runs.
function transferableBuffers(parts: Record<string, Uint8Array>): ArrayBuffer[] {
  const owned = Object.values(parts)
    .filter((part) => part.byteOffset === 0 && part.byteLength === part.buffer.byteLength)
    .map((part) => part.buffer)
    .filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer && !isMarkedAsUntransferable(buffer));
  return [...new Set(owned)];
}

function replyToOutcome(message: unknown): Outcome {
  if (typeof message === 'object' && message !== null && 'ok' in message) {
    if (message.ok === true && 'sheet' in message && conversionProtocol.isConvertedSheet(message.sheet)) {
      return { ok: true, sheet: message.sheet };
    }
    if (message.ok === false && 'message' in message && typeof message.message === 'string') {
      return { ok: false, error: new Error(message.message) };
    }
  }
  return { ok: false, error: new Error('The workbook could not be converted: the conversion returned a result this action does not understand.') };
}

function isOutOfMemory(error: Error): boolean {
  return 'code' in error && error.code === OUT_OF_MEMORY_CODE;
}

function tooLargeError(limits: ConversionLimits): Error {
  return new Error(
    `The workbook is too large to convert: converting it needs more than the ${limits.heapLimitMb} MB of memory a conversion may use. ` +
    'Delete unused rows, columns and sheets, or split the workbook, and try again.'
  );
}

function tooComplexError(limits: ConversionLimits): Error {
  return new Error(
    `The workbook is too complex to convert: converting it takes longer than the ${limits.timeLimitMs / 1000} seconds a conversion may take. ` +
    'Delete unused rows, columns and sheets, or split the workbook, and try again.'
  );
}

function stoppedEarlyError(): Error {
  return new Error(
    'The workbook is too large or too complex to convert: the conversion stopped before it finished. ' +
    'Delete unused rows, columns and sheets, or split the workbook, and try again.'
  );
}

function workerFailedError(error: Error): Error {
  return new Error(`The workbook could not be converted: ${error.message}`);
}

export type ConversionLimits = {
  heapLimitMb: number;
  timeLimitMs: number;
};

type RunParams = {
  request: ConversionRequest;
  limits?: ConversionLimits;
  entry?: string;
};

type Outcome = { ok: true; sheet: ConvertedSheet } | { ok: false; error: Error };

type SuperviseParams = {
  worker: Worker;
  limits: ConversionLimits;
  onOutcome: (outcome: Outcome) => void;
};
