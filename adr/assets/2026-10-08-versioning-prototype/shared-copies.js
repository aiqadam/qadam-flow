const heap = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed / 1048576; };
let h = heap();
for (const p of ['/tmp/qf-proto/packages/shared', './s2', './s3']) {
  const t = process.hrtime.bigint(); require(require('path').resolve(p)); const ms = Number(process.hrtime.bigint() - t) / 1e6;
  const n = heap(); console.log(`shared copy ${p}: +${(n - h).toFixed(1)} MiB, ${ms.toFixed(0)} ms`); h = n;
}
