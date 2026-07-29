import i18next from 'i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { formatUtils } from '@/lib/format-utils';

vi.mock('i18next', () => ({
  default: { language: 'en' },
  t: (key: string) => key,
}));

const setLanguage = (language: string) => {
  // The sibling suite in src/lib/test/utils.test.ts mocks i18next with a frozen 'en', so no
  // locale-dependent branch in formatUtils was reachable from tests at all before this file.
  (i18next as unknown as { language: string }).language = language;
};

// ICU emits U+202F/U+00A0 inside formatted times and as a group separator; comparing raw strings
// against a terminal paste is how those assertions become flaky.
const normalise = (value: string) => value.replace(/\s+/g, ' ');

beforeEach(() => {
  setLanguage('en');
});

describe('24-hour locales must not be shown AM/PM', () => {
  const afternoon = new Date(2026, 5, 20, 15, 30);

  it.each(['de', 'ru', 'kk', 'uz', 'fr', 'ja'])(
    'formats afternoon time as 24-hour for %s',
    (language) => {
      setLanguage(language);
      const formatted = normalise(
        formatUtils.formatDateWithTime(afternoon, false),
      );
      expect(formatted).toMatch(/15[:.]30/);
      expect(formatted).not.toMatch(/\bPM\b/i);
    },
  );

  it('still shows 12-hour time for en', () => {
    const formatted = normalise(formatUtils.formatDateWithTime(afternoon, false));
    expect(formatted).toMatch(/3[:.]30/);
    expect(formatted).toMatch(/PM/i);
  });
});

describe('numbers follow the locale decimal mark', () => {
  it.each([
    ['ru', ','],
    ['de', ','],
    ['uz', ','],
    ['en', '.'],
  ])('formatStorageSize uses %s decimal mark', (language, mark) => {
    setLanguage(language);
    const formatted = formatUtils.formatStorageSize(1536);
    expect(formatted).toContain(`1${mark}5`);
    expect(formatted).toContain('KB');
  });
});

describe('relative dates older than a month must not leak English months', () => {
  it('renders the month in the active locale', () => {
    setLanguage('ru');
    const longAgo = new Date();
    longAgo.setDate(longAgo.getDate() - 90);
    const formatted = formatUtils.formatDateToAgo(longAgo);
    expect(formatted).not.toMatch(
      /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/,
    );
    expect(formatted).toMatch(/[а-я]/i);
  });
});

describe('the locale used to format is the locale used to parse', () => {
  // A regioned tag must not be silently downgraded: en-GB renders day-first, and if the parser
  // resolved a different locale the round trip would swap day and month invisibly.
  it('formats en-GB day-first', () => {
    setLanguage('en-GB');
    expect(formatUtils.formatDateOnly(new Date(2026, 6, 6))).toBe('06/07/2026');
  });

  it('formats en-US month-first', () => {
    setLanguage('en-US');
    expect(formatUtils.formatDateOnly(new Date(2026, 6, 6))).toBe('7/6/2026');
  });
});
