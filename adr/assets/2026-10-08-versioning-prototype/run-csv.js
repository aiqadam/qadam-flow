const heap = () => { global.gc(); return process.memoryUsage().heapUsed / 1048576; };
require('@aiqadam/qadams-framework');
const input = 'name,age\nAli,30\n"Bek, Jr.",25\n';
(async () => {
  for (const v of ['0.4.14', '0.5.0', '0.6.0']) {
    const mod = require(`./csv/${v}/index.js`);
    const q = Object.values(mod).find(x => x && typeof x.metadata === 'function');
    const action = q.getAction('convert_csv_to_json') ?? Object.values(q.actions())[0];
    const props = Object.keys(action.props);
    const ctx = { propsValue: { csv_text: input, has_headers: true, delimiter_type: ',' }, run: { id: 'r1' }, server: {}, executionType: 'BEGIN' };
    let res; try { res = await action.run(ctx); } catch (e) { res = 'ERROR: ' + e.message; }
    console.log(`csv@${v} action=${action.name} props=[${props}] ->`, JSON.stringify(res));
  }
  console.log(`heap ${heap().toFixed(1)} MiB`);
})();
