// @vitest-environment jsdom
import { flowQadamUtil, FlowActionType, QadamAction } from '@aiqadam/shared';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { PreReleaseBuildLabel } from '@/app/builder/step-settings/pre-release-build-label';

// i18next is not initialised in this harness, so `t` answers the key itself.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function pieceStep({ qadamVersion }: { qadamVersion: string }): QadamAction {
  return {
    name: 'step_1',
    type: FlowActionType.PIECE,
    valid: true,
    displayName: 'Send Email',
    lastUpdatedDate: '2026-08-01T00:00:00.000Z',
    settings: {
      actionName: 'send_email',
      qadamName: '@aiqadam/qadam-test-email',
      qadamVersion,
      propertySettings: {},
      input: {},
    },
  };
}

const LABEL = 'This step is pinned to a build from main, not a released version. It runs that exact build until its version is updated.';

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function render(qadamVersion: string): Promise<string> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<PreReleaseBuildLabel step={pieceStep({ qadamVersion })} />);
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

// ADR-0004: a snapshot pin (`x.y.z-main.<n>`) runs a build from `main`. The label is informational,
// so it is shown for a snapshot pin — including one carrying a `^`/`~` range — and never for a
// release pin.
describe('PreReleaseBuildLabel', () => {
  it('labels a snapshot-pinned step', async () => {
    const text = await render('1.3.0-main.412');

    expect(text).toContain('Pre-release build');
    expect(text).toContain(LABEL);
  });

  it('labels a snapshot pin that carries a range prefix', async () => {
    const text = await render('~1.3.0-main.412');

    expect(text).toContain('Pre-release build');
  });

  it('says nothing for a release-pinned step', async () => {
    const text = await render('1.3.0');

    expect(text).not.toContain('Pre-release build');
    expect(text).not.toContain(LABEL);
  });

  it('reads the exact version off the stored pin before deciding', () => {
    expect(flowQadamUtil.getExactVersion('~1.3.0-main.412')).toBe('1.3.0-main.412');
  });
});
