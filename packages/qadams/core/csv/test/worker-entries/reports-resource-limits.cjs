// A conversion worker that fails with the resource limits it was started with as its message.
const { parentPort, resourceLimits } = require('node:worker_threads');
parentPort.postMessage({ ok: false, message: JSON.stringify(resourceLimits) });
