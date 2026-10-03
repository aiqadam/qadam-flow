// What the action and its conversion worker send each other. Kept apart from the conversion
// itself, so the engine's thread checks replies without loading the workbook parser.

// The CSV is copied back into the engine's own heap, which also holds the step output and the
// run log built from it, so its length is bounded independently of the worker's memory.
export const MAX_CSV_LENGTH = 64 * 1024 * 1024;

export const conversionProtocol = {
  isConversionRequest(value: unknown): value is ConversionRequest {
    if (typeof value !== 'object' || value === null || !('parts' in value) || !('delimiter' in value)) {
      return false;
    }
    const { parts, delimiter } = value;
    const sheetName = 'sheetName' in value ? value.sheetName : undefined;
    return (
      typeof delimiter === 'string' &&
      (sheetName === undefined || typeof sheetName === 'string') &&
      typeof parts === 'object' &&
      parts !== null &&
      Object.values(parts).every((part) => part instanceof Uint8Array)
    );
  },

  isConvertedSheet(value: unknown): value is ConvertedSheet {
    if (typeof value !== 'object' || value === null || !('csv' in value) || !('sheet_name' in value) || !('available_sheets' in value)) {
      return false;
    }
    const { csv, sheet_name, available_sheets } = value;
    return (
      typeof csv === 'string' &&
      csv.length <= MAX_CSV_LENGTH &&
      typeof sheet_name === 'string' &&
      Array.isArray(available_sheets) &&
      available_sheets.every((name) => typeof name === 'string')
    );
  },

  // A RangeError is the JavaScript engine refusing a string, array or call stack the workbook
  // would need, so the worker reports it as a workbook too large or too complex to convert.
  failureMessage(error: Error): string {
    if (error instanceof RangeError) {
      return `The workbook is too large or too complex to convert: ${error.message}. Delete unused rows, columns and sheets, or split the workbook, and try again.`;
    }
    return error.message;
  },
};

export type ConversionRequest = {
  parts: Record<string, Uint8Array>;
  sheetName: string | undefined;
  delimiter: string;
};

export type ConvertedSheet = {
  csv: string;
  sheet_name: string;
  available_sheets: string[];
};
