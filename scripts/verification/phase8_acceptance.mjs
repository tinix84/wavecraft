// Run with Node 24. Tests use independent arithmetic and explicit event identities.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { compileDocument, expandFinite, evaluate } from '../../web/src/semantic/index.ts';
import { exportWaveform } from '../../web/src/export/index.ts';
import { packProject, unpackProject } from '../../web/src/project/index.ts';
import { SemanticController } from '../../web/src/source/controller.ts';
import { correctionCommands } from '../../web/src/ui/semantic-authoring.ts';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const run=path.join(root,'outputs/phase8',`acceptance-${new Date().toISOString().replace(/[:.]/g,'-')}`);
fs.mkdirSync(run,{recursive:true});
const write=(name,value)=>fs.writeFileSync(path.join(run,name),value,{flag:'wx'});
const json=(name,value)=>write(name,JSON.stringify(value,null,2)+'\n');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const checks=[];
function check(name,fn){fn();checks.push({name,result:'pass'});}
const close=(a,b)=>assert.ok(Math.abs(a-b)<=Math.max(1e-18,Math.abs(b)*1e-10),`${a} != ${b}`);
const good=d=>{const r=compileDocument(d);assert.equal(r.ok,true,JSON.stringify(r.diagnostics));return r.compiled;};
const doc=(segments,signal={dimension:'current',initial:'0 A',nominal:'240 A'})=>({schema:'wavecraft/1',name:'Phase 8 independent acceptance',signal,segments});
const ramp=(id,to,duration)=>({id,kind:'ramp',to,duration});
const hold=(id,duration)=>({id,kind:'hold',duration});
const pulse=target=>[{id:'rise',kind:'ramp',to:target,slew:'6 A/us'},hold('hold','2 ms'),{id:'return',kind:'ramp',to:'0 A',slew:'6 A/us'}];
const authored=doc([{id:'pulse',kind:'repeat',period:'3 ms',count:'continuous',pattern:pulse('175%')}]);
const changed=structuredClone(authored);changed.segments[0].pattern[0].to='200%';
check('A independent 240*1.75/6e6 and 240*2/6e6 rise times',()=>{close(good(authored).nodes[0].pattern[0].timing.durationS,70e-6);close(good(changed).nodes[0].pattern[0].timing.durationS,80e-6);});
check('A controller target, text edit, explicit conflict correction, mixed undo',()=>{
 const initial=JSON.stringify(doc([{...pulse('175%')[0],arriveAt:'70 us'}]));const c=new SemanticController(initial);
 const edit={type:'target',id:'rise',value:'200%'};const bad=c.propose(edit);assert.equal(bad.ok,false);assert.equal(c.source,initial);assert.equal(bad.diagnostics[0].code,'ANCHOR_CONFLICT');
 const correction=correctionCommands(edit,bad.diagnostics)[0];const proposed=c.propose(correction.command);assert.equal(proposed.ok,true);assert.equal(c.commitProposal(proposed.proposal).ok,true);close(c.result.compiled.nodes[0].timing.durationS,80e-6);
 const graphical=c.source;c.setDraft(graphical.replace('200%','150%'));assert.equal(c.applyDraft().ok,true);close(c.result.compiled.nodes[0].timing.durationS,60e-6);c.undo();assert.equal(c.source,graphical);c.undo();assert.equal(c.source,initial);
});
const one=[ramp('up','10 A','100 ns'),hold('top','100 ns'),ramp('down','0 A','100 ns')];
const two=[...one,hold('gap','100 ns'),ramp('up2','20 A','100 ns'),ramp('down2','0 A','100 ns')];
const burst=pattern=>doc([{id:'burst',kind:'repeat',frequency:'1 MHz',count:10,outer:{frequency:'1 Hz',count:'continuous'},pattern}]);
const localOne=[[0,0],[1e-7,10],[2e-7,10],[3e-7,0]];
const localTwo=[...localOne,[4e-7,0],[5e-7,20],[6e-7,0]];
for(const [name,pattern,local,peaks] of [['one',one,localOne,1],['two',two,localTwo,2]])check(`C ${name}: 10 pattern starts and ${10*peaks} peaks per burst`,()=>{
 const c=good(burst(pattern)),n=c.nodes[0];close(n.periodS,1e-6);close(n.frequencyHz,1e6);close(n.outer.periodS,1);close(n.outer.frequencyHz,1);close(n.activeSpanS,9e-6+local.at(-1)[0]);
 const expanded=expandFinite(c,{horizonS:1.00001});assert.equal(expanded.ok,true);
 // At 1 s, binary64 timestamp subtraction can amplify one ULP by the 2e8 A/s slope.
 for(const offset of [0,1])for(let i=0;i<10;i++)for(const [t,v] of local)assert.ok(Math.abs(evaluate(c,offset+i*1e-6+t)-v)<=1e-7);
 for(const offset of [0,1])assert.equal(expanded.points.filter(([t,v],i,a)=>t>=offset&&t<offset+1e-5&&v>0&&i>0&&a[i-1][1]<v).length,10*peaks);
});
check('C rejects long pattern and long burst without changing source clocks',()=>{
 for(const invalid of [burst([ramp('up','10 A','600 ns'),ramp('down','0 A','600 ns')]),(()=>{const d=burst(one);d.segments[0].outer={period:'9 us',count:'continuous'};return d;})()]){const before=JSON.stringify(invalid);assert.equal(compileDocument(invalid).ok,false);assert.equal(JSON.stringify(invalid),before);}
});
const cases=[
 {name:'A-175',source:authored,expected:{points:[[0,0],[70e-6,420],[.00207,420],[.00214,0],[.003,0]],period:.003,count:'continuous'},stop:.010},
 {name:'A-200',source:changed,expected:{points:[[0,0],[80e-6,480],[.00208,480],[.00216,0],[.003,0]],period:.003,count:'continuous'},stop:.010},
 {name:'signed-voltage',source:doc([ramp('negative','-4 V','1 ms'),hold('negative-hold','1 ms'),ramp('back','2 V','1 ms')],{dimension:'voltage',initial:'2 V'}),expected:{points:[[0,2],[.001,-4],[.002,-4],[.003,2]]},stop:.005},
 ...[['C-one',one,localOne],['C-two',two,localTwo]].map(([name,pattern,points])=>({name,source:burst(pattern),expected:{points,period:1e-6,count:10,outer:1,outerCount:'continuous'},stop:2.00001}))
];
for(const fixture of cases){
 const compiled=good(fixture.source);fixture.dimension=compiled.dimension;const directory=path.join(run,fixture.name);fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'authoring.json'),JSON.stringify(fixture.source,null,2),{flag:'wx'});
 check(`${fixture.name}: independent corners and interiors`,()=>{const amplitude=(a,b)=>assert.ok(Math.abs(a-b)<=Math.max(1e-8,Math.abs(b)*1e-10));for(let i=0;i<fixture.expected.points.length;i++){const [t,v]=fixture.expected.points[i];amplitude(evaluate(compiled,t),v);if(i){const [a,b]=fixture.expected.points[i-1];amplitude(evaluate(compiled,(a+t)/2),(b+v)/2);}}});
 check(`${fixture.name}: archive exact source and notes roundtrip`,()=>{const snapshot={revisionId:`phase8-${fixture.name}`,mode:'semantic',source:JSON.stringify(fixture.source),evidence:{notes:'Independent acceptance fixture. No physical measurement claim.'}};const bytes=packProject(snapshot);fs.writeFileSync(path.join(directory,'project.wavecraft.zip'),bytes,{flag:'wx'});assert.deepEqual(unpackProject(bytes),snapshot);});
 fixture.exports=[];
 for(const format of ['csv','pwl','pwl-file','plecs']){const target=path.join(directory,format);fs.mkdirSync(target);const result=exportWaveform(compiled,{format,name:fixture.name,...(compiled.continuous&&['csv','plecs'].includes(format)?{horizonS:fixture.stop}:{})});assert.equal(result.ok,true,JSON.stringify(result.diagnostics));for(const artifact of result.artifacts)fs.writeFileSync(path.join(target,artifact.filename),artifact.content,{flag:'wx'});fixture.exports.push({format,directory:target,artifacts:result.artifacts.map(({filename,role})=>({filename,role})),metadata:result.metadata});}
}
check('signed voltage midpoint and endpoint holding',()=>{const c=good(cases[2].source);close(evaluate(c,.0005),-1);close(evaluate(c,5),2);});
const html=fs.readFileSync(path.join(root,'prototypes/wavecraft-web-prototype.html'));const sha=hash(html);
check('frozen HTML byte preservation',()=>assert.equal(sha,'e1bf4a8b35629f0652b2fb53fd3c49582e333da725171dc95bba3f26b1305a64'));
check('standalone HTML has no external asset tags',()=>assert.doesNotMatch(html.toString(),/<(?:script|link|img)\b[^>]*(?:src|href)\s*=\s*["'](?:https?:)?\/\//i));
json('manifest.json',{generatedAt:new Date().toISOString(),tolerances:{arithmeticRelative:1e-10,arithmeticAbsolute:1e-18,evaluationAmplitudeAbsolute:1e-8,outerTimestampAmplitudeAbsoluteA:1e-7,outerTimestampRationale:'1 s timestamp binary64 ULP multiplied by the maximum 2e8 A/s ramp slope is below 1e-7 A.',simulatorAmplitudeRelative:1e-6,simulatorAmplitudeAbsolute:1e-8,eventIdentity:'Exact count and explicit event list; no tolerance can hide a missing pulse.'},cases});
json('verification.json',{generatedAt:new Date().toISOString(),checks,passed:checks.length,failed:0,html:{sha256:sha,bytes:html.length},scope:'Native Node API and controller verification. No browser, physical measurement, external digitizer or simulator execution claim.'});
console.log(run);
