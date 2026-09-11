/**
 * Contract between a qadam that knows how to pull events from a third-party API and the
 * long-polling host that runs the loop. The qadam owns the protocol (endpoint, window length,
 * cursor arithmetic, error semantics); the host owns scheduling, leader election, cursor
 * persistence and delivery, and knows nothing about the third party beyond this interface.
 *
 * The host runs qadam code in-process without a sandbox, so `auth` is handed over as `unknown`
 * and the implementation is expected to narrow it itself rather than trust the caller.
 */

export enum QadamEventPullOutcome {
  EVENTS = 'EVENTS',
  RETRYABLE = 'RETRYABLE',
  FATAL = 'FATAL',
}

export type WaitForEventsParams = {
  auth: unknown;
  /** The trigger's own `settings.input`, forwarded verbatim; the host does not read it. */
  config: unknown;
  cursor: string | undefined;
  signal: AbortSignal;
};

export type QadamEventsPulled = {
  outcome: QadamEventPullOutcome.EVENTS;
  events: unknown[];
  /** Persisted by the host only after every event in this batch has been delivered. */
  nextCursor: string | undefined;
};

export type QadamEventPullRetryable = {
  outcome: QadamEventPullOutcome.RETRYABLE;
  reason: string;
  /** Honoured as a lower bound on the host's own backoff, when the API asks to slow down. */
  retryAfterSeconds?: number;
};

export type QadamEventPullFatal = {
  outcome: QadamEventPullOutcome.FATAL;
  reason: string;
};

export type QadamEventPullResult =
  | QadamEventsPulled
  | QadamEventPullRetryable
  | QadamEventPullFatal;

export type QadamEventPuller = {
  /** Upper bound on how long a single call keeps its window open, in seconds. */
  windowSeconds: number;
  /**
   * Whether a trigger configured like this asks for the pull transport. Keeping the decision
   * here is what lets the host stay ignorant of the third party: it never reads a prop name.
   */
  isEnabledFor: (params: { config: unknown }) => boolean;
  /**
   * A stable, **non-secret** identity for the credential behind `auth` — the thing the third party
   * actually counts as one consumer. The host keys its cluster-wide lock and its cursor on this,
   * so two connections holding the same credential cannot poll each other's events away. Must not
   * return the secret itself: it ends up in Redis keys and in logs. Return `undefined` when the
   * value cannot be parsed, and the host falls back to keying on the connection.
   */
  credentialKey: (params: { auth: unknown }) => string | undefined;
  waitForEvents: (params: WaitForEventsParams) => Promise<QadamEventPullResult>;
};
