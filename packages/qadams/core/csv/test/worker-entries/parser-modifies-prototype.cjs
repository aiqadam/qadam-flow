// The conversion worker's own entry point, started with a workbook parser that adds a property
// to Object.prototype while it loads.
require('tsx/cjs');
const { Workbook } = require('@cj-tech-master/excelts');

const loader = Object.getPrototypeOf(Object.getPrototypeOf(new Workbook().xlsx));
const loadFromFiles = loader.loadFromFiles;
loader.loadFromFiles = function (...args) {
  Object.defineProperty(Object.prototype, 'addedByParser', { value: true, configurable: true });
  return loadFromFiles.apply(this, args);
};

require('../../src/lib/common/excel-to-csv-worker.ts');
