import i18next from 'i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { localeUtils } from '@/lib/locale-utils';

vi.mock('i18next', () => ({
  default: { language: 'en' },
}));

const setLanguage = (language: string) => {
  // The mock is a plain object so the active locale can be varied per case; every formatter in
  // web reads it, and with a frozen 'en' none of the locale-dependent branches are reachable.
  (i18next as unknown as { language: string }).language = language;
};

beforeEach(() => {
  setLanguage('en');
});

describe('localeUtils.getActiveLocale', () => {
  // Asserted with `de` because it is one of the locales the parse bug affects and it exists on
  // main. Note what getActiveLocale actually validates against: `Intl.DateTimeFormat
  // .supportedLocalesOf`, NOT LocalesEnum — LocalesEnum only supplies the English fallback. That
  // matters, because it means a browser set to a locale absent from `supportedLngs` still gets its
  // own date and number formatting while the UI text falls back to English.
  it('returns a supported locale unchanged', () => {
    setLanguage('de');
    expect(localeUtils.getActiveLocale()).toBe('de');
  });

  it('keeps a regioned tag Intl supports, so parsing matches what was displayed', () => {
    setLanguage('de-AT');
    expect(localeUtils.getActiveLocale()).toBe('de-AT');
  });

  // Intl accepts an unknown *region* (`de-ZZ` resolves like `de`), so that tag is kept — display
  // and parse still agree, which is the property that matters. Only an unknown *language* subtag
  // is unusable, and then the base subtag is tried before English.
  it('keeps a tag whose region is unknown but whose language is not', () => {
    setLanguage('de-ZZ');
    expect(localeUtils.getActiveLocale()).toBe('de-ZZ');
  });

  it('falls back to English for an unknown language subtag', () => {
    setLanguage('zz-ZZ');
    expect(localeUtils.getActiveLocale()).toBe('en');
  });

  it('falls back to English rather than letting Intl throw on an unknown tag', () => {
    setLanguage('xx-YY');
    expect(localeUtils.getActiveLocale()).toBe('en');
  });
});

describe('localeUtils.getDatePlaceholder', () => {
  it.each([
    ['en', 'mm/dd/yyyy'],
    ['ru', 'dd.mm.yyyy'],
    ['de', 'dd.mm.yyyy'],
    ['uz', 'dd/mm/yyyy'],
    ['kk', 'dd.mm.yyyy'],
    ['ja', 'yyyy/mm/dd'],
  ])('describes the field order %s actually uses', (locale, expected) => {
    expect(localeUtils.getDatePlaceholder({ locale })).toBe(expected);
  });
});

describe('localeUtils.parseLocaleDate', () => {
  // The defect this replaces: the editor rendered a cell with Intl and re-parsed it with
  // `new Date(string)`, which is Invalid Date for every dot/slash day-first locale. Typing into
  // a date cell then cleared it instead of saving.
  it.each(['en', 'ru', 'de', 'uz', 'kk', 'ja', 'fr'])(
    'round-trips a date rendered in %s',
    (locale) => {
      const rendered = new Intl.DateTimeFormat(locale, {
        day: 'numeric',
        month: 'numeric',
        year: 'numeric',
      }).format(new Date(2026, 5, 20));

      const parsed = localeUtils.parseLocaleDate({ value: rendered, locale });

      expect(parsed).toBeDefined();
      expect(parsed?.getFullYear()).toBe(2026);
      expect(parsed?.getMonth()).toBe(5);
      expect(parsed?.getDate()).toBe(20);
    },
  );

  it('reads day-first locales day-first, not as the US month', () => {
    const parsed = localeUtils.parseLocaleDate({
      value: '06.07.2026',
      locale: 'ru',
    });
    expect(parsed?.getDate()).toBe(6);
    expect(parsed?.getMonth()).toBe(6);
  });

  it('rejects an overflowing date instead of rolling it into the next month', () => {
    expect(
      localeUtils.parseLocaleDate({ value: '31.02.2026', locale: 'ru' }),
    ).toBeUndefined();
  });

  it.each(['', 'garbage', '20.06', '1.2.3.4'])(
    'returns undefined for unparseable input %j',
    (value) => {
      expect(
        localeUtils.parseLocaleDate({ value, locale: 'ru' }),
      ).toBeUndefined();
    },
  );

  // `new Date(value)` accepted an ISO date, so rejecting one would be a regression for anyone
  // pasting a date rather than typing it — including on `en`, where the old code worked.
  it.each(['en', 'ru', 'ja'])('still accepts a pasted ISO date on %s', (locale) => {
    const parsed = localeUtils.parseLocaleDate({ value: '2026-06-20', locale });
    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(5);
    expect(parsed?.getDate()).toBe(20);
  });

  it('does not mistake an ISO date for a day-first date on ru', () => {
    // 2026-06-20 must not be read as day=2026; the ISO branch has to win before field mapping.
    expect(
      localeUtils.parseLocaleDate({ value: '2026-06-20', locale: 'ru' })?.getDate(),
    ).toBe(20);
  });

  it('pivots a two-digit year into the 2000s', () => {
    const parsed = localeUtils.parseLocaleDate({
      value: '20.06.26',
      locale: 'ru',
    });
    expect(parsed?.getFullYear()).toBe(2026);
  });

  it('serialises to the typed calendar day at this runner offset', () => {
    const parsed = localeUtils.parseLocaleDate({
      value: '20.06.2026',
      locale: 'ru',
    });
    // Local noon keeps the UTC date part correct for |offset| < 12, which covers every locale this
    // ships for (ru +3, uz +5, kk +6). It is NOT universal: at UTC+13/+14 the UTC date part is a
    // day behind, so this assertion is offset-dependent by construction rather than absolute.
    expect(parsed?.getDate()).toBe(20);
    expect(parsed?.getHours()).toBe(12);
  });

  it('rejects a year that is not 2 or 4 digits, so a half-typed value cannot commit', () => {
    expect(
      localeUtils.parseLocaleDate({ value: '20.06.202', locale: 'ru' }),
    ).toBeUndefined();
    expect(
      localeUtils.parseLocaleDate({ value: '20.06.20266', locale: 'ru' }),
    ).toBeUndefined();
  });
});

describe('display and parse must agree on the locale', () => {
  // The defect this guards: formatUtils.formatDateOnly renders with i18next.language verbatim. If
  // getActiveLocale stripped the region, `en-GB` would render day-first and parse month-first, so
  // 06/07/2026 typed for 6 July would store 7 June and redisplay identically — invisible corruption.
  it.each(['en-GB', 'en-US', 'de-AT', 'ru-RU'])(
    'round-trips what the cell displays for %s',
    (language) => {
      setLanguage(language);
      const locale = localeUtils.getActiveLocale();
      const day = new Date(2026, 6, 6, 12); // 6 July, ambiguous under a day/month swap
      const rendered = new Intl.DateTimeFormat(locale, {
        day: 'numeric',
        month: 'numeric',
        year: 'numeric',
      }).format(day);

      const parsed = localeUtils.parseLocaleDate({ value: rendered, locale });

      expect(parsed?.getMonth()).toBe(6);
      expect(parsed?.getDate()).toBe(6);
    },
  );

  it('keeps the region when Intl supports it', () => {
    setLanguage('en-GB');
    expect(localeUtils.getActiveLocale()).toBe('en-GB');
  });

  it('does not throw on a structurally malformed tag', () => {
    setLanguage('en_US');
    expect(localeUtils.getActiveLocale()).toBe('en');
  });
});
