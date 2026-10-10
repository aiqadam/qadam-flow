// @vitest-environment jsdom
import { AgentToolType, FlowActionType, QadamAction } from '@aiqadam/shared';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { UpdateThisStepLabel } from '@/app/builder/step-settings/update-this-step-label';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const dialogCalls: unknown[] = [];

vi.mock(
  '@/app/builder/step-settings/update-qadam-version-dialog/update-qadam-version-dialog',
  () => ({
    UpdatePieceVersionDialog: (props: unknown) => {
      dialogCalls.push(props);
      return null;
    },
  })
);

function step({
  qadamVersion,
  mark,
  toolVersion,
}: {
  qadamVersion: string;
  mark?: string;
  toolVersion?: string;
}): QadamAction {
  return {
    name: 'step_1',
    type: FlowActionType.PIECE,
    valid: true,
    displayName: 'Agent',
    lastUpdatedDate: '2026-08-01T00:00:00.000Z',
    settings: {
      actionName: 'run_agent',
      qadamName: '@aiqadam/qadam-ai',
      qadamVersion,
      propertySettings: {},
      input:
        toolVersion === undefined
          ? {}
          : {
              agentTools: [
                {
                  type: AgentToolType.PIECE,
                  toolName: 'tool',
                  qadamMetadata: {
                    qadamName: '@aiqadam/qadam-test-email',
                    qadamVersion: toolVersion,
                    actionName: 'send_email',
                  },
                },
              ],
            },
      exportedUnresolvedPin: mark,
    },
  };
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function render(
  props: Parameters<typeof step>[0],
  readonly = false
): Promise<string> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <UpdateThisStepLabel step={step(props)} readonly={readonly} />
    );
  });
  return container.textContent ?? '';
}

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

afterEach(async () => {
  dialogCalls.length = 0;
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('UpdateThisStepLabel', () => {
  it('says nothing for a step without a mark', async () => {
    expect(await render({ qadamVersion: '1.3.0-main.412' })).toBe('');
  });

  it('marks a step while its version is still the recorded one, and offers the update', async () => {
    const text = await render({
      qadamVersion: '^1.3.0-main.412',
      mark: '1.3.0-main.412',
    });

    expect(text).toContain('Update this step');
    expect(dialogCalls).toHaveLength(1);
  });

  it('drops the mark once the step version moved', async () => {
    expect(
      await render({ qadamVersion: '1.3.0', mark: '1.3.0-main.412' })
    ).toBe('');
  });

  it('marks an agent step whose tool is still on a snapshot, whatever its own version', async () => {
    const text = await render({
      qadamVersion: '0.5.0',
      mark: '0.4.0',
      toolVersion: '1.3.0-main.412',
    });

    expect(text).toContain('Update this step');
    expect(dialogCalls).toHaveLength(0);
  });

  it('drops a tool-origin mark once every tool pin is a release', async () => {
    expect(
      await render({
        qadamVersion: '0.5.0',
        mark: '0.4.0',
        toolVersion: '1.3.0',
      })
    ).toBe('');
  });

  it('hides the action but keeps the mark when readonly', async () => {
    const text = await render(
      { qadamVersion: '1.3.0-main.412', mark: '1.3.0-main.412' },
      true
    );

    expect(text).toContain('Update this step');
    expect(dialogCalls).toHaveLength(0);
  });
});
