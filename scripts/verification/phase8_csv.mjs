// Compare ordered serialized CSV against independent fixture corners and clocks.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const timeFloor=1e-15;
export function expectedRows(c){
 const corners=c.expected.points, rows=[];
 const append=(t,v)=>{if(t>c.stop)return;const last=rows.at(-1);if(last&&Math.abs(last[0]-t)<=timeFloor){assert.ok(Math.abs(last[1]-v)<=1e-8);return;}rows.push([t,v]);};
 if(c.expected.outer){for(let burst=0;burst*c.expected.outer<=c.stop;burst++)for(let n=0;n<c.expected.count;n++)for(const [t,v] of corners)append(burst*c.expected.outer+n*c.expected.period+t,v);}
 else if(c.expected.period){for(let n=0;n*c.expected.period<=c.stop;n++)for(const [t,v] of corners)append(n*c.expected.period+t,v);}
 else for(const [t,v] of corners)append(t,v);
 if(c.expected.period&&Math.abs(rows.at(-1)[0]-c.stop)>timeFloor){
  let t=c.stop;if(c.expected.outer)t%=c.expected.outer;
  let value=corners[0][1];
  if(!c.expected.outer||t<((c.expected.count-1)*c.expected.period+corners.at(-1)[0])){
   t%=c.expected.period;value=corners.at(-1)[1];
   for(let i=1;i<corners.length;i++)if(t<=corners[i][0]){const [a,b]=corners[i-1],[d,e]=corners[i];value=b+(e-b)*(t-a)/(d-a);break;}
  }
  append(c.stop,value);
 }
 return rows;
}
export function compareCsv(c,text){
 const lines=text.replace(/\r\n/g,'\n').split('\n');if(lines.at(-1)==='')lines.pop();
 assert.equal(lines.shift(),`time_s,${c.dimension==='current'?'current_A':'voltage_V'}`,`${c.name}: SI header`);
 const rows=lines.map((line,i)=>{const fields=line.split(',');assert.equal(fields.length,2,`${c.name}: row ${i} columns`);assert.ok(fields.every(f=>f.trim()!==''),`${c.name}: empty field`);const values=fields.map(Number);assert.ok(values.every(Number.isFinite),`${c.name}: finite row`);return values;});
 const expected=expectedRows(c);assert.equal(rows.length,expected.length,`${c.name}: exact event row count`);
 rows.forEach(([t,v],i)=>{assert.ok(i===0||t>rows[i-1][0],`${c.name}: strictly ordered rows`);assert.ok(Math.abs(t-expected[i][0])<=timeFloor,`${c.name}: event ${i} time`);assert.ok(Math.abs(v-expected[i][1])<=Math.max(1e-8,Math.abs(expected[i][1])*1e-10),`${c.name}: event ${i} amplitude`);});
 return {name:c.name,independentEvents:expected.length,observedCsvRows:rows.length,terminalTimeS:rows.at(-1)[0],result:'pass'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const manifestPath=path.resolve(process.argv[2]),manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
 const results=manifest.cases.map(c=>{const e=c.exports.find(e=>e.format==='csv');return compareCsv(c,fs.readFileSync(path.join(e.directory,e.artifacts[0].filename),'utf8'));});
 const output=path.join(path.dirname(manifestPath),`acceptance-csv-comparison-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
 fs.writeFileSync(output,JSON.stringify({scope:'Exact ordered CSV software comparison. No simulator or browser claim.',timeAbsoluteS:timeFloor,amplitudeAbsolute:1e-8,amplitudeRelative:1e-10,results},null,2)+'\n',{flag:'wx'});console.log(output);
}
