const fs = require('fs');
const lines = fs.readFileSync(__dirname + '/list.txt', 'utf8').trim().split('\n').map(l => l.split(' ')).filter(x => x[3] === '1');
const load = p => { const m = require(p); return Object.values(m).find(x => x && typeof x.metadata === 'function').metadata(); };
let safe = 0, unsafe = 0;
for (const [q, vo, vn] of lines) {
  let o, n; try { o = load(`./${q}/old.js`); n = load(`./${q}/new.js`); } catch (e) { console.log(`${q}: LOAD FAIL ${e.message.split('\n')[0]}`); continue; }
  const issues = [], info = [];
  for (const kind of ['actions', 'triggers']) {
    for (const [name, a] of Object.entries(o[kind])) {
      const b = n[kind][name];
      if (!b) { issues.push(`${kind.slice(0,-1)} '${name}' REMOVED`); continue; }
      for (const [p, pa] of Object.entries(a.props)) {
        const pb = b.props[p];
        if (!pb) { issues.push(`${name}.${p} REMOVED`); continue; }
        if (pa.type !== pb.type) issues.push(`${name}.${p} type ${pa.type}->${pb.type}`);
        if (!pa.required && pb.required && pb.defaultValue === undefined) issues.push(`${name}.${p} became required`);
        const oo = pa.options?.options?.map(x => JSON.stringify(x.value)), no = pb.options?.options?.map(x => JSON.stringify(x.value));
        if (oo && no) { const lost = oo.filter(x => !no.includes(x)); if (lost.length) issues.push(`${name}.${p} dropdown values removed ${lost}`); }
      }
      for (const [p, pb] of Object.entries(b.props)) if (!a.props[p]) (pb.required && pb.defaultValue === undefined ? issues : info).push(`${name}.+${p}${pb.required && pb.defaultValue === undefined ? ' NEW REQUIRED no default' : ''}`);
    }
    for (const name of Object.keys(n[kind])) if (!o[kind][name]) info.push(`+${kind.slice(0,-1)} ${name}`);
  }
  issues.length ? unsafe++ : safe++;
  console.log(`${issues.length ? '❌' : '✅'} ${q} ${vo} -> ${vn}` + (issues.length ? `\n     breaks: ${issues.join('; ')}` : '') + (info.length ? `\n     added: ${info.slice(0, 6).join('; ')}${info.length > 6 ? ` …(+${info.length - 6})` : ''}` : ''));
}
console.log(`\nprops-ABI compatible: ${safe}, breaking: ${unsafe}`);
