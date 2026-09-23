import { ApErrorParams } from '@aiqadam/shared';

import {
  CHAT_SERVICE_UNAVAILABLE,
  ChatSendingError,
  FLOW_RUN_FAILED,
  FLOW_STILL_RUNNING,
} from './error-bubble';

export const chatSendingErrorUtils = {
  classify: classifySendingError,
  isApErrorParams,
};

/**
 * A real `ApErrorParams` always carries both `code` and `params` (every member of the union
 * does). The web-local sentinel kinds this module classifies into (`FLOW_STILL_RUNNING`,
 * `FLOW_RUN_FAILED`, `CHAT_SERVICE_UNAVAILABLE`) carry only `code` — checking for `params` too
 * is what lets a caller tell the two apart without a cast.
 */
function isApErrorParams(data: unknown): data is ApErrorParams {
  return (
    typeof data === 'object' &&
    data !== null &&
    'code' in data &&
    'params' in data
  );
}

/**
 * The sync webhook's 500/503/504 bodies are `{ message }` only, with no `code` field for
 * `ErrorBubble` to switch on (see /sync's contract in webhook.service.ts) — those three are
 * classified by HTTP status alone. Any other status falls back to the coded `ApErrorParams`
 * body (404 ENTITY_NOT_FOUND, VALIDATION, etc.), guarded rather than cast.
 */
function classifySendingError({
  status,
  data,
}: ClassifySendingErrorParams): ChatSendingError | null {
  if (status === 504) {
    return { code: FLOW_STILL_RUNNING };
  }
  if (status === 500) {
    return { code: FLOW_RUN_FAILED };
  }
  if (status === 503) {
    return { code: CHAT_SERVICE_UNAVAILABLE };
  }
  return isApErrorParams(data) ? data : null;
}

type ClassifySendingErrorParams = {
  status: number | undefined;
  data: unknown;
};
