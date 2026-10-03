// The conversion worker's entry point as the tests start it: here the entry is TypeScript
// source rather than the compiled file the action uses, so it is loaded through tsx.
require('tsx/cjs');
require('../src/lib/common/excel-to-csv-worker.ts');
