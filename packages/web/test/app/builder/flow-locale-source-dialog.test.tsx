// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { FlowLocaleSourceDialog } from '@/app/builder/flow-locale-source-dialog';

// i18next is not initialised in this harness, so the real `t` answers ''.
vi.mock('i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('i18next')>()),
  t: (key: string) => key,
}));

// `TextInputWithMentions` pulls in the full TipTap mention editor, which itself reads builder
// state (steps, sample data) this test has no need to fake — stubbed to a plain input so the
// dialog's own save/error wiring can be exercised in isolation.
vi.mock('@/app/builder/qadam-properties/text-input-with-mentions', () => ({
  TextInputWithMentions: ({
    initialValue,
    onChange,
  }: {
    initialValue: string;
    onChange: (value: string) => void;
  }) => (
    <input
      aria-label="Run locale"
      value={initialValue}
      onChange={(e) => onChange(e.target.value)}
      readOnly
    />
  ),
}));

let lastApplyOperationArgs: unknown[] = [];
let applyOperationCallCount = 0;
const fakeBuilderState = {
  flowVersion: { localeSource: 'ru' },
  applyOperation: (...args: unknown[]) => {
    applyOperationCallCount += 1;
    lastApplyOperationArgs = args;
  },
};

vi.mock('@/app/builder/builder-hooks', () => ({
  useBuilderStateContext: (
    selector: (state: typeof fakeBuilderState) => unknown,
  ) => selector(fakeBuilderState),
}));

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

const mount = async (): Promise<void> => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <FlowLocaleSourceDialog open={true} onOpenChange={() => {}} />,
    );
  });
  await flush();
};

const findButtonByText = (text: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  );

const click = async (element: Element): Promise<void> => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
};

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  document.body.replaceChildren();
  root = undefined;
  container = undefined;
  lastApplyOperationArgs = [];
  applyOperationCallCount = 0;
});

describe('FlowLocaleSourceDialog — save failure shows a persistent error and disables retry', () => {
  it('keeps Save disabled and shows a refresh-required message after applyOperation reports an error, instead of letting the user retry into a halted queue', async () => {
    await mount();

    const saveButton = findButtonByText('Save')!;
    expect(saveButton.disabled).toBe(false);

    await click(saveButton);

    expect(lastApplyOperationArgs).toHaveLength(3);
    const onError = lastApplyOperationArgs[2] as (error: unknown) => void;
    await act(async () => {
      onError(new Error('network down'));
    });
    await flush();

    expect(document.body?.textContent).toContain(
      'This change was not saved. Refresh the page to try again.',
    );
    const saveButtonAfterFailure = findButtonByText('Save')!;
    expect(saveButtonAfterFailure.disabled).toBe(true);

    // A further click must not re-enter applyOperation — the queue is permanently halted after
    // the first failure (promise-queue.ts), so a retry would just spin forever.
    expect(applyOperationCallCount).toBe(1);
    await click(saveButtonAfterFailure);
    expect(applyOperationCallCount).toBe(1);
  });
});
