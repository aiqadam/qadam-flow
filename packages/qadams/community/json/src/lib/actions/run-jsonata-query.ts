import { createAction, Property } from '@aiqadam/qadams-framework';
import jsonata from 'jsonata';

// Conservative ceilings for jsonata's opt-in resource guardrails (#646): with no options at all,
// a runaway expression (e.g. a self-recursive lambda, or a query that grows an unbounded sequence)
// is only stopped by the worker sandbox's 600s kill timer. These bound a single evaluation well
// below that, regardless of who wrote the expression (flow author, or trigger data an outside
// sender controls).
const MAX_TIMEOUT_SECONDS = 10;
const MAX_STACK_DEPTH = 500;
const MAX_SEQUENCE_LENGTH = 1_000_000;

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
      const message = error instanceof Error ? error.message : JSON.stringify(error);
      throw new Error(`JSONata Execution Failed. Please check your query syntax. Details: ${message}`);
    }
  },
});