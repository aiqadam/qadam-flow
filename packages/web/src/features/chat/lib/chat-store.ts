import {
  ActionPreviewEvent,
  ActionReceiptEvent,
  BatchProgressData,
  isObject,
  omit,
} from '@aiqadam/shared';
import { StoreApi, create } from 'zustand';

import { chatApi } from './chat-api';
import { MultiQuestion } from './chat-store-types';
import { AnyToolPart, ChatUIMessage, chatPartUtils } from './chat-types';
import { chatUtils } from './chat-utils';

// Fire-and-forget by design: the answer starts a run, and the run reaches the UI over the socket
// like any other. `onResumed` is how the chat hook learns the run id it should start rendering.
function sendApprovalDecision({
  conversationId,
  gateId,
  approved,
  reason,
  toolCallId,
  onRunResumed,
}: {
  conversationId: string | null;
  gateId: string;
  approved: boolean;
  reason?: string;
  toolCallId?: string;
  onRunResumed: ((runId: string) => void) | null;
}): void {
  if (!conversationId) return;
  void chatApi
    .approveToolCall({ conversationId, gateId, approved, reason, toolCallId })
    .then((started) => onRunResumed?.(started.runId))
    .catch(() => undefined);
}

function extractQuestionsFromInput(part: AnyToolPart | null): MultiQuestion[] {
  if (!part) return [];
  const input = part.input as { questions?: MultiQuestion[] } | undefined;
  return input?.questions ?? [];
}

function isNotDismissed(
  part: AnyToolPart | null,
  state: ChatStoreState,
): part is AnyToolPart {
  if (!part) return false;
  return !state.dismissedGateIds[chatPartUtils.getToolCallId(part)];
}

// `approvalRequest` used to live here, written only by a socket event nothing emitted and read only by
// selectors that therefore never fired. A waiting approval is now a state on the tool part itself,
// which is strictly better: the part is persisted and replayed, so the card survives a reload, while
// anything held here is lost the moment the page does.
export type ToolCallMeta = {
  batchProgress?: BatchProgressData;
  actionPreview?: ActionPreviewEvent;
  actionReceipt?: ActionReceiptEvent;
};

export type ChatStoreState = {
  quickReplies: string[];
  toolCallMeta: Record<string, ToolCallMeta>;
  dismissedGateIds: Record<string, true>;
  lastDismissedFormId: string | null;
  // Held here because the approval endpoint is addressed under the conversation, and the cards that
  // answer a gate are rendered from this store rather than from the chat hook's props.
  conversationId: string | null;
  onRunResumed: ((runId: string) => void) | null;

  // `_payload` is deliberately unread. The display-tool cards (connection picker, questions, project
  // picker) call `approveGate(toolCallId, answer)` and were never served by this endpoint — it is
  // addressed by approval id and no gate exists for a display tool — so their payload has always gone
  // nowhere. #264 does not wire them; dropping the parameter would rewrite five call sites and lose
  // the record of what they intend to send.
  approveGate: (gateId: string, _payload?: Record<string, unknown>) => void;
  rejectGate: (gateId: string, reason?: string) => void;
  dismissGate: (gateId: string) => void;
  dismissForm: (messageId: string) => void;
  bindConversation: (params: {
    conversationId: string | null;
    onRunResumed: ((runId: string) => void) | null;
  }) => void;
  resetInteractions: () => void;
};

export type ChatStore = ReturnType<typeof createChatStore>;

function dismissAndCleanup(
  prev: ChatStoreState,
  gateId: string,
): Partial<ChatStoreState> {
  return {
    dismissedGateIds: { ...prev.dismissedGateIds, [gateId]: true },
    toolCallMeta: omit(prev.toolCallMeta, [gateId]),
  };
}

export const createChatStore = () =>
  create<ChatStoreState>((set, get) => ({
    quickReplies: [],
    toolCallMeta: {},
    dismissedGateIds: {},
    lastDismissedFormId: null,
    conversationId: null,
    onRunResumed: null,

    approveGate: (gateId: string, _payload?: Record<string, unknown>) => {
      const { conversationId, onRunResumed } = get();
      set((prev) => dismissAndCleanup(prev, gateId));
      sendApprovalDecision({
        conversationId,
        gateId,
        approved: true,
        onRunResumed,
      });
    },
    rejectGate: (gateId: string, reason?: string) => {
      const { conversationId, onRunResumed } = get();
      set((prev) => dismissAndCleanup(prev, gateId));
      sendApprovalDecision({
        conversationId,
        gateId,
        approved: false,
        reason,
        onRunResumed,
      });
    },
    dismissGate: (gateId: string) => {
      set((prev) => dismissAndCleanup(prev, gateId));
    },
    dismissForm: (messageId: string) => {
      set({ lastDismissedFormId: messageId });
    },
    bindConversation: ({ conversationId, onRunResumed }) => {
      set({ conversationId, onRunResumed });
    },
    // Deliberately does not clear `conversationId`/`onRunResumed`: those describe which conversation
    // the store is bound to, not the interaction state of a turn, and dropping them on every send
    // would leave the next card unable to post.
    resetInteractions: () => {
      set({
        quickReplies: [],
        toolCallMeta: {},
        dismissedGateIds: {},
        lastDismissedFormId: null,
      });
    },
  }));

function selectActiveDisplayTool({
  state,
  lastAssistantMessage,
}: {
  state: ChatStoreState;
  lastAssistantMessage: ChatUIMessage | undefined;
}): AnyToolPart | null {
  const part = chatPartUtils.findLastToolPart({
    message: lastAssistantMessage,
    predicate: (name, p) =>
      chatPartUtils.isDisplayTool(name) &&
      name !== 'ap_show_quick_replies' &&
      p.state === 'input-available',
  });
  return isNotDismissed(part, state) ? part : null;
}

function selectPendingPlanApproval({
  state,
  lastAssistantMessage,
}: {
  state: ChatStoreState;
  lastAssistantMessage: ChatUIMessage | undefined;
}): AnyToolPart | null {
  const part = chatPartUtils.findLastToolPart({
    message: lastAssistantMessage,
    predicate: (name, p) =>
      name === 'ap_request_plan_approval' && p.state === 'input-available',
  });
  return isNotDismissed(part, state) ? part : null;
}

function selectPendingActionPreview({
  state,
  lastAssistantMessage,
}: {
  state: ChatStoreState;
  lastAssistantMessage: ChatUIMessage | undefined;
}): ActionPreviewEvent | null {
  const part = chatPartUtils.findLastToolPart({
    message: lastAssistantMessage,
    predicate: (_name, p) => {
      if (p.state !== 'input-available') return false;
      const id = chatPartUtils.getToolCallId(p);
      return !!id && !!state.toolCallMeta[id]?.actionPreview;
    },
  });
  if (!isNotDismissed(part, state)) return null;
  const toolCallId = chatPartUtils.getToolCallId(part);
  return state.toolCallMeta[toolCallId]?.actionPreview ?? null;
}

/**
 * The approval card's data, read off the tool part itself.
 *
 * It used to require `state === 'input-available'` **and** `toolCallMeta[id].approvalRequest`, and
 * the only thing that ever wrote that meta was a socket event nothing emitted — so the card could not
 * appear at all, in either direction. `approval-requested` is the state both sources of truth already
 * produce: `chunk-reducer.ts` sets it from the live SDK chunk, and `chat-utils.ts` sets it when a
 * persisted `TOOL_APPROVAL_REQUEST` part is replayed after a reload. Nothing here depends on the
 * socket, which is what makes the card survive a page load.
 */
function selectPendingMcpApproval({
  state,
  lastAssistantMessage,
}: {
  state: ChatStoreState;
  lastAssistantMessage: ChatUIMessage | undefined;
}): PendingApprovalCard | null {
  const part = chatPartUtils.findLastToolPart({
    message: lastAssistantMessage,
    predicate: (_name, p) => chatPartUtils.isApprovalRequested(p),
  });
  if (!part) return null;
  const approvalId = chatPartUtils.getApprovalId(part);
  // Dismissal is keyed on the approval id, not the tool call id: the approval id is what the endpoint
  // is addressed with, so keying them the same way is what makes "clicked Approve" and "hid the card"
  // refer to the same thing.
  if (!approvalId || state.dismissedGateIds[approvalId]) return null;
  const toolName = chatPartUtils.getToolPartName(part);
  return {
    approvalId,
    toolCallId: chatPartUtils.getToolCallId(part),
    toolName,
    displayName: chatUtils.formatToolActionName({ part }),
    toolInput: isObject(part.input) ? part.input : {},
  };
}

function selectActiveQuestions({
  state,
  lastAssistantMessage,
}: {
  state: ChatStoreState;
  lastAssistantMessage: ChatUIMessage | undefined;
}): MultiQuestion[] {
  const activeTool = selectActiveDisplayTool({ state, lastAssistantMessage });
  if (
    activeTool &&
    chatPartUtils.getToolPartName(activeTool) === 'ap_show_questions'
  ) {
    return extractQuestionsFromInput(activeTool);
  }
  const historyPart = chatPartUtils.findLastToolPart({
    message: lastAssistantMessage,
    predicate: (name, p) =>
      name === 'ap_show_questions' && p.state !== 'output-available',
  });
  return extractQuestionsFromInput(historyPart);
}

function selectHasActiveForm({
  state,
  lastAssistantMessage,
}: {
  state: ChatStoreState;
  lastAssistantMessage: ChatUIMessage | undefined;
}): boolean {
  const questions = selectActiveQuestions({ state, lastAssistantMessage });
  if (questions.length === 0) return false;
  const activeTool = selectActiveDisplayTool({ state, lastAssistantMessage });
  if (
    activeTool &&
    chatPartUtils.getToolPartName(activeTool) === 'ap_show_questions'
  ) {
    return true;
  }
  return (
    !!lastAssistantMessage &&
    lastAssistantMessage.id !== state.lastDismissedFormId
  );
}

function selectHasBlockingCard({
  state,
  lastAssistantMessage,
}: {
  state: ChatStoreState;
  lastAssistantMessage: ChatUIMessage | undefined;
}): boolean {
  const part = chatPartUtils.findLastToolPart({
    message: lastAssistantMessage,
    predicate: (name, p) => {
      // A waiting approval blocks the composer, and it is the one blocking card whose state is not
      // `input-available` — a gated call ends the run, so the part settles into `approval-requested`.
      if (chatPartUtils.isApprovalRequested(p)) {
        const approvalId = chatPartUtils.getApprovalId(p);
        return !!approvalId && !state.dismissedGateIds[approvalId];
      }
      if (p.state !== 'input-available') return false;
      const id = chatPartUtils.getToolCallId(p);
      if (state.dismissedGateIds[id]) return false;
      if (chatPartUtils.isDisplayTool(name) && name !== 'ap_show_quick_replies')
        return true;
      if (name === 'ap_request_plan_approval') return true;
      return !!state.toolCallMeta[id]?.actionPreview;
    },
  });
  return part !== null;
}

function selectBatchProgress({
  state,
  toolCallId,
}: {
  state: ChatStoreState;
  toolCallId: string;
}): BatchProgressData | undefined {
  return state.toolCallMeta[toolCallId]?.batchProgress;
}

export const chatStoreSelectors = {
  activeDisplayTool: selectActiveDisplayTool,
  pendingPlanApproval: selectPendingPlanApproval,
  pendingMcpApproval: selectPendingMcpApproval,
  pendingActionPreview: selectPendingActionPreview,
  activeQuestions: selectActiveQuestions,
  hasActiveForm: selectHasActiveForm,
  hasBlockingCard: selectHasBlockingCard,
  batchProgress: selectBatchProgress,
};

export type PendingApprovalCard = {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  displayName: string;
  toolInput: Record<string, unknown>;
};

export type SetChatStore = StoreApi<ChatStoreState>['setState'];
export type GetChatStore = StoreApi<ChatStoreState>['getState'];
