import { SeekPage } from '@aiqadam/shared';
import { describe, expect, it, vi } from 'vitest';

import { seekPageUtils } from '@/lib/seek-page-utils';

describe('seekPageUtils.listAll', () => {
  it('walks the cursor until the server stops returning one', async () => {
    const pages: Record<string, SeekPage<number>> = {
      first: { data: [1, 2], next: 'b', previous: null },
      b: { data: [3, 4], next: 'c', previous: 'a' },
      c: { data: [5], next: null, previous: 'b' },
    };
    const fetchPage = vi.fn(
      async ({ cursor }: { cursor: string | undefined; limit: number }) =>
        pages[cursor ?? 'first'],
    );

    const result = await seekPageUtils.listAll(fetchPage);

    expect(result).toEqual({
      data: [1, 2, 3, 4, 5],
      next: null,
      previous: null,
    });
    expect(fetchPage.mock.calls.map(([page]) => page.cursor)).toEqual([
      undefined,
      'b',
      'c',
    ]);
  });

  it('asks for pages no larger than the server will return', async () => {
    const fetchPage = vi.fn(async () => ({
      data: [],
      next: null,
      previous: null,
    }));

    await seekPageUtils.listAll(fetchPage);

    expect(fetchPage).toHaveBeenCalledWith({ cursor: undefined, limit: 1000 });
  });
});
