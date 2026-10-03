export const conversionErrors = {
  unreadableWorkbook(reason: string): Error {
    return new Error(`The file could not be read as an Excel workbook (.xlsx): ${reason}`);
  },
};
