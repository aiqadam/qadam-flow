// @vitest-environment jsdom
import { Translation } from '@aiqadam/shared';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { TranslationKeyDialog } from '@/app/translations/translation-key-dialog';

// i18next is not initialised in this harness, so the real `t` answers ''.
vi.mock('i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('i18next')>()),
  t: (key: string) => key,
}));

vi.mock('@/lib/authentication-session', () => ({
  authenticationSession: { getProjectId: () => 'project1' },
}));

const baseTranslation: Translation = {
  id: 'existing-key-extra',
  created: '2026-01-01T00:00:00.000Z',
  updated: '2026-01-01T00:00:00.000Z',
  projectId: 'project1',
  platformId: 'platform1',
  key: 'existing.key.extra',
  values: {},
  description: null,
};

let listCallCursors: (string | undefined)[] = [];
vi.mock('@/features/translations/api/translations', () => ({
  translationsApi: {
    list: vi.fn(
      (request: { projectId: string; key?: string; cursor?: string }) => {
        listCallCursors.push(request.cursor);
        if (!request.cursor) {
          return Promise.resolve({
            data: [baseTranslation],
            next: 'page-2-cursor',
            previous: null,
          });
        }
        return Promise.resolve({
          data: [
            { ...baseTranslation, id: 'existing-key', key: 'existing.key' },
          ],
          next: null,
          previous: null,
        });
      },
    ),
  },
}));

let saveMutateCalled = false;
vi.mock('@/features/translations/hooks/translations-hooks', () => ({
  translationsMutations: {
    useUpsertBatch: () => ({
      mutate: () => {
        saveMutateCalled = true;
      },
      isPending: false,
    }),
  },
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
      <TranslationKeyDialog
        open={true}
        onOpenChange={() => {}}
        defaultLocale={null}
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

const typeInto = async (
  input: HTMLInputElement,
  value: string,
): Promise<void> => {
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
  listCallCursors = [];
  saveMutateCalled = false;
});

describe('TranslationKeyDialog — duplicate-key pre-check pagination', () => {
  it('finds an exact match on page 2 and refuses the create instead of upserting into the existing row', async () => {
    await mount();

    const keyInput = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="welcome.title"]',
    );
    if (!keyInput) {
      throw new Error('key input not found');
    }
    await typeInto(keyInput, 'existing.key');

    await click(findButtonByText('Create')!);
    // The lookup awaits two sequential `list()` calls before `handleSubmit` settles.
    await flush();
    await flush();

    expect(listCallCursors).toEqual([undefined, 'page-2-cursor']);
    expect(saveMutateCalled).toBe(false);
    expect(document.body?.textContent).toContain('translationKeyAlreadyExists');
  });
});
