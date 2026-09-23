import { ErrorCode } from '@aiqadam/shared';
import { describe, expect, it } from 'vitest';

import { chatSendingErrorUtils } from '@/features/chat/chat-message-list/classify-sending-error';
import {
  CHAT_SERVICE_UNAVAILABLE,
  FLOW_RUN_FAILED,
  FLOW_STILL_RUNNING,
} from '@/features/chat/chat-message-list/error-bubble';

describe('chatSendingErrorUtils.classify', () => {
  it('classifies a 504 as still-running, ignoring the message-only body', () => {
    expect(
      chatSendingErrorUtils.classify({
        status: 504,
        data: {
          message: 'The flow run did not respond within the time limit.',
        },
      }),
    ).toEqual({ code: FLOW_STILL_RUNNING });
  });

  it('classifies a 500 as flow-run-failed, ignoring the message-only body', () => {
    expect(
      chatSendingErrorUtils.classify({
        status: 500,
        data: { message: 'The flow run did not complete successfully.' },
      }),
    ).toEqual({ code: FLOW_RUN_FAILED });
  });

  it('classifies a 503 as service-unavailable, ignoring the message-only body', () => {
    expect(
      chatSendingErrorUtils.classify({
        status: 503,
        data: { message: 'Too many concurrent runs.' },
      }),
    ).toEqual({ code: CHAT_SERVICE_UNAVAILABLE });
  });

  it('falls back to the coded ApErrorParams body for any other status', () => {
    const data = {
      code: ErrorCode.ENTITY_NOT_FOUND,
      params: { entityType: 'flow' },
    };
    expect(chatSendingErrorUtils.classify({ status: 404, data })).toEqual(data);
  });

  it('returns null when the body has no code and the status is not 500/503/504', () => {
    expect(
      chatSendingErrorUtils.classify({
        status: 400,
        data: { message: 'bad request' },
      }),
    ).toBeNull();
  });

  it('returns null for a missing status and an undefined body', () => {
    expect(
      chatSendingErrorUtils.classify({ status: undefined, data: undefined }),
    ).toBeNull();
  });
});

describe('chatSendingErrorUtils.isApErrorParams', () => {
  it('accepts a real ApErrorParams body (has both code and params)', () => {
    expect(
      chatSendingErrorUtils.isApErrorParams({
        code: ErrorCode.VALIDATION,
        params: { message: 'bad' },
      }),
    ).toBe(true);
  });

  it('rejects a web-local sentinel kind (code only, no params)', () => {
    expect(
      chatSendingErrorUtils.isApErrorParams({ code: FLOW_RUN_FAILED }),
    ).toBe(false);
  });

  it('rejects null and non-object values', () => {
    expect(chatSendingErrorUtils.isApErrorParams(null)).toBe(false);
    expect(chatSendingErrorUtils.isApErrorParams(undefined)).toBe(false);
    expect(chatSendingErrorUtils.isApErrorParams('oops')).toBe(false);
  });
});
