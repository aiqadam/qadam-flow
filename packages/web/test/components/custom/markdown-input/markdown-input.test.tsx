// @vitest-environment jsdom
import { Editor, JSONContent } from '@tiptap/react';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { MarkdownInput } from '@/components/custom/markdown-input';

let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
});

// Canvas notes are stored as the markdown this editor serialises, so a tiptap bump
// that changes parsing or serialisation changes what existing notes display (#619).
describe('MarkdownInput markdown round trip', () => {
  it.each([
    'Hello world',
    'Line one\n\nLine two',
    'line a\nline b',
    'Para\n\n<br>\n\nAfter empty',
    'Para\n\n<br>\n\n<br>\n\nAfter two empty',
    '**bold** *italic* ~~strike~~ ++underline++',
    '***bold italic***',
    '- a\n- b\n\n1. one\n2. two',
    '- item\n  - nested\n- **bold item**',
    '![img](https://example.com/y.png)',
    'Price: $5 call (216) 555-1234',
  ])('serialises stored note %j back unchanged', async (markdown) => {
    const editor = await mountEditor({ initialValue: markdown });
    expect(editor.getMarkdown()).toBe(markdown);
  });

  it('keeps the <br> empty-line paragraphs as empty paragraphs', async () => {
    const editor = await mountEditor({
      initialValue: 'Para\n\n<br>\n\nAfter empty',
    });
    expect(editor.getJSON().content?.map((node) => node.type)).toEqual([
      'paragraph',
      'paragraph',
      'paragraph',
    ]);
    expect(editor.getJSON().content?.[1].content).toBeUndefined();
  });

  it.each([
    'snake_case and a*b',
    '2 < 3 & 4 > 1 "quoted"',
    'a literal \\ backslash, `ticks` and [brackets]',
    '<enter value here>',
  ])('reloads typed text %j literally', async (text) => {
    const editor = await mountEditor({ initialValue: '' });
    await act(async () => {
      editor.commands.setContent(paragraphDoc(text));
    });
    const stored = editor.getMarkdown();

    const reloaded = await mountEditor({ initialValue: stored });
    expect(reloaded.getText()).toBe(text);
    expect(reloaded.getMarkdown()).toBe(stored);
  });

  // Notes saved before the tiptap bump were serialised without escaping, so the
  // stored markdown holds these characters raw.
  it.each([
    'snake_case 2 < 3 & ok',
    'snake_case and a*b',
    'a * b = c and [brackets]',
    'a literal \\ backslash',
    '2 < 3 & 4 > 1 "quoted"',
  ])('displays note %j stored before the bump unchanged', async (stored) => {
    const editor = await mountEditor({ initialValue: stored });
    expect(editor.getText()).toBe(stored);
  });

  it('shows the placeholder for an empty note and stores it as <br>', async () => {
    const editor = await mountEditor({
      initialValue: '',
      placeholder: 'P',
      onlyEditableOnDoubleClick: true,
    });
    expect(container?.textContent).toContain('P');
    expect(editor.getMarkdown()).toBe('<br>');
  });

  it('hides the placeholder for a note with content', async () => {
    await mountEditor({
      initialValue: 'Hello',
      placeholder: 'P',
      onlyEditableOnDoubleClick: true,
    });
    expect(container?.textContent).toBe('Hello');
  });
});

async function mountEditor({
  initialValue,
  placeholder,
  onlyEditableOnDoubleClick,
}: {
  initialValue: string;
  placeholder?: string;
  onlyEditableOnDoubleClick?: boolean;
}): Promise<Editor> {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  const ref = React.createRef<Editor | null>();
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MarkdownInput
        ref={ref}
        initialValue={initialValue}
        placeholder={placeholder}
        onlyEditableOnDoubleClick={onlyEditableOnDoubleClick}
        onChange={() => undefined}
      />,
    );
  });
  if (!ref.current) {
    throw new Error('MarkdownInput did not expose its editor');
  }
  return ref.current;
}

function paragraphDoc(text: string): JSONContent {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}
