import { LocalesEnum } from '@aiqadam/shared';
import i18next from 'i18next';

// Day 22, month 11, year 3333: every field differs and none is <= 12, so the numeric parts can be
// told apart no matter how a locale orders them.
const FIELD_ORDER_REFERENCE = new Date(3333, 10, 22);

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const DATE_FIELD_PLACEHOLDERS = {
  day: 'dd',
  month: 'mm',
  year: 'yyyy',
} as const;

// Intl resolves an unknown-but-well-formed tag to the default locale rather than throwing, so a
// membership test is what distinguishes usable from not. It DOES throw RangeError on a structurally
// malformed tag (`en_US`, `e`), which is why this is guarded.
function isIntlUsable(locale: string) {
  try {
    return Intl.DateTimeFormat.supportedLocalesOf(locale).length > 0;
  } catch {
    return false;
  }
}

function toNumericDateParts({ locale }: { locale: string }) {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
  }).formatToParts(FIELD_ORDER_REFERENCE);
}

// Must resolve to the SAME locale formatUtils.formatDateOnly renders with, which is
// `i18next.language` verbatim. Stripping the region here instead would make display and parse
// disagree: `en-GB` renders 20/06/2026 day-first while `en` parses month-first, so a UK user
// typing 06/07/2026 for 6 July would silently store 7 June — and it would redisplay identically,
// making the corruption invisible in the UI.
function getActiveLocale() {
  const language = i18next.language;
  if (language !== undefined && language !== '') {
    if (isIntlUsable(language)) {
      return language;
    }
    const base = language.split('-')[0];
    if (base !== '' && isIntlUsable(base)) {
      return base;
    }
  }
  return LocalesEnum.ENGLISH;
}

function getDateFieldOrder({ locale }: { locale: string }) {
  const parts = toNumericDateParts({ locale });
  const order = parts
    .filter(
      (part) =>
        part.type === 'day' || part.type === 'month' || part.type === 'year',
    )
    .map((part) => part.type);
  const separator = parts.find((part) => part.type === 'literal')?.value ?? '/';
  return { order, separator };
}

function getDatePlaceholder({ locale }: { locale: string }) {
  const { order, separator } = getDateFieldOrder({ locale });
  // The field abbreviations stay Latin (`dd.mm.yyyy`): it is a convention users already read, and
  // localising them would mean three new translation keys in every locale for no clarity gain.
  return order
    .map((field) =>
      field === 'day' || field === 'month' || field === 'year'
        ? DATE_FIELD_PLACEHOLDERS[field]
        : '',
    )
    .join(separator);
}

function parseLocaleDate({ value, locale }: { value: string; locale: string }) {
  const digitGroups = value.split(/\D+/).filter((group) => group.length > 0);
  if (digitGroups.length !== 3) {
    return undefined;
  }

  const fields = { day: 0, month: 0, year: 0 };
  // An ISO date is unambiguous and `new Date(value)` used to accept it, so keep accepting it in
  // every locale rather than regressing anyone who pastes one.
  const isoMatch = ISO_DATE.exec(value.trim());
  let yearDigits = 4;
  if (isoMatch) {
    [fields.year, fields.month, fields.day] = isoMatch.slice(1, 4).map(Number);
  } else {
    const { order } = getDateFieldOrder({ locale });
    order.forEach((field, index) => {
      if (field === 'day' || field === 'month' || field === 'year') {
        fields[field] = Number(digitGroups[index]);
      }
    });
    yearDigits = digitGroups[order.indexOf('year')]?.length ?? 0;
  }

  // A year must be written with 2 or 4 digits. Without this, a value caught mid-typing commits
  // silently: `20.06.202` would store year 202 and `20.06.20266` an expanded-year date, both of
  // which survive the exactness check below because the year is taken as written.
  if (yearDigits !== 2 && yearDigits !== 4) {
    return undefined;
  }

  const { day, month } = fields;
  // Two-digit years are pivoted into the 2000s, so `26` is 2026 and 1926 is not reachable.
  const year = fields.year < 100 ? 2000 + fields.year : fields.year;

  // Local noon, not local midnight: the value is persisted via toISOString(), and local midnight
  // lands on the previous UTC calendar day at every POSITIVE offset — which is ru (+3), uz (+5) and
  // kk (+6), the users this exists for. Noon keeps the local rendering correct for every offset and
  // the UTC date part correct for |offset| < 12; at UTC+13/+14 the UTC date part is still one day
  // behind, which local display does not show. Storing 12:00 UTC instead would invert the problem
  // and misrender the date for those users, so this is the better trade, not a complete fix.
  const parsed = new Date(year, month - 1, day, 12);

  // Date() rolls overflow silently — 31.02 becomes 3 March — so reject anything that did not
  // survive the round trip rather than storing a date the user never typed.
  const isExact =
    parsed.getFullYear() === year &&
    parsed.getMonth() === month - 1 &&
    parsed.getDate() === day;

  return isExact ? parsed : undefined;
}

export const localeUtils = {
  getActiveLocale,
  getDateFieldOrder,
  getDatePlaceholder,
  parseLocaleDate,
};

export const localesMap = {
  [LocalesEnum.ENGLISH]: 'English',
  [LocalesEnum.RUSSIAN]: 'Русский',
  [LocalesEnum.UZBEK]: "O'zbek",
  [LocalesEnum.KAZAKH]: 'Қазақша',
};
