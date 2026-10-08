const v8 = require('v8');
const heap = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed / 1048576; };
const t0 = heap();
let t = process.hrtime.bigint();
const fw = require('@aiqadam/qadams-framework'); require('@aiqadam/qadams-common'); require('@aiqadam/shared');
const libMs = Number(process.hrtime.bigint() - t) / 1e6;
const t1 = heap();
console.log(`host libs (shared+framework+common, ONE copy): +${(t1 - t0).toFixed(1)} MiB heap, ${libMs.toFixed(0)} ms`);
const out = {};
let prev = t1;
for (const v of ['0.3.1', '0.4.5', '0.5.1']) {
  t = process.hrtime.bigint();
  const mod = require(`./tables/${v}/index.js`);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  const q = Object.values(mod).find(x => x && typeof x.metadata === 'function');
  const md = q.metadata();
  const h = heap();
  out[v] = md;
  const actions = Object.keys(md.actions), triggers = Object.keys(md.triggers);
  console.log(`tables@${v}: loaded OK, +${(h - prev).toFixed(2)} MiB, ${ms.toFixed(0)} ms, ${actions.length} actions, ${triggers.length} triggers, contextVersion=${q.getContextInfo?.().version}, minRelease=${md.minimumSupportedRelease}`);
  prev = h;
}
// same framework instance? (instanceof across versions)
const keys = (v) => new Set(Object.keys(out[v].actions));
for (const [a, b] of [['0.3.1', '0.5.1'], ['0.4.5', '0.5.1']]) {
  const A = keys(a), B = keys(b);
  const removed = [...A].filter(x => !B.has(x)), added = [...B].filter(x => !A.has(x));
  const changed = [];
  for (const x of [...A].filter(x => B.has(x))) {
    const pa = out[a].actions[x].props, pb = out[b].actions[x].props;
    const ka = Object.keys(pa), kb = Object.keys(pb);
    const rm = ka.filter(k => !kb.includes(k)), ad = kb.filter(k => !ka.includes(k));
    const req = kb.filter(k => ka.includes(k) && !pa[k].required && pb[k].required);
    const newReq = ad.filter(k => pb[k].required && pb[k].defaultValue === undefined);
    const typ = kb.filter(k => ka.includes(k) && pa[k].type !== pb[k].type);
    if (rm.length || ad.length || req.length || typ.length) changed.push(`${x}: ${rm.length ? '-' + rm.join(',') + ' ' : ''}${ad.length ? '+' + ad.join(',') + ' ' : ''}${newReq.length ? '[NEW REQUIRED w/o default: ' + newReq.join(',') + '] ' : ''}${req.length ? '[became required: ' + req.join(',') + '] ' : ''}${typ.length ? '[type changed: ' + typ.join(',') + ']' : ''}`);
  }
  console.log(`\nABI diff tables ${a} -> ${b}: actions removed=[${removed}] added=[${added}]`);
  changed.forEach(c => console.log('  ' + c));
}
console.log(`\ntotal heap now: ${heap().toFixed(1)} MiB`);
