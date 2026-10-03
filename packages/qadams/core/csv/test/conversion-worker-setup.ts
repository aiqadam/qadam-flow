/// <reference types="vitest/globals" />

import path from 'node:path';
import { conversionWorker } from '../src/lib/common/conversion-worker';

// The action starts its conversion worker from the compiled entry point next to it in dist.
// Tests run from source, so every conversion they start uses the TypeScript entry instead,
// through a small loader; everything else about the worker is unchanged.
const TEST_WORKER_ENTRY = path.join(__dirname, 'conversion-worker-entry.cjs');
const runConversion = conversionWorker.run;

vi.spyOn(conversionWorker, 'run').mockImplementation((params) => runConversion({ entry: TEST_WORKER_ENTRY, ...params }));
