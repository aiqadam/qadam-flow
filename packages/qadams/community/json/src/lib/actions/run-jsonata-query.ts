import { createAction, Property } from '@aiqadam/qadams-framework';
import jsonata from 'jsonata';

// Conservative ceilings for jsonata's opt-in resource guardrails (#646): with no options at all,
// a runaway expression (e.g. a self-recursive lambda, or a query that grows an unbounded sequence)
// is only stopped by the worker sandbox's 600s kill timer. These bound a single evaluation well
// below that, regardless of who wrote the expression (flow author, or trigger data an outside
// sender controls). `stack` counts jsonata's own per-AST-node evaluation depth, not user recursion
// levels directly — an ordinary (non-tail) recursive call costs several of those per level, so 500
// is roughly 150-200 levels of recursion, not 500.
const MAX_TIMEOUT_SECONDS = 10;
const MAX_STACK_DEPTH = 500;
const MAX_SEQUENCE_LENGTH = 1_000_000;

// D1011 (stack) and D1012 (timeout) come only from the guardrails above. D2014/D2015 (sequence
// length) can also come from jsonata's own built-in 1e7 range-operator cap, which applies
// regardless of what we pass — grouped here anyway because all four mean "hit a safety limit", not
// "malformed expression", for the purpose of the error message below.
const GUARDRAIL_ERROR_CODES = new Set(['D1011', 'D1012', 'D2014', 'D2015']);

export const runJsonataQuery = createAction({
  name: 'run_jsonata_query',
  displayName: 'Run JSONata Query',
  description: 'Use the JSONata language to filter, map, and transform complex JSON payloads natively in JavaScript.',
  props: {
    json: Property.Json({
      displayName: 'JSON Data',
      description: 'Map the array or object you want to manipulate.',
      required: true,
      defaultValue: {},
    }),
    query: Property.ShortText({
      displayName: 'JSONata Query',
      description: 'Write a JSONata expression to manipulate your data. You can filter arrays, extract specific fields, group items, or reshape the JSON. (e.g., $[status="active"])',
      required: true,
    }),
    timeoutInSeconds: Property.Number({
      displayName: 'Timeout (in seconds)',
      description: `How long to let the query run before it is cancelled. Capped at ${MAX_TIMEOUT_SECONDS} seconds.`,
      required: false,
      defaultValue: MAX_TIMEOUT_SECONDS,
    }),
  },
  async run(context) {
    const { json, query, timeoutInSeconds } = context.propsValue;

    try {
      const parsedJson = typeof json === 'string' ? JSON.parse(json) : json;

      const timeout =
        timeoutInSeconds && timeoutInSeconds > 0
          ? Math.min(timeoutInSeconds, MAX_TIMEOUT_SECONDS) * 1000
          : MAX_TIMEOUT_SECONDS * 1000;

      const expression = jsonata(query, {
        timeout,
        stack: MAX_STACK_DEPTH,
        sequence: MAX_SEQUENCE_LENGTH,
      });

      const result = await expression.evaluate(parsedJson);

      // JSONata returns `undefined` if a query yields no matches.
      // We convert this to `null` so Activepieces receives valid, serializable JSON.
      return result === undefined ? null : result;
    } catch (error) {
      const message = jsonataErrorMessage(error);
      const code = jsonataErrorCode(error);
      const guidance =
        code !== undefined && GUARDRAIL_ERROR_CODES.has(code)
          ? 'The query exceeded a safety limit (timeout, recursion depth, or sequence length)'
          : 'Please check your query syntax';
      throw new Error(`JSONata Execution Failed. ${guidance}. Details: ${message}`);
    }
  },
});

// jsonata's own guardrail failures (and ordinary parse/evaluation errors) are plain objects, not
// `Error` instances, but jsonata populates a human-readable `.message` on all of them before
// rethrowing — reading that (rather than JSON.stringify-ing the whole object) also avoids leaking
// the object's own `stack: (new Error()).stack` property, which points at this package's internal
// file paths, into the error a flow author sees.
function jsonataErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return JSON.stringify(error);
}

function jsonataErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}