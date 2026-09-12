import { AxiosError } from 'axios';

/**
 * Deliberately carries nothing from the outbound request.
 *
 * It used to take the request body and put it both in the `message` and on an own property, which
 * meant every failing request from every qadam serialised its payload into the error — OAuth
 * code-for-token exchanges, API keys sent in bodies, customer PII in a CRM call. That reached four
 * surfaces and only the first was ever guarded:
 *
 * - engine stderr, via the `console.error` in `AxiosHttpClient`;
 * - the run's step *output*, because a `failsafe` action returns `errorMessage()` verbatim;
 * - the step's `errorMessage` and the run's `failedStep.message` for every non-failsafe failure,
 *   which is the default, because the engine formats a thrown error with `util.inspect` — that
 *   prints the message *and* every own enumerable property, so the body appeared twice over;
 * - the persisted `FriendlyQadamError.requestBody`, because `extractHttpDetails` read `request`
 *   off the error by index — the field the *Copy AI prompt* button sends to a model. That read is
 *   duck-typed, so nothing here fails to compile if the getter comes back; `axios-http-client.test.ts`
 *   asserts it through the real function instead.
 *
 * All but the first are persisted and rendered to anyone who can view the run, and they hold the
 * exact value the engine takes care to censor one field over: `qadam-executor` resolves a step's
 * input twice and stores only the copy in which `props-resolver` has replaced each
 * `{{connections.*}}` with `'**REDACTED**'`. The body is that input after resolution, so echoing it
 * into the output handed back the secrets the input had just been stripped of.
 *
 * A denylist of field names was the obvious alternative and is not viable: the body is arbitrary
 * user JSON, so there is no fixed set of names to match. `safe-http.ts` reached the same conclusion
 * for the same data, and drops everything axios attached to a thrown error rather than filtering it.
 *
 * The response is kept. It is what a failing request is diagnosed from, and it is the server's own
 * words rather than the credentials we sent it.
 */
export class HttpError extends Error {
  private readonly status: number;
  private readonly responseBody: unknown;

  constructor(err: AxiosError) {
    const status = err?.response?.status || 500;
    const responseBody = Buffer.isBuffer(err?.response?.data) ? err?.response?.data.toString() : err?.response?.data;

    super(
      JSON.stringify({
        response: {
          status: status,
          body: responseBody,
        },
      })
    );

    this.status = status;
    this.responseBody = responseBody;
  }

  public errorMessage() {
    return {
      response: {
        status: this.status,
        body: this.responseBody,
      },
    };
  }

  get response() {
    return {
      status: this.status,
      body: this.responseBody,
    };
  }
}
