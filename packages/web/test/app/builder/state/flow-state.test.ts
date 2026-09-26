// @vitest-environment jsdom
import {
  EmptyTrigger,
  FlowOperationType,
  FlowStatus,
  FlowOperationStatus,
  FlowTriggerType,
  FlowVersion,
  FlowVersionState,
  NoteColorVariant,
  PopulatedFlow,
} from '@aiqadam/shared';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, StoreApi } from 'zustand/vanilla';

import { BuilderState } from '@/app/builder/builder-hooks';
import { createFlowState, FlowState } from '@/app/builder/state/flow-state';

const updateMock = vi.fn();
vi.mock('@/features/flows', () => ({
  flowsApi: { update: (...args: unknown[]) => updateMock(...args) },
  sampleDataHooks: { invalidateSampleData: vi.fn() },
}));

const createTestFlowVersion = (): FlowVersion => {
  const trigger: EmptyTrigger = {
    name: 'trigger',
    valid: false,
    displayName: 'Select Trigger',
    type: FlowTriggerType.EMPTY,
    settings: {},
    lastUpdatedDate: '2026-01-01T00:00:00.000Z',
  };
  return {
    id: 'version-id',
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
    flowId: 'flow-id',
    displayName: 'Test flow',
    trigger,
    updatedBy: null,
    valid: false,
    schemaVersion: null,
    agentIds: [],
    state: FlowVersionState.DRAFT,
    connectionIds: [],
    backupFiles: null,
    notes: [],
  };
};

const createTestFlow = (version: FlowVersion): PopulatedFlow => ({
  id: 'flow-id',
  created: '2026-01-01T00:00:00.000Z',
  updated: '2026-01-01T00:00:00.000Z',
  projectId: 'project-id',
  externalId: 'external-id',
  ownerId: null,
  folderId: null,
  status: FlowStatus.DISABLED,
  publishedVersionId: null,
  metadata: null,
  operationStatus: FlowOperationStatus.NONE,
  timeSavedPerRun: null,
  templateId: null,
  createdBy: null,
  version,
});

// `applyOperation` reads `state.readonly` from a sibling slice it is normally composed with in
// builder-hooks.ts (`operationListeners` is already part of `FlowState` itself) — a minimal
// stand-in is enough to exercise this slice alone. `createFlowState`'s own `get`/`set` params are
// typed against the full `BuilderState` union (every slice), but this store only ever implements
// `FlowState` plus that one borrowed field, and nothing in the code path under test reads any
// other slice's properties — the cast documents that gap rather than papering over a real one.
type TestState = FlowState & { readonly: boolean };

const buildTestStore = (
  flow: PopulatedFlow,
  flowVersion: FlowVersion,
): StoreApi<TestState> =>
  createStore<TestState>((set, get) => ({
    readonly: false,
    ...createFlowState(
      {
        flow,
        flowVersion,
        outputSampleData: {},
        inputSampleData: {},
        queryClient: new QueryClient(),
      },
      get as unknown as StoreApi<BuilderState>['getState'],
      set as unknown as StoreApi<BuilderState>['setState'],
    ),
  }));

describe('createFlowState — applyOperation onError', () => {
  beforeEach(() => {
    updateMock.mockClear();
  });

  it('calls the optional onError callback (and not onSuccess) when the server update rejects, without affecting callers that omit it', async () => {
    const flowVersion = createTestFlowVersion();
    const flow = createTestFlow(flowVersion);
    updateMock.mockRejectedValueOnce(new Error('network down'));

    const store = buildTestStore(flow, flowVersion);
    const onSuccess = vi.fn();
    const onError = vi.fn();

    store.getState().applyOperation(
      {
        type: FlowOperationType.UPDATE_LOCALE_SOURCE,
        request: { localeSource: 'ru' },
      },
      onSuccess,
      onError,
    );

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('does not throw when a caller omits onError entirely (backwards compatible)', async () => {
    const flowVersion = createTestFlowVersion();
    const flow = createTestFlow(flowVersion);
    updateMock.mockRejectedValueOnce(new Error('network down'));

    const store = buildTestStore(flow, flowVersion);

    expect(() =>
      store.getState().applyOperation({
        type: FlowOperationType.UPDATE_LOCALE_SOURCE,
        request: { localeSource: 'ru' },
      }),
    ).not.toThrow();

    await vi.waitFor(() => {
      expect(updateMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe('createFlowState — a failed update halts later updates visibly', () => {
  beforeEach(() => {
    updateMock.mockReset();
  });

  it('clears saving and sets queueHalted after a failed update', async () => {
    const flowVersion = createTestFlowVersion();
    const flow = createTestFlow(flowVersion);
    updateMock.mockRejectedValueOnce(new Error('network down'));
    const store = buildTestStore(flow, flowVersion);
    const onError = vi.fn();

    store.getState().applyOperation(
      {
        type: FlowOperationType.UPDATE_LOCALE_SOURCE,
        request: { localeSource: 'ru' },
      },
      undefined,
      onError,
    );
    expect(store.getState().saving).toBe(true);

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });
    expect(store.getState().saving).toBe(false);
    expect(store.getState().queueHalted).toBe(true);
  });

  it('refuses a later edit with onError, without sending it or applying it locally', async () => {
    const flowVersion = createTestFlowVersion();
    const flow = createTestFlow(flowVersion);
    updateMock.mockRejectedValueOnce(new Error('network down'));
    const store = buildTestStore(flow, flowVersion);

    store.getState().applyOperation({
      type: FlowOperationType.UPDATE_LOCALE_SOURCE,
      request: { localeSource: 'ru' },
    });
    await vi.waitFor(() => {
      expect(store.getState().queueHalted).toBe(true);
    });
    const versionAfterFailure = store.getState().flowVersion;

    const onSuccess = vi.fn();
    const onError = vi.fn();
    store.getState().applyOperation(
      {
        type: FlowOperationType.UPDATE_LOCALE_SOURCE,
        request: { localeSource: 'uz' },
      },
      onSuccess,
      onError,
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(store.getState().flowVersion).toBe(versionAfterFailure);
    expect(store.getState().saving).toBe(false);
  });

  it('reports an update already queued behind the failed one through onError instead of sending it', async () => {
    const flowVersion = createTestFlowVersion();
    const flow = createTestFlow(flowVersion);
    updateMock.mockRejectedValueOnce(new Error('network down'));
    const store = buildTestStore(flow, flowVersion);

    const firstOnError = vi.fn();
    const queuedOnSuccess = vi.fn();
    const queuedOnError = vi.fn();
    store.getState().applyOperation(
      {
        type: FlowOperationType.UPDATE_LOCALE_SOURCE,
        request: { localeSource: 'ru' },
      },
      undefined,
      firstOnError,
    );
    store.getState().applyOperation(
      {
        type: FlowOperationType.UPDATE_LOCALE_SOURCE,
        request: { localeSource: 'uz' },
      },
      queuedOnSuccess,
      queuedOnError,
    );

    await vi.waitFor(() => {
      expect(queuedOnError).toHaveBeenCalledTimes(1);
    });
    expect(firstOnError).toHaveBeenCalledTimes(1);
    expect(queuedOnSuccess).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(store.getState().saving).toBe(false);
  });

  it('reports a debounced edit made before the failure through onError once its debounce fires, instead of sending it', async () => {
    const flowVersion = createTestFlowVersion();
    const flow = createTestFlow(flowVersion);
    updateMock.mockRejectedValueOnce(new Error('network down'));
    const store = buildTestStore(flow, flowVersion);

    const debouncedOnError = vi.fn();
    store.getState().applyOperation({
      type: FlowOperationType.UPDATE_LOCALE_SOURCE,
      request: { localeSource: 'ru' },
    });
    store.getState().applyOperation(
      {
        type: FlowOperationType.ADD_NOTE,
        request: {
          id: 'note-1',
          content: 'hello',
          color: NoteColorVariant.BLUE,
          position: { x: 0, y: 0 },
          size: { width: 100, height: 100 },
        },
      },
      undefined,
      debouncedOnError,
    );

    await vi.waitFor(
      () => {
        expect(debouncedOnError).toHaveBeenCalledTimes(1);
      },
      { timeout: 3000 },
    );
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(store.getState().saving).toBe(false);
  });
});
