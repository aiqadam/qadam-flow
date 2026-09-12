// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { MultiSelectQadamProperty } from '@/components/custom/multi-select-qadam-property';

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const mount = async (): Promise<void> => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <>
        <label htmlFor="qadams">Qadams</label>
        <MultiSelectQadamProperty
          id="qadams"
          placeholder="Select qadams"
          options={[{ value: 'http', label: 'HTTP' }]}
          onChange={vi.fn()}
        />
      </>,
    );
  });
};

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // cmdk (the command palette behind the multi-select's dropdown) measures itself via
  // ResizeObserver, which jsdom does not implement.
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(globalThis, { ResizeObserver: NoopResizeObserver });
  // cmdk also calls scrollIntoView on its highlighted item, which jsdom does not implement.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
});

describe('MultiSelectQadamProperty id threading', () => {
  // #345 (case 3): `MultiSelectQadamProperty` destructured a closed prop list with no `id` and no
  // `...rest`, so a caller's `<Label htmlFor="qadams">` had nothing in the DOM to resolve to. The
  // fix threads `id` through to `MultiSelectTrigger`, and `MultiSelectTrigger` — which typed its
  // props as accepting any button attribute but never actually forwarded them — now puts `id` on
  // the rendered `<button>`. Either half missing leaves this red.
  it('puts the id on the actual trigger button, so the label resolves through it', async () => {
    await mount();

    const label = container?.querySelector('label[for="qadams"]');
    expect(label).not.toBeNull();

    const control = document.getElementById('qadams');
    expect(control).not.toBeNull();
    expect(control?.tagName).toBe('BUTTON');
    expect(control?.getAttribute('role')).toBe('combobox');
  });
});
