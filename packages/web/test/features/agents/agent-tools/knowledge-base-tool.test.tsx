// @vitest-environment jsdom
import {
  AgentKnowledgeBaseTool,
  AgentToolType,
  AIProviderName,
  KnowledgeBaseSourceType,
} from '@aiqadam/shared';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { KnowledgeBaseSection } from '@/features/agents/agent-tools/components/knowledge-base-tool';
import { useKnowledgeBaseToolDialogStore } from '@/features/agents/agent-tools/stores/knowledge-base-tools';

// i18next is not initialised in this harness, so the real `t` answers ''.
vi.mock('i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('i18next')>()),
  t: (key: string) => key,
}));

vi.mock('@/features/agents/agent-tools/knowledge-base-dialog', () => ({
  AgentKnowledgeBaseDialog: () => null,
}));

const FILE_SOURCES_REQUIRE_EMBEDDINGS =
  'File sources require a provider that supports embeddings, such as OpenAI or Google.';
const FILE_SOURCES_WARNING =
  'The selected provider does not support embeddings, so file sources will not work. Switch to a provider like OpenAI or Google.';

const knowledgeBaseTool = ({
  sourceType,
}: {
  sourceType: KnowledgeBaseSourceType;
}): AgentKnowledgeBaseTool => ({
  type: AgentToolType.KNOWLEDGE_BASE,
  toolName: `kb_${sourceType}`,
  sourceType,
  sourceId: 'source-id',
  sourceName: `${sourceType} source`,
});

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const mountSection = async ({
  provider,
  tools,
}: {
  provider: AIProviderName;
  tools: AgentKnowledgeBaseTool[];
}) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <KnowledgeBaseSection
        tools={tools}
        allTools={tools}
        removeTool={vi.fn()}
        onToolsUpdate={vi.fn()}
        selectedProvider={provider}
      />,
    );
  });
};

const openAddMenu = async () => {
  const trigger = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Add',
  );
  if (!trigger) {
    throw new Error('the section has no Add button');
  }
  await act(async () => {
    trigger.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
    );
  });
};

const menuItem = (label: string) => {
  const item = [...document.querySelectorAll('[role="menuitem"]')].find(
    (candidate) => candidate.textContent === label,
  );
  if (!item) {
    throw new Error(`no menu item "${label}"`);
  }
  return item;
};

const bodyText = () => document.body.textContent ?? '';

const isDisabled = (element: Element) =>
  element.getAttribute('aria-disabled') === 'true';

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
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  document.body.replaceChildren();
  root = undefined;
  container = undefined;
  useKnowledgeBaseToolDialogStore.setState({ showAddKbDialog: false });
});

describe('KnowledgeBaseSection on a provider without an embedding model', () => {
  it('keeps Connect Table available and disables only Upload File', async () => {
    await mountSection({ provider: AIProviderName.CUSTOM, tools: [] });
    await openAddMenu();

    expect(isDisabled(menuItem('Upload File'))).toBe(true);
    expect(isDisabled(menuItem('Connect Table'))).toBe(false);
    expect(bodyText()).toContain(FILE_SOURCES_REQUIRE_EMBEDDINGS);
  });

  it('does not warn about a table source, which never uses embeddings', async () => {
    await mountSection({
      provider: AIProviderName.CUSTOM,
      tools: [knowledgeBaseTool({ sourceType: KnowledgeBaseSourceType.TABLE })],
    });

    expect(bodyText()).not.toContain(FILE_SOURCES_WARNING);
    await openAddMenu();
    expect(isDisabled(menuItem('Connect Table'))).toBe(false);
  });

  it('warns that an existing file source will not work', async () => {
    await mountSection({
      provider: AIProviderName.CUSTOM,
      tools: [knowledgeBaseTool({ sourceType: KnowledgeBaseSourceType.FILE })],
    });

    expect(bodyText()).toContain(FILE_SOURCES_WARNING);
  });
});

describe('KnowledgeBaseSection on a provider with an embedding model', () => {
  it('enables both source types and shows no warning', async () => {
    await mountSection({
      provider: AIProviderName.OPENAI,
      tools: [knowledgeBaseTool({ sourceType: KnowledgeBaseSourceType.FILE })],
    });
    await openAddMenu();

    expect(isDisabled(menuItem('Upload File'))).toBe(false);
    expect(isDisabled(menuItem('Connect Table'))).toBe(false);
    expect(bodyText()).not.toContain(FILE_SOURCES_WARNING);
    expect(bodyText()).not.toContain(FILE_SOURCES_REQUIRE_EMBEDDINGS);
  });
});
