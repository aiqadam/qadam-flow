import { isNil, SeekPage } from '@aiqadam/shared';

// Mirrors the server's MAX_PAGE_SIZE: a larger `limit` is clamped to it (#561).
const MAX_PAGE_SIZE = 1000;

export const seekPageUtils = {
  listAll,
};

// For callers that genuinely need every row (a picker, a uniqueness check): the server
// no longer returns an unbounded page, so walk the cursor one bounded page at a time.
async function listAll<T>(
  fetchPage: (page: {
    cursor: string | undefined;
    limit: number;
  }) => Promise<SeekPage<T>>,
): Promise<SeekPage<T>> {
  const data: T[] = [];
  let cursor: string | undefined = undefined;
  do {
    const page: SeekPage<T> = await fetchPage({ cursor, limit: MAX_PAGE_SIZE });
    data.push(...page.data);
    cursor = isNil(page.next) ? undefined : page.next;
  } while (!isNil(cursor));
  return { data, next: null, previous: null };
}
