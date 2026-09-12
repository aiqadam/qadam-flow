import { ConnectionMetadata } from '../context';

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
  /**
   * The trigger's own `settings.input`, forwarded verbatim; the host does not read it. Carries
   * what genuinely belongs to the step — which kinds of event this flow wants — while anything
   * that belongs to the credential is on the connection instead.
   */
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
  /**
   * Shown to the user on the flow, so it must read as an explanation and must never contain the
   * credential, a URL carrying one, or anything internal. The host truncates it; it does not
   * sanitise it.
   */
  reason: string;
  /** Honoured as a lower bound on the host's own backoff, when the API asks to slow down. */
  retryAfterSeconds?: number;
};

export type QadamEventPullFatal = {
  outcome: QadamEventPullOutcome.FATAL;
  /** Shown to the user on the flow — see the note on `QadamEventPullRetryable.reason`. */
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
   * Whether the credential behind this connection asks for the pull transport.
   *
   * Asked of the connection's `metadata` rather than of the trigger's settings, because the mode
   * is a property of the credential: the third party allows one consumer per credential, so two
   * flows sharing a connection must not be able to disagree about how it is consumed. Keeping the
   * decision here is also what lets the host stay ignorant of the third party — it never reads a
   * key name of its own.
   */
  isEnabledFor: (params: { connectionMetadata: ConnectionMetadata }) => boolean;
  /**
   * A stable, **non-secret** identity for the credential behind `auth` — the thing the third party
   * actually counts as one consumer. The host keys its cluster-wide lock and its cursor on this,
   * so two connections holding the same credential cannot poll each other's events away. Must not
   * return the secret itself: it ends up in Redis keys and in logs. Return `undefined` when the
   * value is not a credential this puller recognises — the host then stops that source rather than
   * polling with something it cannot identify.
   *
   * If this throws, the host shows the exception's message to the user. This is the one function
   * handed the decrypted credential, so the message must not quote what it was given.
   */
  credentialKey: (params: { auth: unknown }) => string | undefined;
  /**
   * If this throws, the host shows the exception's message to the user, exactly as it does for a
   * returned `reason` — so the same rule applies: no credential, no URL carrying one, nothing
   * internal.
   */
  waitForEvents: (params: WaitForEventsParams) => Promise<QadamEventPullResult>;
};
