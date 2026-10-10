// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { FrameworkUnsupportedLabel } from '@/app/builder/step-settings/framework-unsupported-label';

// i18next is not initialised in this harness, so `t` answers the key itself.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const registry = vi.hoisted(() => ({
  unsupportedStepNames: undefined as string[] | undefined,
}));

// The census read is the one thing this label takes from the rest of the app; mocking it keeps the
// test to the label's own show/hide logic.
vi.mock('@/features/qadams', () => ({
  qadamsHooks: {
    useUnsupportedFrameworkSteps: () => ({
      unsupportedStepNames: registry.unsupportedStepNames,
      isLoading: false,
    }),
  },
}));

const LABEL = 'Framework version no longer supported';
const EXPLANATION =
  'This step is pinned to a qadam version built for a framework version this release no longer runs. Update this step.';

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function render({
  unsupportedStepNames,
}: {
  unsupportedStepNames: string[] | undefined;
}): Promise<string> {
  registry.unsupportedStepNames = unsupportedStepNames;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <FrameworkUnsupportedLabel
        stepName="step_1"
        flowId="flow_1"
        flowVersionId="version_1"
        flowVersionUpdated="2026-01-01T00:00:00.000Z"
      />,
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

// ADR-0002 (#803): the server names the steps of the open flow version this release no longer
// runs; the label shows for those and for no other step, and stays silent until the read answers.
describe('FrameworkUnsupportedLabel', () => {
  it('marks a step the census names', async () => {
    const text = await render({ unsupportedStepNames: ['step_1'] });

    expect(text).toContain(LABEL);
    expect(text).toContain(EXPLANATION);
  });

  it('stays silent for a step the census does not name', async () => {
    const text = await render({ unsupportedStepNames: ['step_2'] });

    expect(text).not.toContain(LABEL);
  });

  it('stays silent while the read has not answered, or failed', async () => {
    const text = await render({ unsupportedStepNames: undefined });

    expect(text).not.toContain(LABEL);
  });
});
