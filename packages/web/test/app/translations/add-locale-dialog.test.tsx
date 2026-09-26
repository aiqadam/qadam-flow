// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AddLocaleDialog } from '@/app/translations/add-locale-dialog';

// i18next is not initialised in this harness, so the real `t` answers ''.
vi.mock('i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('i18next')>()),
  t: (key: string) => key,
}));

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

const mount = async ({
  existingLocales,
  onAdded,
  onOpenChange,
}: {
  existingLocales: string[];
  onAdded: (locale: string) => void;
  onOpenChange: (open: boolean) => void;
}): Promise<void> => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <AddLocaleDialog
        open={true}
        onOpenChange={onOpenChange}
        existingLocales={existingLocales}
        onAdded={onAdded}
      />,
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

const typeLocale = async (value: string): Promise<void> => {
  const input = document.body.querySelector('input');
  if (!input) {
    throw new Error('locale input not rendered');
  }
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  if (!valueSetter) {
    throw new Error('HTMLInputElement has no value setter');
  }
  await act(async () => {
    valueSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
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
});

describe('AddLocaleDialog', () => {
  it('adds the canonical form of a valid tag and closes', async () => {
    const onAdded = vi.fn();
    const onOpenChange = vi.fn();
    await mount({ existingLocales: ['en'], onAdded, onOpenChange });

    await typeLocale(' en-us ');
    await click(findButtonByText('Add')!);

    expect(onAdded).toHaveBeenCalledWith('en-US');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('rejects a malformed tag', async () => {
    const onAdded = vi.fn();
    await mount({ existingLocales: [], onAdded, onOpenChange: vi.fn() });

    await typeLocale('not a locale');
    await click(findButtonByText('Add')!);

    expect(onAdded).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('translationLocaleInvalid');
  });

  it('rejects a locale that already has a column, compared in canonical form', async () => {
    const onAdded = vi.fn();
    await mount({ existingLocales: ['uz'], onAdded, onOpenChange: vi.fn() });

    await typeLocale('UZ');
    await click(findButtonByText('Add')!);

    expect(onAdded).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      'translationLocaleAlreadyShown',
    );
  });
});
