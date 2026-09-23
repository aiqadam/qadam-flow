import { ApErrorParams, ChatUIResponse, ErrorCode } from '@aiqadam/shared';
import { t } from 'i18next';
import { BotIcon, CircleX, RotateCcw } from 'lucide-react';
import React from 'react';

import {
  ChatBubble,
  ChatBubbleAction,
  ChatBubbleAvatar,
  ChatBubbleMessage,
} from '../chat-bubble';

export const FLOW_STILL_RUNNING = 'FLOW_STILL_RUNNING';
export const FLOW_RUN_FAILED = 'FLOW_RUN_FAILED';
export const CHAT_SERVICE_UNAVAILABLE = 'CHAT_SERVICE_UNAVAILABLE';

const formatError = (
  projectId: string | undefined | null,
  flowId: string,
  error: ChatSendingError,
) => {
  switch (error.code) {
    case FLOW_STILL_RUNNING:
      return (
        <span>
          {t(
            'The flow is still running and did not reply in time. Its reply will not appear in this chat.',
          )}
        </span>
      );
    case FLOW_RUN_FAILED:
      return <span>{t('The flow failed to execute.')}</span>;
    case CHAT_SERVICE_UNAVAILABLE:
      return (
        <span>
          {t('The service is temporarily busy. Please try again in a moment.')}
        </span>
      );
    case ErrorCode.NO_CHAT_RESPONSE:
      return projectId ? (
        <span>
          No response from the chatbot. Ensure that{' '}
          <strong>Respond on UI</strong> is in{' '}
          <a
            href={`/projects/${projectId}/flows/${flowId}`}
            className="text-primary underline"
            target="_blank"
            rel="noreferrer"
          >
            your flow
          </a>
          .
        </span>
      ) : (
        <span>
          The chatbot is not responding. It seems there might be an issue with
          how this chat was set up. Please contact the person who shared this
          chat link with you for assistance.
        </span>
      );
    case ErrorCode.ENTITY_NOT_FOUND:
      if (error.params.entityType === 'flow') {
        return (
          <span>The chat flow you are trying to access no longer exists.</span>
        );
      }
      return <span>Something went wrong. Please try again.</span>;
    case ErrorCode.VALIDATION:
      return <span>{`Validation error: ${error.params.message}`}</span>;
    default:
      return <span>Something went wrong. Please try again.</span>;
  }
};

interface ErrorBubbleProps {
  chatUI: ChatUIResponse | null | undefined;
  flowId: string;
  sendingError: ChatSendingError;
  sendMessage: (arg0: { isRetrying: boolean; message?: any }) => void;
}

export const ErrorBubble = ({
  chatUI,
  flowId,
  sendingError,
  sendMessage,
}: ErrorBubbleProps) => (
  <ChatBubble variant="received" className="pb-8">
    <div className="relative">
      <ChatBubbleAvatar
        src={chatUI?.platformLogoUrl}
        fallback={<BotIcon className="size-5" />}
      />
      <div className="absolute -bottom-[2px] -right-[2px]">
        <CircleX className="size-4 text-destructive" strokeWidth={3} />
      </div>
    </div>
    <ChatBubbleMessage className="text-destructive">
      {formatError(chatUI?.projectId, flowId, sendingError)}
    </ChatBubbleMessage>
    {sendingError.code !== FLOW_STILL_RUNNING && (
      // A retry would start the still-running flow a second time.
      <div className="flex gap-1">
        <ChatBubbleAction
          variant="outline"
          className="size-5 mt-2"
          icon={<RotateCcw className="size-3" />}
          onClick={() => {
            sendMessage({ isRetrying: true });
          }}
        />
      </div>
    )}
  </ChatBubble>
);

ErrorBubble.displayName = 'ErrorBubble';

export type ChatSendingError =
  | ApErrorParams
  | { code: typeof FLOW_STILL_RUNNING }
  | { code: typeof FLOW_RUN_FAILED }
  | { code: typeof CHAT_SERVICE_UNAVAILABLE };
