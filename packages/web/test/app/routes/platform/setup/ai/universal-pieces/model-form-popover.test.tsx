// @vitest-environment jsdom
import { AIProviderModelType, ProviderModelConfig } from '@aiqadam/shared';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ModelFormPopover } from '@/app/routes/platform/setup/ai/universal-pieces/model-form-popover';

// i18next is not initialised in this harness; the key is what gets rendered.
vi.mock('i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('i18next')>()),
  t: (key: string) => key,
}));

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const openPopover = async ({
  initialData,
  onSubmit,
}: {
  initialData?: ProviderModelConfig;
  onSubmit: (model: ProviderModelConfig) => void;
}): Promise<void> => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ModelFormPopover initialData={initialData} onSubmit={onSubmit}>
        <button type="button">open</button>
      </ModelFormPopover>,
    );
  });
  const trigger = container.querySelector('button');
  if (!trigger) throw new Error('trigger not rendered');
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

// A React-controlled input ignores a plain `input.value = …`; see ldap-dialog.test.tsx.
const typeInto = async (id: string, value: string): Promise<void> => {
  const input = document.getElementById(id);
  if (!(input instanceof HTMLInputElement)) throw new Error(`no input#${id}`);
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  if (!valueSetter) throw new Error('HTMLInputElement has no value setter');
  await act(async () => {
    valueSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const submit = async (): Promise<void> => {
  // The popover portals to the body, outside the container.
  const form = document.body.querySelector('form');
  if (!form) throw new Error('form not rendered');
  await act(async () => {
    form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
  });
};

const qwen: ProviderModelConfig = {
  modelId: 'qwen3-32b',
  modelName: 'Qwen3 32B',
  modelType: AIProviderModelType.TEXT,
};

describe('ModelFormPopover context window', () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = undefined;
    root = undefined;
  });

  it('saves the size the operator typed', async () => {
    const onSubmit = vi.fn();
    await openPopover({ initialData: qwen, onSubmit });

    await typeInto('contextWindowTokens', '32768');
    await submit();

    expect(onSubmit).toHaveBeenCalledWith({
      ...qwen,
      contextWindowTokens: 32_768,
    });
  });

  it('leaves the size out when the field is cleared', async () => {
    const onSubmit = vi.fn();
    await openPopover({
      initialData: { ...qwen, contextWindowTokens: 32_768 },
      onSubmit,
    });

    await typeInto('contextWindowTokens', '');
    await submit();

    expect(onSubmit).toHaveBeenCalledWith(qwen);
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty(
      'contextWindowTokens',
    );
  });

  it('refuses a size out of range and says why, instead of saving it', async () => {
    const onSubmit = vi.fn();
    await openPopover({ initialData: qwen, onSubmit });

    await typeInto('contextWindowTokens', '100');
    await submit();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      'contextWindowTokensOutOfRange',
    );
  });

  it('offers no context window on an image model', async () => {
    await openPopover({
      initialData: { ...qwen, modelType: AIProviderModelType.IMAGE },
      onSubmit: vi.fn(),
    });

    expect(document.getElementById('contextWindowTokens')).toBeNull();
  });
});
