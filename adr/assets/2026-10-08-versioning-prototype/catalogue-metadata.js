const fs=require('fs'), zlib=require('zlib'); let ok=0, fail=0, sizes=[], all={};
for (const f of fs.readdirSync('own3p')) { try { const m=require('./own3p/'+f); const q=Object.values(m).find(x=>x&&typeof x.metadata==='function'); const md=q.metadata(); const s=JSON.stringify(md); sizes.push(s.length); all[f]=md; ok++; } catch(e){ fail++; } }
sizes.sort((a,b)=>a-b); const tot=sizes.reduce((a,b)=>a+b,0); const gz=zlib.gzipSync(JSON.stringify(all)).length;
console.log(`metadata: ok=${ok} fail=${fail} total=${(tot/1048576).toFixed(1)}MB gz=${(gz/1048576).toFixed(2)}MB median=${(sizes[sizes.length>>1]/1024).toFixed(0)}KB max=${(sizes.at(-1)/1024).toFixed(0)}KB`);
