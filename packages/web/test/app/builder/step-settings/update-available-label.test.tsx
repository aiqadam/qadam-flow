// @vitest-environment jsdom
import { FlowActionType, QadamAction } from '@aiqadam/shared';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { UpdateAvailableLabel } from '@/app/builder/step-settings/update-available-label';
import { changeVersionUtils } from '@/app/builder/step-settings/update-qadam-version-dialog/update-qadam-version-utils';

// i18next is not initialised in this harness, so `t` answers the key itself, with the simple
// `{version}` placeholder substituted the way ICU would.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      key.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
        options && name in options ? String(options[name]) : placeholder,
      ),
  }),
}));

const registry = vi.hoisted(() => ({ versions: [] as { version: string }[] }));
const dialogCalls = vi.hoisted(() => [] as { currentVersion: string; suggestedVersion?: string }[]);

// The registry hook and the update dialog are the two things the label reads from the rest of the
// app; mocking them keeps this test to the label's own show/hide and version-picking logic.
vi.mock('@/features/qadams', () => ({
  qadamsHooks: {
    useQadamVersions: () => ({
      qadamVersions: registry.versions,
      isLoading: false,
    }),
  },
  formUtils: {},
  qadamSelectorUtils: {},
  qadamsApi: {},
}));

vi.mock(
  '@/app/builder/step-settings/update-qadam-version-dialog/update-qadam-version-dialog',
  () => ({
    UpdatePieceVersionDialog: (props: {
      currentVersion: string;
      suggestedVersion?: string;
    }) => {
      dialogCalls.push(props);
      return null;
    },
  }),
);

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

const OFFER = 'A released version of this Qadam is available: v';

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function render({
  qadamVersion,
  versions,
  readonly = false,
}: {
  qadamVersion: string;
  versions: string[];
  readonly?: boolean;
}): Promise<string> {
  registry.versions = versions.map((version) => ({ version }));
  dialogCalls.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <UpdateAvailableLabel
        step={pieceStep({ qadamVersion })}
        readonly={readonly}
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

// ADR-0004 "UX": a snapshot pin graduates to the newest release inside its caret range — the same
// major, or on `0.x` the same minor — and only when a `-main`-instance-pinned step has one to move to.
describe('UpdateAvailableLabel', () => {
  it('offers the newest release inside the caret range', async () => {
    const text = await render({
      qadamVersion: '1.3.0-main.412',
      versions: ['1.3.5', '1.3.2', '1.4.0'],
    });

    expect(text).toContain('Update available');
    expect(text).toContain(`${OFFER}1.4.0.`);
    expect(dialogCalls).toHaveLength(1);
    expect(dialogCalls[0]).toEqual({
      currentVersion: '1.3.0-main.412',
      suggestedVersion: '1.4.0',
      step: expect.anything(),
      variant: 'labelled',
    });
  });

  it('never offers a newer major', async () => {
    const text = await render({
      qadamVersion: '1.3.0-main.412',
      versions: ['2.0.0', '1.3.5'],
    });

    expect(text).toContain(`${OFFER}1.3.5.`);
  });

  it('graduates to the base release itself', async () => {
    const text = await render({
      qadamVersion: '1.3.0-main.412',
      versions: ['1.3.0'],
    });

    expect(text).toContain(`${OFFER}1.3.0.`);
  });

  it('says nothing when only a release below the base exists', async () => {
    const text = await render({
      qadamVersion: '1.3.0-main.412',
      versions: ['1.2.4'],
    });

    expect(text).not.toContain('Update available');
    expect(dialogCalls).toHaveLength(0);
  });

  it('says nothing when no release exists at all', async () => {
    const text = await render({
      qadamVersion: '1.3.0-main.412',
      versions: [],
    });

    expect(text).not.toContain('Update available');
  });

  it('stays on the same minor for a 0.x pin', async () => {
    const offered = await render({
      qadamVersion: '0.4.17-main.9',
      versions: ['0.5.0', '0.4.18'],
    });
    expect(offered).toContain(`${OFFER}0.4.18.`);

    const refused = await render({
      qadamVersion: '0.4.17-main.9',
      versions: ['0.5.0'],
    });
    expect(refused).not.toContain('Update available');
  });

  it('never offers another prerelease', async () => {
    const offered = await render({
      qadamVersion: '1.3.0-main.412',
      versions: ['1.3.0-main.900', '1.3.2'],
    });
    expect(offered).toContain(`${OFFER}1.3.2.`);

    const refused = await render({
      qadamVersion: '1.3.0-main.412',
      versions: ['1.3.0-main.900'],
    });
    expect(refused).not.toContain('Update available');
  });

  it('reads a range-prefixed snapshot pin off its exact version', async () => {
    const text = await render({
      qadamVersion: '~1.3.0-main.412',
      versions: ['1.3.2'],
    });

    expect(text).toContain(`${OFFER}1.3.2.`);
  });

  it('keeps a tilde pin on its minor', async () => {
    const patch = await render({
      qadamVersion: '~1.3.0-main.412',
      versions: ['1.4.0', '1.3.2'],
    });
    expect(patch).toContain(`${OFFER}1.3.2.`);

    const minor = await render({
      qadamVersion: '~1.3.0-main.412',
      versions: ['1.4.0'],
    });
    expect(minor).not.toContain('Update available');
  });

  it('lets a caret pin cross its minor', async () => {
    const text = await render({
      qadamVersion: '^1.3.0-main.412',
      versions: ['1.4.0'],
    });

    expect(text).toContain(`${OFFER}1.4.0.`);
  });

  it('says nothing for a release-pinned step', async () => {
    const text = await render({
      qadamVersion: '1.3.2',
      versions: ['1.4.0'],
    });

    expect(text).not.toContain('Update available');
    expect(dialogCalls).toHaveLength(0);
  });

  it('shows the offer but hides the action when read-only', async () => {
    const text = await render({
      qadamVersion: '1.3.0-main.412',
      versions: ['1.3.2'],
      readonly: true,
    });

    expect(text).toContain(`${OFFER}1.3.2.`);
    expect(dialogCalls).toHaveLength(0);
  });
});

describe('changeVersionUtils.getLatestReleaseInsideCaret', () => {
  const latest = (pin: string, versions: string[]) =>
    changeVersionUtils.getLatestReleaseInsideCaret({
      pin,
      versions: versions.map((version) => ({ version })),
    });

  it('sorts candidates and returns the newest', () => {
    expect(
      latest('3.4.0-main.1', ['3.4.2', '3.5.9', '3.4.10']),
    ).toBe('3.5.9');
  });

  it('excludes the next major line', () => {
    expect(latest('1.3.0-main.412', ['2.0.0', '1.9.9'])).toBe('1.9.9');
  });

  it('excludes releases below the base', () => {
    expect(latest('1.3.0-main.412', ['1.2.9'])).toBeUndefined();
  });

  it('keeps a 0.x pin on its own minor', () => {
    expect(latest('0.4.17-main.9', ['0.4.18', '0.5.0'])).toBe('0.4.18');
    expect(latest('0.4.17-main.9', ['0.5.0'])).toBeUndefined();
  });

  it('uses the pin prefix: a tilde pin stays on its minor', () => {
    expect(latest('~1.3.0-main.412', ['1.4.0', '1.3.9'])).toBe('1.3.9');
    expect(latest('~1.3.0-main.412', ['1.4.0'])).toBeUndefined();
  });

  it('uses the pin prefix: a caret pin crosses its minor', () => {
    expect(latest('^1.3.0-main.412', ['2.0.0', '1.4.0'])).toBe('1.4.0');
  });

  it('defaults an unprefixed pin to the caret range', () => {
    expect(latest('1.3.0-main.412', ['1.4.0'])).toBe('1.4.0');
    expect(latest('1.3.0-main.412', ['2.0.0'])).toBeUndefined();
  });

  it('returns undefined for a version the parser rejects', () => {
    expect(latest('not-a-version', ['1.3.2'])).toBeUndefined();
  });
});
