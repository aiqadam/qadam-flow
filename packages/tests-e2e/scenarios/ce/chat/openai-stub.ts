import http from 'node:http';

/**
 * A minimal OpenAI-compatible completion endpoint, run inside the Playwright worker process.
 *
 * The in-app chat runs on whatever the operator configured, and the CUSTOM (OpenAI-compatible)
 * provider type accepts any `baseUrl` — so pointing one at this stub is what makes the chat
 * drivable end to end with no vendor, no key and no network. It is also the only way to reach the
 * three *small local model* behaviours in this milestone (#264, #265, #267) on demand: none of
 * them can be produced by a real hosted model when you want them.
 *
 * Two things about the transport decide the shape of this file:
 *
 * - The server talks to a provider through `safeHttp.fetch`, i.e. the SSRF-filtered axios instance,
 *   which rejects private and loopback addresses. The stack under test therefore has to run with
 *   `AP_SSRF_ALLOW_LIST` covering the Docker gateway. See the spec header.
 * - `#265` is about the wait for the **first byte**, and the response headers are the first byte.
 *   So `delayFirstByteMs` withholds `writeHead` as well as the body: writing the headers early and
 *   only delaying the chunks would exercise the inter-chunk idle guard instead, which is a
 *   different (and deliberately much tighter) bound.
 */
export async function startOpenAiStub(): Promise<OpenAiStub> {
  const requests: StubRequest[] = [];
  let queue: StubResponse[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const record: StubRequest = {
        path: req.url ?? '',
        authorization: req.headers['authorization'],
        body: parseJsonObject(raw),
      };
      requests.push(record);

      // Only the completion endpoint is ever called: a CUSTOM provider carries its model
      // catalogue in the stored config, so nothing asks the provider to list models. `/models` is
      // answered anyway so an unexpected call fails as an assertion rather than as a hang.
      if (!record.path.includes('/chat/completions')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: STUB_MODEL_ID, object: 'model' }] }));
        return;
      }

      const next = queue.shift();
      const scripted = typeof next === 'function' ? next(record) : next;
      const body = scripted?.sse ?? completionStream(UNSCRIPTED_REPLY);
      const delayMs = scripted?.delayFirstByteMs ?? 0;

      const send = () => {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.end(body);
      };
      if (delayMs > 0) {
        setTimeout(send, delayMs).unref();
        return;
      }
      send();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the OpenAI stub did not bind a TCP port');
  }

  return {
    // The stack under test runs in Docker; the worker runs on the host network. `host-gateway` is
    // how the app container reaches back, and it has to be in `AP_SSRF_ALLOW_LIST` to survive the
    // SSRF filter.
    baseUrl: `http://${stubAdvertisedHost()}:${address.port}/v1`,
    requests,
    script(responses: StubResponse[]) {
      queue = [...responses];
    },
    reset() {
      queue = [];
      requests.length = 0;
    },
    async stop() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** One SSE stream that answers with plain text and stops. */
export function textStream(text: string): StubReply {
  return { sse: completionStream(text) };
}

/** The same, but silent for `delayFirstByteMs` before a single byte leaves — including the headers. */
export function delayedTextStream({
  text,
  delayFirstByteMs,
}: {
  text: string;
  delayFirstByteMs: number;
}): StubReply {
  return { sse: completionStream(text), delayFirstByteMs };
}

/**
 * One SSE stream that asks for a tool and stops. `args` is the raw JSON string the model emitted,
 * so a test can send `{"limit":"5"}` — a number as a string, which is what #267 is about — exactly
 * as `llama3.1:8b` does.
 */
export function toolCallStream({
  toolName,
  callId,
  args,
}: {
  toolName: string;
  callId: string;
  args: string;
}): StubReply {
  return toolCallsStream([{ toolName, callId, args }]);
}

/** The same, with several calls in one assistant turn — which real models do routinely. */
export function toolCallsStream(
  calls: { toolName: string; callId: string; args: string }[],
): StubReply {
  return {
    sse: [
      sseChunk({
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: calls.map((call, index) => ({
                index,
                id: call.callId,
                type: 'function',
                function: { name: call.toolName, arguments: call.args },
              })),
            },
            finish_reason: null,
          },
        ],
      }),
      sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      DONE,
    ].join(''),
  };
}

/**
 * The id `ap_create_flow` reports in its own success text, read back out of the transcript the
 * model is shown on the next round-trip. Lets a scripted turn name a flow the chat itself just
 * created, instead of the spec reaching past the UI to mint one. Matched by display name, because
 * a turn that created more than one flow leaves more than one receipt.
 */
export function flowIdFromTranscript({
  request,
  displayName,
}: {
  request: StubRequest;
  displayName: string;
}): string {
  // Matched against the JSON-encoded transcript, where the receipt's own quotes arrive escaped —
  // hence `[^(]*` between the name and the id rather than a literal `" (`.
  const pattern = new RegExp(`${displayName}[^(]*\\(id: ([0-9a-zA-Z]+)\\)`);
  const match = pattern.exec(JSON.stringify(request.body['messages'] ?? []));
  if (match === null) {
    throw new Error(`no ap_create_flow receipt for "${displayName}" in the transcript the model was shown`);
  }
  return match[1];
}

/** The tool result the model was shown on a given round-trip, as raw text. */
export function toolResultText(request: StubRequest): string {
  const messages = request.body['messages'];
  if (!Array.isArray(messages)) {
    return '';
  }
  return JSON.stringify(messages.filter((message) => isRecord(message) && message['role'] === 'tool'));
}

/** The arguments the server actually parsed a tool call with, as replayed to the model. */
export function replayedToolArguments(request: StubRequest): string[] {
  const messages = request.body['messages'];
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages.flatMap((message) => {
    if (!isRecord(message) || !Array.isArray(message['tool_calls'])) {
      return [];
    }
    return message['tool_calls'].flatMap((call) => {
      const fn = isRecord(call) ? call['function'] : undefined;
      const args = isRecord(fn) ? fn['arguments'] : undefined;
      return typeof args === 'string' ? [args] : [];
    });
  });
}

function stubAdvertisedHost(): string {
  return process.env.E2E_CHAT_STUB_HOST ?? 'host.docker.internal';
}

function sseChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-e2e',
    object: 'chat.completion.chunk',
    created: 1,
    model: STUB_MODEL_ID,
    ...payload,
  })}\n\n`;
}

function completionStream(text: string): string {
  return [
    sseChunk({ choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }),
    sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    DONE,
  ].join('');
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DONE = 'data: [DONE]\n\n';

// A round-trip the test did not script. Deliberately recognisable rather than empty, so an
// unexpected extra turn shows up in an assertion instead of stalling the run.
const UNSCRIPTED_REPLY = 'unscripted stub reply';

export const STUB_MODEL_ID = 'e2e-stub-model';

export type StubRequest = {
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
};

export type StubReply = {
  sse: string;
  delayFirstByteMs?: number;
};

export type StubResponse = StubReply | ((request: StubRequest) => StubReply);

export type OpenAiStub = {
  baseUrl: string;
  requests: StubRequest[];
  script: (responses: StubResponse[]) => void;
  reset: () => void;
  stop: () => Promise<void>;
};
