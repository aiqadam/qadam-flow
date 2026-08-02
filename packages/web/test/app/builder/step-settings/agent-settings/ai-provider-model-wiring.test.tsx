// @vitest-environment jsdom
import { FlowActionType, QadamAction } from '@aiqadam/shared';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { FormProvider, useForm, UseFormReturn } from 'react-hook-form';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AgentSettings } from '@/app/builder/step-settings/agent-settings';

type HarnessValues = {
  settings: { input: { aiProviderModel: Record<string, unknown> } };
};
type HarnessForm = UseFormReturn<HarnessValues>;

vi.mock('@/app/builder/step-settings/step-settings-context', () => ({
  useStepSettingsContext: () => ({
    qadamModel: {
      actions: {
        run_agent: { props: { aiProviderModel: { type: 'OBJECT' } } },
      },
    },
    updateFormSchema: vi.fn(),
    updatePropertySettingsSchema: vi.fn(),
  }),
}));

vi.mock('@/features/agents/ai-model/hooks', () => ({
  aiModelHooks: {
    useListProviders: () => ({
      data: [{ id: 'row-1', provider: 'custom', name: 'DeepSeek' }],
      isLoading: false,
    }),
    useGetModelsForProvider: () => ({
      data: [
        { id: 'deepseek-chat', name: 'deepseek-chat' },
        { id: 'deepseek-reasoner', name: 'deepseek-reasoner' },
      ],
      isLoading: false,
    }),
  },
}));

const STEP: QadamAction = {
  name: 'step_1',
  type: FlowActionType.PIECE,
  valid: true,
  displayName: 'Run Agent',
  lastUpdatedDate: '2026-08-01T00:00:00.000Z',
  settings: {
    actionName: 'run_agent',
    qadamName: '@aiqadam/qadam-ai',
    qadamVersion: '0.4.3',
    propertySettings: {},
    input: {},
  },
};

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const mountAgentSettings = async (
  storedValue: Record<string, unknown>,
): Promise<HarnessForm> => {
  let form: HarnessForm | undefined;
  const Harness = () => {
    const harnessForm = useForm<HarnessValues>({
      defaultValues: { settings: { input: { aiProviderModel: storedValue } } },
    });
    form = harnessForm;
    return (
      <FormProvider {...harnessForm}>
        <AgentSettings step={STEP} flowId="flow_1" readonly={false} />
      </FormProvider>
    );
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Harness />);
  });
  if (!form) {
    throw new Error('the harness never rendered');
  }
  return form;
};

beforeAll(() => {
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  Element.prototype.scrollIntoView = () => {};
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('the builder model picker, wired to the aiProviderModel field', () => {
  it('keeps a pinned provider row through the unprompted fallback emission', async () => {
    const form = await mountAgentSettings({
      provider: 'custom',
      model: 'a-model-the-catalogue-no-longer-lists',
      providerId: 'row-2',
    });

    expect(form.getValues('settings.input.aiProviderModel')).toEqual({
      provider: 'custom',
      model: 'deepseek-chat',
      providerId: 'row-2',
    });
  });

  it('keeps a pinned provider row when the user picks another model', async () => {
    const form = await mountAgentSettings({
      provider: 'custom',
      model: 'deepseek-chat',
      providerId: 'row-2',
    });

    const modelTrigger = document.querySelectorAll(
      'button[role="combobox"]',
    )[1];
    await act(async () => {
      modelTrigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const option = [...document.querySelectorAll('[cmdk-item]')].find(
      (item) => item.textContent === 'deepseek-reasoner',
    );
    if (!option) {
      throw new Error('the model dropdown never opened');
    }
    await act(async () => {
      option.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(form.getValues('settings.input.aiProviderModel')).toEqual({
      provider: 'custom',
      model: 'deepseek-reasoner',
      providerId: 'row-2',
    });
  });
});
