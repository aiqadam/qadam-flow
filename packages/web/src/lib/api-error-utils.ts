import { isAxiosError } from 'axios';

/**
 * Resolves the sentence a form should show for a failed mutation.
 *
 * Never derive that sentence from the error object itself. `JSON.stringify(anAxiosError)` emits
 * `config`, and `config` carries the request's `Authorization` header and its `data` — on a
 * credential form that is the session bearer plus the api key the operator has just typed, painted
 * into the DOM. An error whose body carries no sentence of its own gets the caller's fallback.
 *
 * A `QadamFlowError` body is `{ code, params }` with no top-level `message`, so `params.message` is
 * where server prose lives; `message` is the shape Fastify's own errors (schema validation, 500s)
 * use.
 */
function extractServerMessage({
  error,
  fallback,
}: {
  error: unknown;
  fallback: string;
}): string {
  if (
    !isAxiosError<{ message?: unknown; params?: { message?: unknown } }>(error)
  ) {
    return fallback;
  }
  const data = error.response?.data;
  const candidates = [data?.message, data?.params?.message];
  const message = candidates.find(
    (candidate): candidate is string =>
      typeof candidate === 'string' && candidate.trim().length > 0,
  );
  return message ?? fallback;
}

export const apiErrorUtils = { extractServerMessage };
