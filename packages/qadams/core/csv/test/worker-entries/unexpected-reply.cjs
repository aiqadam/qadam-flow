// A conversion worker whose reply does not have the shape the action expects.
require('node:worker_threads').parentPort.postMessage({ ok: true, sheet: { csv: 1 } });
