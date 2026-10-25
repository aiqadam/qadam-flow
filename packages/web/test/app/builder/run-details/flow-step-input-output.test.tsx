// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { FlowStepInputOutput } from '@/app/builder/run-details/flow-step-input-output';

const harness = vi.hoisted(() => {
  const trigger = {
    type: 'PIECE',
    name: 'trigger',
    displayName: 'Census Trigger',
    valid: true,
    lastUpdatedDate: '2026-01-01T00:00:00.000Z',
    settings: {
      qadamName: '@aiqadam/qadam-census',
      qadamVersion: '1.0.0',
      triggerName: 'new_item',
      input: {},
      propertySettings: {},
    },
  };
  return {
    trigger,
    state: {
      run: {
        id: 'run-1',
        projectId: 'project-1',
        flowId: 'flow-1',
        flowVersionId: 'version-1',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        status: 'SUCCEEDED',
        environment: 'PRODUCTION',
        failParentOnFailure: true,
        tags: [],
        steps: {},
        logsFileId: 'logs-1',
      },
      loopsIndexes: {},
      flowVersion: {
        id: 'version-1',
        flowId: 'flow-1',
        displayName: 'Census flow',
        updated: '2026-01-01T00:00:00.000Z',
        trigger,
      },
      selectedStep: 'trigger',
    },
  };
});

vi.mock('@/app/builder/builder-hooks', () => ({
  useBuilderStateContext: (
    selector: (state: typeof harness.state) => unknown,
  ) => selector(harness.state),
}));

vi.mock('@/features/flow-runs', () => ({
  flowRunUtils: { extractStepOutput: () => undefined },
}));

vi.mock('@/features/qadams', () => ({
  qadamsHooks: { useQadam: () => ({ qadamModel: null }) },
}));

vi.mock('@/hooks/flags-hooks', () => ({
  flagsHooks: { useFlag: () => ({ data: 30 }) },
}));

vi.mock('@/app/builder/test-step/agent-test-step', () => ({
  isRunAgent: () => false,
}));

vi.mock('@/app/builder/step-data/step-data-panel-view-toggle', () => ({
  StepDataPanelViewToggle: () => null,
}));

vi.mock('@/app/builder/step-settings/framework-unsupported-label', () => ({
  FrameworkUnsupportedLabel: ({ stepName }: { stepName: string }) => (
    <div>framework mark for {stepName}</div>
  ),
}));

vi.mock('@/app/builder/step-settings/pre-release-build-label', () => ({
  PreReleaseBuildLabel: () => null,
}));

vi.mock('@/app/builder/step-settings/update-available-label', () => ({
  UpdateAvailableLabel: () => null,
}));

vi.mock('@/app/builder/step-settings/held-step-label', () => ({
  HeldStepLabel: () => null,
}));

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function render(): Promise<string> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={new QueryClient()}>
        <FlowStepInputOutput />
      </QueryClientProvider>,
    );
  });
  return container.textContent ?? '';
}

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
});

// ADR-0002 (#803): an unsupported step can end up with no output, so the run's step detail lands
// in the "didn't run" branch — the mark has to be there too, not only in the output view.
describe('FlowStepInputOutput', () => {
  it('shows the framework mark in the run step detail when the step has no output', async () => {
    const text = await render();

    expect(text).toContain('This step didn\'t run');
    expect(text).toContain('framework mark for trigger');
  });
});
