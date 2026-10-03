// The conversion worker starts afresh for every conversion and loads only what it needs.
// Importing @aiqadam/shared there would add about 300 ms and 50 MB of heap to each conversion
// (measured), so the worker's modules use these instead of its tryCatch, tryCatchSync and isNil.
export const workerUtils = {
  async tryCatch<T>(fn: () => Promise<T>): Promise<Result<T>> {
    try {
      return { data: await fn(), error: null };
    }
    catch (error) {
      return { data: null, error: toError(error) };
    }
  },

  tryCatchSync<T>(fn: () => T): Result<T> {
    try {
      return { data: fn(), error: null };
    }
    catch (error) {
      return { data: null, error: toError(error) };
    }
  },

  isNil<T>(value: T | null | undefined): value is null | undefined {
    return value === null || value === undefined;
  },
};

function toError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

type Result<T> = { data: T; error: null } | { data: null; error: Error };
