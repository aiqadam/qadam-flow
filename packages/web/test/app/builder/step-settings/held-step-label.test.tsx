// @vitest-environment jsdom
import { FlowActionType, QadamAction } from '@aiqadam/shared';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { HeldStepLabel } from '@/app/builder/step-settings/held-step-label';

// i18next is not initialised in this harness, so `t` answers the key itself.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const registry = vi.hoisted(() => ({
  moves: [] as { stepName: string; qadamName: string; fromVersion: string }[],
}));

// The hold hook is the one thing this label reads from the rest of the app; mocking it keeps the
// test to the label's own matching and show/hide logic.
vi.mock('@/features/qadams', () => ({
  qadamsHooks: {
    useHeldPinMoves: () => ({ heldPinMoves: registry.moves, isLoading: false }),
  },
  formUtils: {},
  qadamSelectorUtils: {},
  qadamsApi: {},
}));

const QADAM = '@aiqadam/qadam-test-email';

function pieceStep({ qadamVersion }: { qadamVersion: string }): QadamAction {
  return {
    name: 'step_1',
    type: FlowActionType.PIECE,
    valid: true,
    displayName: 'Send Email',
    lastUpdatedDate: '2026-08-01T00:00:00.000Z',
    settings: {
      actionName: 'send_email',
      qadamName: QADAM,
      qadamVersion,
      propertySettings: {},
      input: {},
    },
  };
}

const LABEL = 'Held step';
const EXPLANATION =
  'A version change for this step was reverted, so a publish will not move it again until you change its version.';

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function render({
  qadamVersion,
  moves,
}: {
  qadamVersion: string;
  moves: { stepName: string; qadamName: string; fromVersion: string }[];
}): Promise<string> {
  registry.moves = moves;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <HeldStepLabel step={pieceStep({ qadamVersion })} flowId="flow_1" />,
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

// ADR-0004 "Following `main`": the hold matches a step by its `{stepName, qadamName, fromVersion}`
// — the same key the server builds — whatever kind of pin it is. The label is informational, so it
// is shown for a held step and never for a step the flow does not hold.
describe('HeldStepLabel', () => {
  it('labels a step the flow holds', async () => {
    const text = await render({
      qadamVersion: '0.4.2',
      moves: [{ stepName: 'step_1', qadamName: QADAM, fromVersion: '0.4.2' }],
    });

    expect(text).toContain(LABEL);
    expect(text).toContain(EXPLANATION);
  });

  it('matches a snapshot pin the flow holds', async () => {
    const text = await render({
      qadamVersion: '1.3.0-main.412',
      moves: [
        {
          stepName: 'step_1',
          qadamName: QADAM,
          fromVersion: '1.3.0-main.412',
        },
      ],
    });

    expect(text).toContain(LABEL);
  });

  it('says nothing when the flow holds no step', async () => {
    const text = await render({ qadamVersion: '0.4.2', moves: [] });

    expect(text).not.toContain(LABEL);
    expect(text).not.toContain(EXPLANATION);
  });

  it('stays silent for a release pin that is not the held version', async () => {
    const text = await render({
      qadamVersion: '0.4.5',
      moves: [{ stepName: 'step_1', qadamName: QADAM, fromVersion: '0.4.2' }],
    });

    expect(text).not.toContain(LABEL);
  });

  it('stays silent when the hold names another step or qadam', async () => {
    const text = await render({
      qadamVersion: '0.4.2',
      moves: [
        { stepName: 'step_2', qadamName: QADAM, fromVersion: '0.4.2' },
        { stepName: 'step_1', qadamName: '@aiqadam/other', fromVersion: '0.4.2' },
      ],
    });

    expect(text).not.toContain(LABEL);
  });

  it('reads a range-prefixed pin off its exact version', async () => {
    const text = await render({
      qadamVersion: '~0.4.2',
      moves: [{ stepName: 'step_1', qadamName: QADAM, fromVersion: '0.4.2' }],
    });

    expect(text).toContain(LABEL);
  });
});
