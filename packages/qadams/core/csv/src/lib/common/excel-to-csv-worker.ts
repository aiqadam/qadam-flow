import { parentPort, workerData } from 'node:worker_threads';
import { conversionProtocol } from './conversion-protocol';
import { workbookToCsv } from './workbook-to-csv';
import { workerUtils } from './worker-utils';

// Entry point of the conversion worker started by conversion-worker.ts: one conversion, one
// reply, then the thread ends and its heap goes with it.
void convertAndReply();

async function convertAndReply(): Promise<void> {
  const request: unknown = workerData;
  if (!conversionProtocol.isConversionRequest(request)) {
    parentPort?.postMessage({ ok: false, message: 'The conversion worker received a request it does not understand.' });
    return;
  }
  const { data, error } = await workerUtils.tryCatch(() => workbookToCsv.convertGuarded(request));
  parentPort?.postMessage(error === null ? { ok: true, sheet: data } : { ok: false, message: conversionProtocol.failureMessage(error) });
}
