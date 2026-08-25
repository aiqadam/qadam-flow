// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { MultiQuestionForm } from '@/app/routes/chat-with-ai/components/multi-question-form';
import { MultiQuestion } from '@/app/routes/chat-with-ai/lib/message-parsers';

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

const mount = async (questions: MultiQuestion[]): Promise<void> => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MultiQuestionForm questions={questions} onSubmit={vi.fn()} />,
    );
  });
  await flush();
};

// Finds the visible question title the way a screen reader / a real user would: by its text,
// not by reaching for a specific id or class. If the label association regresses back to
// pointing at nothing (or at the wrong control), `htmlFor`/`id` stop matching and this resolves
// to null instead of a real element — that is the failure this test is written to catch.
const findLabelledControl = (questionText: string): Element | null => {
  const label = [...(container?.querySelectorAll('label') ?? [])].find((el) =>
    el.textContent?.includes(questionText),
  );
  const forId = label?.getAttribute('for');
  return forId ? document.getElementById(forId) : null;
};

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

describe('MultiQuestionForm label association', () => {
  it('associates a text question label with its answer input, and clicking it focuses that input', async () => {
    await mount([{ question: 'What is your name?', type: 'text' }]);

    const control = findLabelledControl('What is your name?');
    expect(control).not.toBeNull();
    expect(control?.tagName).toBe('INPUT');

    await act(async () => {
      control?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // The label's own onClick also calls .focus() explicitly (divs are not natively labelable),
    // so this must hold regardless of jsdom's native label-click-forwarding support.
    const label = [...(container?.querySelectorAll('label') ?? [])].find(
      (el) => el.textContent?.includes('What is your name?'),
    );
    await act(async () => {
      label?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.activeElement).toBe(control);
  });

  // This is the case a literal `htmlFor`/`id` grep cannot see failing: before the fix, the title's
  // `htmlFor` pointed at the same id as the unrelated "type your own answer" input, so a naive
  // check ("does *some* element have this id?") would report the tree as clean. Resolving from the
  // title to the actual choice control is what catches it.
  //
  // The title itself is a plain <span>, not a <label>: a div[role="menuitemradio"] is not a
  // labelable element, so `htmlFor` there is invalid HTML that forwards no native click behavior —
  // and an `aria-labelledby` override would have replaced the option's own accessible name ("Apple")
  // with the question text, breaking screen-reader announcement of which option is which.
  it('resolves the choice question title to the first choice option, not the free-text fallback', async () => {
    await mount([
      {
        question: 'Which fruit do you like?',
        type: 'choice',
        options: ['Apple', 'Banana'],
      },
    ]);

    const title = [...(container?.querySelectorAll('span') ?? [])].find((el) =>
      el.textContent?.includes('Which fruit do you like?'),
    );
    expect(title).toBeDefined();
    expect(title?.tagName).not.toBe('LABEL');

    await act(async () => {
      title?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const focused = document.activeElement;
    expect(focused?.getAttribute('role')).toBe('menuitemradio');
    expect(focused?.textContent).toContain('Apple');

    // Keyboard reachability is unaffected by the span: neither a <label> nor a plain <span> is
    // ever in the tab order (no tabIndex on either), so a keyboard user never lands on the title
    // either way. What must stay reachable is the option itself, via the tabIndex this component
    // already manages — confirmed here directly, not inferred from the title's tag name.
    expect(focused?.getAttribute('tabindex')).toBe('0');
  });
});
