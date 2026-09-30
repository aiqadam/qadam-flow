// @vitest-environment jsdom
import {
  FlowRun,
  FlowRunStatus,
  RunEnvironment,
  WebsocketClientEvent,
} from '@aiqadam/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  Mock,
  vi,
} from 'vitest';

import { flowCanvasHooks } from '@/app/builder/flow-canvas/hooks';

// #580: the run view follows a production run by refetching on FLOW_RUN_PROGRESS, with the 5 s poll
// kept as the fallback. The poll never fires within these tests, so every refetch counted here came
// from the mount or from an event.
const harness = vi.hoisted(() => {
  const socketHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const held: { getPopulated: Promise<void> | null } = { getPopulated: null };
  const state: {
    run: FlowRun | null;
    setRun: Mock;
    flowVersion: { id: string };
  } = {
    run: null,
    setRun: vi.fn(),
    flowVersion: { id: 'version-1' },
  };
  return {
    socketHandlers,
    held,
    state,
    pathname: '/projects/project-1/runs/run-1',
    getPopulated: vi.fn(),
    socket: {
      on: (event: string, listener: (payload: unknown) => void) => {
        const listeners = socketHandlers.get(event) ?? new Set();
        listeners.add(listener);
        socketHandlers.set(event, listeners);
      },
      off: (event: string, listener: (payload: unknown) => void) => {
        socketHandlers.get(event)?.delete(listener);
      },
    },
  };
});

vi.mock('@/components/providers/socket-provider', () => ({
  useSocket: () => harness.socket,
}));

vi.mock('@/app/builder/builder-hooks', () => ({
  useBuilderStateContext: (
    selector: (state: typeof harness.state) => unknown,
  ) => selector(harness.state),
}));

vi.mock('react-use', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-use')>()),
  useLocation: () => ({ pathname: harness.pathname }),
}));

vi.mock('@/features/flow-runs', () => ({
  flowRunsApi: { getPopulated: harness.getPopulated },
  flowRunUtils: {},
}));

function makeRun(overrides: RunOverrides = {}): FlowRun {
  return {
    id: 'run-1',
    projectId: 'project-1',
    flowId: 'flow-1',
    flowVersionId: 'version-1',
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    status: FlowRunStatus.RUNNING,
    environment: RunEnvironment.PRODUCTION,
    failParentOnFailure: true,
    tags: [],
    steps: {},
    ...overrides,
  };
}

function progressListenerCount(): number {
  return (
    harness.socketHandlers.get(WebsocketClientEvent.FLOW_RUN_PROGRESS)?.size ??
    0
  );
}

async function emitProgress(runId: string): Promise<void> {
  const listeners =
    harness.socketHandlers.get(WebsocketClientEvent.FLOW_RUN_PROGRESS) ??
    new Set();
  await act(async () => {
    for (const listener of [...listeners]) {
      listener({ runId });
    }
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let queryClient: QueryClient | undefined;

const Harness = () => {
  flowCanvasHooks.useListenToExistingRun();
  return null;
};

const mount = async (): Promise<void> => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient = client;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    );
  });
  await settle();
};

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(() => {
  harness.socketHandlers.clear();
  harness.held.getPopulated = null;
  harness.state.run = makeRun();
  harness.pathname = '/projects/project-1/runs/run-1';
  harness.state.setRun.mockReset();
  harness.getPopulated.mockReset();
  harness.getPopulated.mockImplementation(async (id: string) => {
    await harness.held.getPopulated;
    return makeRun({ id });
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
  queryClient = undefined;
});

describe('flowCanvasHooks.useListenToExistingRun', () => {
  it('refetches the run as soon as the server says a snapshot of it was stored', async () => {
    await mount();
    expect(harness.getPopulated).toHaveBeenCalledTimes(1);

    await emitProgress('run-1');
    await settle();

    expect(harness.getPopulated).toHaveBeenCalledTimes(2);
    expect(harness.state.setRun).toHaveBeenCalledTimes(2);
    expect(queryClient?.getQueryState(['refetched-run', 'run-1'])?.status).toBe(
      'success',
    );
  });

  it('ignores progress of another run in the same project room', async () => {
    await mount();

    await emitProgress('run-2');
    await settle();

    expect(harness.getPopulated).toHaveBeenCalledTimes(1);
  });

  it('joins a refetch already in flight instead of cancelling it on every event', async () => {
    await mount();
    let release: () => void = () => undefined;
    harness.held.getPopulated = new Promise<void>((resolve) => {
      release = resolve;
    });

    await emitProgress('run-1');
    await emitProgress('run-1');
    await emitProgress('run-1');
    await act(async () => {
      release();
    });
    await settle();

    expect(harness.getPopulated).toHaveBeenCalledTimes(2);
    expect(harness.state.setRun).toHaveBeenCalledTimes(2);
  });

  it('does not listen for a run that has already finished', async () => {
    harness.state.run = makeRun({ status: FlowRunStatus.SUCCEEDED });
    await mount();

    expect(progressListenerCount()).toBe(0);
    expect(harness.getPopulated).not.toHaveBeenCalled();
  });

  it('does not listen for a test run', async () => {
    harness.state.run = makeRun({ environment: RunEnvironment.TESTING });
    await mount();

    expect(progressListenerCount()).toBe(0);
  });

  it('does not listen outside the runs page', async () => {
    harness.pathname = '/projects/project-1/flows/flow-1';
    await mount();

    expect(progressListenerCount()).toBe(0);
  });

  it('stops listening once unmounted', async () => {
    await mount();
    expect(progressListenerCount()).toBe(1);

    await act(async () => {
      root?.unmount();
    });
    root = undefined;

    expect(progressListenerCount()).toBe(0);
  });
});

type RunOverrides = Partial<Pick<FlowRun, 'id' | 'status' | 'environment'>>;
