import {
  ABANDONED_CHAT_RUN_AFTER_MS,
  ActionPreviewEvent,
  ActionReceiptEvent,
  apId,
  ChatAllowedMimeType,
  ChatConversationStatus,
  ChatHistoryMessage,
  CHAT_ALLOWED_MIME_TYPES,
  isNil,
  PendingChatToolApproval,
  PersistedChatMessage,
  ToolApprovalRequestEvent,
  ToolProgressEvent,
  tryCatch,
} from '@aiqadam/shared';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { chatApi } from './chat-api';
import { chatStoreSelectors, SetChatStore, ToolCallMeta } from './chat-store';
import { useChatStoreApi } from './chat-store-context';
import { ChatUIMessage, chatPartUtils } from './chat-types';
import { chatUtils } from './chat-utils';
import { useStreamingReducer } from './use-streaming-reducer';

function restoreReceiptsIntoStore({
  data,
  setState,
}: {
  data: PersistedChatMessage[] | ChatHistoryMessage[];
  setState: SetChatStore;
}): void {
  const receipts = chatUtils.extractReceiptsFromHistory(data);
  if (Object.keys(receipts).length === 0) return;
  setState((prev) => {
    const merged = { ...prev.toolCallMeta };
    for (const [toolCallId, receipt] of Object.entries(receipts)) {
      merged[toolCallId] = { ...merged[toolCallId], actionReceipt: receipt };
    }
    return { toolCallMeta: merged };
  });
}

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const AGENT_POLL_INTERVAL_MS = 5_000;

function buildToolCallMetaFromGate(
  gate: PendingChatToolApproval,
): Record<string, ToolCallMeta> {
  if (chatPartUtils.isDisplayTool(gate.toolName)) {
    return {};
  }
  const gateInput = gate.toolInput ?? {};
  if (gate.toolName === 'ap_execute_action') {
    return {
      [gate.toolCallId]: {
        actionPreview: {
          toolCallId: gate.toolCallId,
          qadamName:
            typeof gateInput.qadamName === 'string' ? gateInput.qadamName : '',
          actionName:
            typeof gateInput.actionName === 'string'
              ? gateInput.actionName
              : '',
          actionDisplayName: gate.displayName,
          input:
            typeof gateInput.input === 'object' && gateInput.input !== null
              ? (gateInput.input as Record<string, unknown>)
              : {},
          isBatch:
            typeof gateInput.batchCount === 'number' &&
            gateInput.batchCount > 0,
          batchCount:
            typeof gateInput.batchCount === 'number'
              ? gateInput.batchCount
              : undefined,
          batchSamples: Array.isArray(gateInput.items)
            ? (gateInput.items as Record<string, unknown>[]).slice(0, 3)
            : undefined,
        },
      },
    };
  }
  // Everything else needs no meta at all: an approval card is rendered from the tool part's
  // `approval-requested` state, which both the live stream and the replayed transcript produce.
  return {};
}

// The card is driven by the tool part, so the fetched gate only has to be *represented* as one. It
// normally already is — `mapHistoryToUIMessages` turns the persisted request part into exactly this —
// and this synthesises it for the case where it is not, which is the case a gate raised in a run whose
// assistant message has not been reconciled yet actually hits.
function withGatePart({
  messages,
  gate,
}: {
  messages: ChatUIMessage[];
  gate: PendingChatToolApproval;
}): ChatUIMessage[] {
  const alreadyPresent = messages.some((message) =>
    message.parts.some(
      (part) =>
        chatPartUtils.isAnyToolPart(part) &&
        chatPartUtils.getApprovalId(part) === gate.gateId,
    ),
  );
  if (alreadyPresent) return messages;
  const gatePart = {
    type: 'dynamic-tool' as const,
    toolCallId: gate.toolCallId,
    toolName: gate.toolName,
    title: gate.displayName,
    state: 'approval-requested' as const,
    input: gate.toolInput,
    approval: { id: gate.gateId },
  };
  const lastAssistantIdx = messages.findLastIndex(
    (m) => m.role === 'assistant',
  );
  if (lastAssistantIdx === -1) {
    return [
      ...messages,
      { id: `gate-${gate.gateId}`, role: 'assistant', parts: [gatePart] },
    ];
  }
  return messages.map((message, idx) =>
    idx === lastAssistantIdx
      ? { ...message, parts: [...message.parts, gatePart] }
      : message,
  );
}

const ALLOWED_MIME_SET: ReadonlySet<string> = new Set(CHAT_ALLOWED_MIME_TYPES);

function isAllowedMimeType(value: string): value is ChatAllowedMimeType {
  return ALLOWED_MIME_SET.has(value);
}

function fileToBase64(
  file: File,
): Promise<{ name: string; mimeType: ChatAllowedMimeType; data: string }> {
  return new Promise((resolve, reject) => {
    const mimeType = file.type || 'application/octet-stream';
    if (!isAllowedMimeType(mimeType)) {
      reject(new Error(`Unsupported file type: ${mimeType}`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Failed to read file'));
        return;
      }
      const base64 = result.split(',')[1];
      resolve({ name: file.name, mimeType, data: base64 });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function fileNamesToFileParts(fileNames: string[]): ChatUIMessage['parts'] {
  return fileNames.map((name) => ({
    type: 'file' as const,
    mediaType: 'text/plain' as const,
    url: '',
    filename: name,
  }));
}

function injectFilePartsIntoLastUserMessage({
  messages,
  fileNames,
}: {
  messages: ChatUIMessage[];
  fileNames: string[];
}): ChatUIMessage[] {
  if (fileNames.length === 0) return messages;
  const lastUserIdx = messages.findLastIndex((m) => m.role === 'user');
  if (lastUserIdx === -1) return messages;
  const lastUser = messages[lastUserIdx];
  const alreadyHasFiles = lastUser.parts.some((p) => p.type === 'file');
  if (alreadyHasFiles) return messages;
  const patched = {
    ...lastUser,
    parts: [...lastUser.parts, ...fileNamesToFileParts(fileNames)],
  };
  const result = [...messages];
  result[lastUserIdx] = patched;
  return result;
}

type SendStatus =
  | { type: 'idle' }
  | { type: 'submitting' }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };

export function useAgentChat({
  onTitleUpdate,
  onConversationCreated,
}: {
  onTitleUpdate?: (title: string) => void;
  onConversationCreated?: (conversationId: string) => void;
} = {}) {
  const store = useChatStoreApi();

  const [conversationId, setConversationIdState] = useState<string | null>(
    null,
  );
  const [modelName, setModelNameState] = useState<string | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isPollingForAgentReply, setIsPollingForAgentReply] = useState(false);
  const pollDeadlineRef = useRef(0);
  const [sendStatus, setSendStatus] = useState<SendStatus>({ type: 'idle' });
  const sendStatusRef = useRef<SendStatus>({ type: 'idle' });

  const [persistedMessages, setPersistedMessages] = useState<ChatUIMessage[]>(
    [],
  );
  const persistedMessagesRef = useRef(persistedMessages);
  persistedMessagesRef.current = persistedMessages;
  const [optimisticUserMessage, setOptimisticUserMessage] =
    useState<ChatUIMessage | null>(null);
  const [liveGate, setLiveGate] = useState<PendingChatToolApproval | null>(
    null,
  );

  const pendingFilesRef = useRef<
    { name: string; mimeType: ChatAllowedMimeType; data: string }[] | undefined
  >(undefined);
  const lastSentFileNamesRef = useRef<string[]>([]);
  const conversationIdRef = useRef<string | null>(null);
  const modelNameRef = useRef<string | null>(null);
  const onTitleUpdateRef = useRef(onTitleUpdate);
  onTitleUpdateRef.current = onTitleUpdate;
  const onConversationCreatedRef = useRef(onConversationCreated);
  onConversationCreatedRef.current = onConversationCreated;

  const handleTitleUpdate = useCallback((title: string) => {
    onTitleUpdateRef.current?.(title);
  }, []);

  const handleToolProgress = useCallback(
    (event: ToolProgressEvent) => {
      store.setState((prev) => {
        const existing = prev.toolCallMeta[event.toolCallId]?.batchProgress;
        if (
          existing &&
          existing.completed === event.data.completed &&
          existing.done === event.data.done
        ) {
          return prev;
        }
        return {
          toolCallMeta: {
            ...prev.toolCallMeta,
            [event.toolCallId]: {
              ...prev.toolCallMeta[event.toolCallId],
              batchProgress: event.data,
            },
          },
        };
      });
    },
    [store],
  );

  const updateToolCallMeta = useCallback(
    <K extends keyof ToolCallMeta>(
      key: K,
      event: ToolCallMeta[K] & { toolCallId: string },
    ) => {
      store.setState((prev) => ({
        toolCallMeta: {
          ...prev.toolCallMeta,
          [event.toolCallId]: {
            ...prev.toolCallMeta[event.toolCallId],
            [key]: event,
          },
        },
      }));
    },
    [store],
  );

  // The live chunk stream already moves the gated tool part into `approval-requested`, so this event
  // is not what draws the card. What it is for is the window the chunk cannot cover: a gate *ends* the
  // run, so moments later `onStreamFinished` fires, the streaming message is discarded and the history
  // is refetched — and until that refetch lands there is nothing on screen holding the gate. Keeping
  // the gate here bridges it, and it costs nothing once the refetched transcript carries the part,
  // because `withGatePart` then finds it already present.
  const handleToolApprovalRequest = useCallback(
    (event: ToolApprovalRequestEvent) => {
      setLiveGate({
        gateId: event.approvalId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        displayName: event.displayName,
        toolInput: event.toolInput,
      });
    },
    [],
  );

  const handleActionPreview = useCallback(
    (event: ActionPreviewEvent) => {
      updateToolCallMeta('actionPreview', event);
    },
    [updateToolCallMeta],
  );

  const handleActionReceipt = useCallback(
    (event: ActionReceiptEvent) => {
      updateToolCallMeta('actionReceipt', event);
    },
    [updateToolCallMeta],
  );

  const updateSendStatus = useCallback((next: SendStatus) => {
    sendStatusRef.current = next;
    setSendStatus(next);
  }, []);

  const reconcile = useCallback(
    async (convId: string) => {
      if (conversationIdRef.current !== convId) return;
      const { data: result } = await tryCatch(() =>
        chatApi.getMessages(convId),
      );
      if (conversationIdRef.current !== convId) return;
      if (result) {
        const mapped = chatUtils.mapHistoryToUIMessages(result.data);
        setPersistedMessages(mapped);
        const restoredReplies =
          chatUtils.extractQuickRepliesFromHistory(mapped);
        if (restoredReplies.length > 0) {
          store.setState({ quickReplies: restoredReplies });
        }
        restoreReceiptsIntoStore({
          data: result.data,
          setState: store.setState,
        });
      }
      setOptimisticUserMessage(null);
    },
    [store],
  );

  const reconcileAndClearRef = useRef<(convId: string) => void>(() => {});

  const {
    streamingMessage,
    streamPhase,
    streamError,
    streamGeneration,
    startStream,
    setActiveRunId,
    stopStream,
    clearStreamingState,
  } = useStreamingReducer({
    onTitleUpdate: handleTitleUpdate,
    onToolProgress: handleToolProgress,
    onToolApprovalRequest: handleToolApprovalRequest,
    onActionPreview: handleActionPreview,
    onActionReceipt: handleActionReceipt,
    onStreamFinished: (convId) => {
      reconcileAndClearRef.current(convId);
    },
    // A stream can end while the run does not — a dropped socket, this side's own timeout, an error
    // raised for one turn of a conversation the server is still working through. The reconcile above
    // refetches once and finds nothing, and teardown has already stopped the stale check, so nothing
    // else will ever look again: the answer lands in the database and the open tab never shows it
    // (#289). Handing the wait to the poll is what closes that, and the poll ends itself as soon as
    // the conversation leaves STREAMING.
    onStreamError: ({ conversationId: convId }) => {
      reconcileAndClearRef.current(convId);
      void tryCatch(async () => {
        const conv = await chatApi.getConversation(convId);
        if (isNil(conv) || conversationIdRef.current !== convId) return;
        if (conv.status === ChatConversationStatus.STREAMING) {
          // The server's own bound, imported rather than restated: it stops honouring a STREAMING
          // conversation this long after its last heartbeat, so a poll that outlives it is waiting
          // on a run nobody is running. `getConversation` never applies that bound — only the
          // admission path does — so this side is the only thing that ends the spinner, and a
          // second literal here is the same drift #289 was.
          pollDeadlineRef.current = Date.now() + ABANDONED_CHAT_RUN_AFTER_MS;
          setIsPollingForAgentReply(true);
        }
      });
    },
    onStaleCheck: (convId) => {
      void tryCatch(async () => {
        const conv = await chatApi.getConversation(convId);
        if (isNil(conv) || conversationIdRef.current !== convId) return;

        if (conv.status !== ChatConversationStatus.STREAMING) {
          reconcileAndClearRef.current(convId);
        }
      });
    },
  });

  reconcileAndClearRef.current = (convId: string) => {
    const gen = streamGeneration.current;
    void reconcile(convId).then(() => clearStreamingState(gen));
  };

  const streamingQuickReplies = useMemo(
    () => chatPartUtils.extractQuickRepliesFromParts(streamingMessage),
    [streamingMessage],
  );

  useEffect(() => {
    if (streamingQuickReplies.length > 0) {
      store.setState({ quickReplies: streamingQuickReplies });
    }
  }, [streamingQuickReplies, store]);

  const isStreamActive = streamPhase !== 'idle';
  const isStreaming =
    isStreamActive ||
    sendStatusRef.current.type === 'submitting' ||
    isPollingForAgentReply;

  const messages: ChatUIMessage[] = useMemo(() => {
    const base = [...persistedMessages];
    if (optimisticUserMessage) base.push(optimisticUserMessage);
    if (streamingMessage) base.push(streamingMessage);
    return injectFilePartsIntoLastUserMessage({
      messages: liveGate
        ? withGatePart({ messages: base, gate: liveGate })
        : base,
      fileNames: lastSentFileNamesRef.current,
    });
  }, [persistedMessages, optimisticUserMessage, streamingMessage, liveGate]);

  const error =
    sendStatus.type === 'error'
      ? sendStatus.message
      : streamError
      ? streamError
      : null;

  const wasCancelled = sendStatus.type === 'cancelled';

  const streamingMessageRef = useRef(streamingMessage);
  streamingMessageRef.current = streamingMessage;

  const cancelStream = useCallback(() => {
    const currentStreaming = streamingMessageRef.current;
    stopStream();
    if (currentStreaming && currentStreaming.parts.length > 0) {
      setPersistedMessages((prev) => [...prev, currentStreaming]);
    }
    setIsPollingForAgentReply(false);
    updateSendStatus({ type: 'cancelled' });
    setOptimisticUserMessage(null);
    const convId = conversationIdRef.current;
    if (convId) {
      void chatApi.cancelConversation(convId);
    }
  }, [stopStream, updateSendStatus]);

  const createConversation = useCallback(
    async ({
      title,
      modelName,
    }: { title?: string | null; modelName?: string | null } = {}) => {
      const conv = await chatApi.createConversation({
        title: title ?? null,
        modelName: modelName ?? null,
      });
      conversationIdRef.current = conv.id;
      setConversationIdState(conv.id);
      return conv;
    },
    [],
  );

  const sendMessage = useCallback(
    async (content: string, files?: File[]) => {
      updateSendStatus({ type: 'submitting' });

      const fileNames = files?.map((f) => f.name) ?? [];
      lastSentFileNamesRef.current = fileNames;

      const optimisticUser: ChatUIMessage = {
        id: `optimistic-${Date.now()}`,
        role: 'user',
        parts: [
          { type: 'text', text: content },
          ...fileNamesToFileParts(fileNames),
        ],
      };

      setOptimisticUserMessage(optimisticUser);
      // The gate is auto-denied server-side when this message is admitted, so the card must go with it.
      setLiveGate(null);
      store.getState().resetInteractions();

      if (files && files.length > 0) {
        const oversized = files.find((f) => f.size > MAX_FILE_SIZE);
        if (oversized) {
          setOptimisticUserMessage(null);
          updateSendStatus({
            type: 'error',
            message: `File "${oversized.name}" exceeds 10 MB limit`,
          });
          return;
        }
        const { data: encodedFiles, error: fileError } = await tryCatch(
          async () => Promise.all(files.map(fileToBase64)),
        );
        if (fileError) {
          setOptimisticUserMessage(null);
          updateSendStatus({
            type: 'error',
            message: fileError.message ?? 'Failed to read attached files',
          });
          return;
        }
        pendingFilesRef.current = encodedFiles;
      } else {
        pendingFilesRef.current = undefined;
      }

      if (!conversationIdRef.current) {
        const { error: convError } = await tryCatch(async () => {
          const conv = await createConversation({
            title: content.slice(0, 100),
            modelName: modelNameRef.current,
          });
          onConversationCreatedRef.current?.(conv.id);
        });
        if (convError) {
          setOptimisticUserMessage(null);
          updateSendStatus({
            type: 'error',
            message: convError.message ?? 'Failed to start conversation',
          });
          return;
        }
        if (sendStatusRef.current.type === 'cancelled') {
          setOptimisticUserMessage(null);
          return;
        }
      }

      const convId = conversationIdRef.current;
      if (!convId) {
        setOptimisticUserMessage(null);
        updateSendStatus({
          type: 'error',
          message: 'No conversation ID',
        });
        return;
      }

      const runId = apId();
      startStream(convId);
      setActiveRunId(runId);
      updateSendStatus({ type: 'idle' });

      const { error: sendError } = await tryCatch(async () =>
        chatApi.sendMessage({
          conversationId: convId,
          content,
          runId,
          files: pendingFilesRef.current,
        }),
      );
      if (sendError) {
        stopStream();
        setOptimisticUserMessage(null);
        updateSendStatus({
          type: 'error',
          message: chatUtils.describeSendError(sendError),
        });
      }
    },
    [
      createConversation,
      startStream,
      setActiveRunId,
      stopStream,
      updateSendStatus,
      store,
    ],
  );

  const setConversationId = useCallback(
    async (id: string) => {
      stopStream();
      setIsPollingForAgentReply(false);
      updateSendStatus({ type: 'idle' });
      conversationIdRef.current = id;
      setConversationIdState(id);
      store.getState().resetInteractions();

      pendingFilesRef.current = undefined;
      lastSentFileNamesRef.current = [];
      setOptimisticUserMessage(null);
      setLiveGate(null);

      setIsLoadingHistory(true);
      const [historyResult, convResult] = await Promise.all([
        tryCatch(async () => chatApi.getMessages(id)),
        tryCatch(async () => chatApi.getConversation(id)),
      ]);
      if (conversationIdRef.current !== id) return;
      if (historyResult.error || convResult.error) {
        conversationIdRef.current = null;
        setConversationIdState(null);
        setIsLoadingHistory(false);
        updateSendStatus({
          type: 'error',
          message: 'Conversation not found',
        });
        return;
      }
      const mapped = chatUtils.mapHistoryToUIMessages(historyResult.data.data);
      const restoredReplies = chatUtils.extractQuickRepliesFromHistory(mapped);
      if (restoredReplies.length > 0) {
        store.setState({ quickReplies: restoredReplies });
      }
      restoreReceiptsIntoStore({
        data: historyResult.data.data,
        setState: store.setState,
      });
      modelNameRef.current = convResult.data.modelName ?? null;
      setModelNameState(convResult.data.modelName ?? null);
      if (convResult.data.status === ChatConversationStatus.STREAMING) {
        const lastAssistantIdx = mapped.findLastIndex(
          (m) => m.role === 'assistant',
        );
        const lastUserIdx = mapped.findLastIndex((m) => m.role === 'user');
        const isCurrentStreamingResponse =
          lastAssistantIdx >= 0 && lastAssistantIdx > lastUserIdx;
        if (isCurrentStreamingResponse) {
          setPersistedMessages(mapped.slice(0, lastAssistantIdx));
        } else {
          setPersistedMessages(mapped);
        }
        const { data: gate } = await tryCatch(() => chatApi.getPendingGate(id));
        if (conversationIdRef.current !== id) return;
        const baseParts = isCurrentStreamingResponse
          ? mapped[lastAssistantIdx].parts
          : undefined;
        const displayGatePart =
          gate && chatPartUtils.isDisplayTool(gate.toolName)
            ? {
                type: 'dynamic-tool' as const,
                toolCallId: gate.gateId,
                toolName: gate.toolName,
                title: gate.displayName,
                state: 'input-available' as const,
                input: gate.toolInput,
              }
            : undefined;
        startStream(id, {
          initialParts: displayGatePart
            ? [...(baseParts ?? []), displayGatePart]
            : baseParts,
        });
        if (gate) {
          store.setState((prev) => ({
            toolCallMeta: {
              ...prev.toolCallMeta,
              ...buildToolCallMetaFromGate(gate),
            },
          }));
        }
      } else {
        // A gated run *finishes*: the gate ends the run and the conversation settles IDLE, so this is
        // the branch a waiting approval actually lands in. Fetching the gate only while STREAMING
        // meant the one state in which a gate can exist was the one state that never looked for it.
        const { data: gate } = await tryCatch(() => chatApi.getPendingGate(id));
        if (conversationIdRef.current !== id) return;
        setPersistedMessages(
          gate ? withGatePart({ messages: mapped, gate }) : mapped,
        );
        if (gate) {
          store.setState((prev) => ({
            toolCallMeta: {
              ...prev.toolCallMeta,
              ...buildToolCallMetaFromGate(gate),
            },
          }));
        }
      }
      setIsLoadingHistory(false);
    },
    [stopStream, startStream, updateSendStatus, store],
  );

  useQuery({
    queryKey: ['chat-agent-poll', conversationId],
    queryFn: async () => {
      if (!conversationId || conversationIdRef.current !== conversationId)
        return null;
      // Past the deadline the STREAMING status describes a run the server itself has written off,
      // and polling it is a spinner with nothing behind it.
      if (Date.now() > pollDeadlineRef.current) {
        setIsPollingForAgentReply(false);
        return null;
      }
      const [messagesResult, convResult] = await Promise.all([
        chatApi.getMessages(conversationId),
        chatApi.getConversation(conversationId),
      ]);
      if (conversationIdRef.current !== conversationId) return null;
      const mapped = chatUtils.mapHistoryToUIMessages(messagesResult.data);
      const current = persistedMessagesRef.current;
      const hasChanged =
        mapped.length !== current.length ||
        mapped.some((m, i) => m.parts.length !== current[i]?.parts.length);
      if (convResult.status !== ChatConversationStatus.STREAMING) {
        setIsPollingForAgentReply(false);
      }
      // Checked in both states, not only while STREAMING. A gate ends the run, so by the time one
      // exists the conversation is IDLE — the old `else` branch here could only ever run for a
      // conversation that had no gate to find.
      const hasBlockingCard = chatStoreSelectors.hasBlockingCard({
        state: store.getState(),
        lastAssistantMessage: mapped[mapped.length - 1],
      });
      const { data: gate } = hasBlockingCard
        ? { data: null }
        : await tryCatch(() => chatApi.getPendingGate(conversationId));
      if (conversationIdRef.current !== conversationId) return null;
      if (hasChanged || gate) {
        setPersistedMessages(
          gate ? withGatePart({ messages: mapped, gate }) : mapped,
        );
        const restoredReplies =
          chatUtils.extractQuickRepliesFromHistory(mapped);
        if (restoredReplies.length > 0) {
          store.setState({ quickReplies: restoredReplies });
        }
      }
      if (gate) {
        store.setState((prev) => ({
          toolCallMeta: {
            ...prev.toolCallMeta,
            ...buildToolCallMetaFromGate(gate),
          },
        }));
      }
      return mapped;
    },
    enabled: isPollingForAgentReply && !isStreamActive,
    refetchInterval: AGENT_POLL_INTERVAL_MS,
  });

  // The approval cards live under the store, not under this hook's props, so the store is what has to
  // know which conversation to post to — and how to hand the resumed run back so the reply streams
  // instead of appearing only on the next poll.
  useEffect(() => {
    store.getState().bindConversation({
      conversationId,
      onRunResumed: (runId: string) => {
        if (conversationIdRef.current !== conversationId || !conversationId) {
          return;
        }
        startStream(conversationId);
        setActiveRunId(runId);
      },
    });
  }, [conversationId, store, startStream, setActiveRunId]);

  const setModelName = useCallback(async (newModelName: string) => {
    modelNameRef.current = newModelName;
    setModelNameState(newModelName);
    const convId = conversationIdRef.current;
    if (convId) {
      await chatApi
        .updateConversation(convId, { modelName: newModelName })
        .catch(() => undefined);
    }
  }, []);

  return {
    conversationId,
    modelName,
    messages,
    isStreaming,
    wasCancelled,
    isLoadingHistory,
    error,
    sendMessage,
    cancelStream,
    setConversationId,
    setModelName,
  };
}
