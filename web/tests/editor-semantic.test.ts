import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { SemanticSession, semanticSamples, localDetail } from '../src/editor-semantic-entry.ts';

test('YAML apply preserves comments and intent; percentage edit changes ramp duration independently', () => {
  const session = new SemanticSession(), original = '# Design intent stays here.\r\n' + semanticSamples.current;
  assert.equal(session.apply(original), true);
  assert.equal(session.result!.compiled.nodes[0].timing.durationS, 70e-6);
  assert.equal(session.output('yaml'), original);
  assert.equal(session.apply(original.replace('to: 175%', 'to: 200%')), true);
  assert.equal(session.result!.compiled.nodes[0].timing.durationS, 80e-6);
  assert.equal(session.result!.compiled.nodes[1].timing.durationS, .002);
  const project = JSON.parse(session.output('json'));
  assert.equal(project.format, 'wavecraft-semantic-project/1');
  assert.match(project.sourceText, /to: 200%/);
  assert.equal(project.points, undefined);
});

test('invalid and unapplied drafts retain the compiled waveform and block every export until restore', () => {
  const session = new SemanticSession();
  session.apply(semanticSamples.current);
  const valid = session.result;
  session.draft(semanticSamples.current.replace('6 A/us', '0 A/us'));
  for (const format of ['yaml','json','csv','pwl','python','javascript','matlab']) assert.throws(() => session.output(format), /Apply or restore/);
  assert.equal(session.apply(), false);
  assert.equal(session.result, valid);
  assert.ok(session.diagnostics.some(d => d.source.id === 'rise' && d.source.range));
  session.restore();
  assert.equal(session.output('yaml'), semanticSamples.current);
});

test('all finite point exports retain signed voltage and physical dimensions', () => {
  const session = new SemanticSession();
  assert.equal(session.apply(semanticSamples.voltage), true);
  assert.match(session.output('csv'), /time_s,voltage_V\n0,-12\n/);
  assert.match(session.output('pwl'), /Voltage: volts, V\(1\)-V\(0\)/);
  assert.match(session.output('pwl'), /V_SIGNAL 1 0 PWL/);
  for (const format of ['python','javascript','matlab']) {
    assert.match(session.output(format), /voltage_V/);
    assert.doesNotMatch(session.output(format), /current_A/);
    assert.match(session.output(format), /(?:np\.interp|evaluateWaveform|waveform_at)/);
  }
  assert.equal(session.result!.compiled.finalValue, -12);
});

test('continuous burst preview is local and readable; finite exports require an explicit horizon', () => {
  const session = new SemanticSession();
  assert.equal(session.apply(semanticSamples.burst), true);
  const detail = localDetail(session.result!.compiled);
  assert.equal(detail.ok, true);
  if(!detail.ok) return;
  assert.ok(Math.abs(detail.horizonS - 9.4e-6) < 1e-18);
  assert.equal(detail.points.filter(p => p[1] === 10).length, 20);
  assert.throws(() => session.output('csv'), /HORIZON_REQUIRED/);
  assert.match(session.output('csv', 2), /\n2,0\n$/);
  assert.match(session.output('yaml'), /count: continuous/);
  assert.ok(session.output('yaml').length < 1000);
});

test('legacy migration remains a preview until explicit apply and retains the untouched original', async () => {
  const text = await readFile(new URL('../../tests/fixtures/legacy/inputs/cases/percent.yaml', import.meta.url), 'utf8');
  const session = new SemanticSession();
  session.apply(semanticSamples.voltage);
  const previous = session.result;
  const preview = session.previewMigration(text);
  assert.equal(session.result, previous);
  assert.equal(preview.legacy.sourceText, text);
  assert.ok(preview.legacy.points.length > 1);
  assert.ok(preview.differences.length);
  assert.equal(preview.shapeEquivalent, true);
  assert.equal(session.applyMigration(), true);
  assert.equal(session.migration!.legacy.sourceText, text);
  assert.equal(session.result!.document.schema, 'wavecraft/1');
});

// This small DOM runs the actual inline application and its bound UI handlers.
class Element {
  id = ''; value = ''; textContent = ''; className = ''; disabled = false;
  style = {}; attrs: Record<string,string> = {}; children: Element[] = []; options: Element[] = [];
  parent: Element | undefined; onclick: any; oninput: any; onchange: any; onkeydown: any;
  clientWidth = 700; clientHeight = 360; width = 920; height = 430; files: any[] = [];
  selectionStart=0;selectionEnd=0;
  constructor(tag = 'div', svg = false) {
    this.attrs.tag = tag;
    if (!svg) Object.defineProperty(this, 'hidden', {
      get: () => this.hasAttribute('hidden'),
      set: (value:boolean) => this.toggleAttribute('hidden', value)
    });
  }
  hasAttribute(key:string) { return Object.hasOwn(this.attrs,key); }
  removeAttribute(key:string) { delete this.attrs[key]; }
  toggleAttribute(key:string, force?:boolean) { const set=force??!this.hasAttribute(key);if(set)this.setAttribute(key,'');else this.removeAttribute(key);return set; }
  setAttribute(key:string,value:any) { this.attrs[key]=String(value); }
  getAttribute(key:string) { return this.attrs[key]; }
  appendChild(el:Element) { el.parent=this;this.children.push(el);return el; }
  replaceChildren(...els:Element[]) {this.children=els;els.forEach(el=>el.parent=this);}
  querySelectorAll() {return this.children.filter(el=>!['title','desc'].includes(el.attrs.tag));}
  remove() {if(this.parent)this.parent.children=this.parent.children.filter(el=>el!==this);}
  addEventListener() {} focus() {} click() {this.onclick?.({target:this});}
  setSelectionRange(start:number,end:number) {this.selectionStart=start;this.selectionEnd=end;}
  getContext() {return new Proxy({}, {get:()=>()=>{}});}
}
async function editor() {
  const html = await readFile(new URL('../../prototypes/wavecraft-web-prototype.html',import.meta.url),'utf8');
  const elements = new Map<string,Element>();
  for(const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const el=new Element(match[1],['svg','title','desc'].includes(match[1]));el.id=match[3];if(/\bhidden\b/.test(match[2]))el.setAttribute('hidden','');
    el.value=match[2].match(/\bvalue="([^"]*)"/)?.[1] || '';elements.set(el.id,el);
  }
  for(const id of ['format','source-mode','semantic-sample','repeat-mode']) {
    const el=elements.get(id)!;
    const body=html.match(new RegExp(`<select id="${id}">([\\s\\S]*?)<\\/select>`))![1];
    el.options=[...body.matchAll(/<option value="([^"]+)">([^<]*)/g)].map(m=>{const option=new Element();option.value=m[1];option.textContent=m[2];return option;});el.value=el.options[0].value;
  }
  const sourceLabel=new Element();
  const context=vm.createContext({console,TextEncoder,TextDecoder,Blob,setTimeout,URL,structuredClone,window:{},ResizeObserver:class{observe(){}},requestAnimationFrame:(fn:any)=>fn(),
    document:{getElementById:(id:string)=>elements.get(id),createElement:(tag:string)=>new Element(tag),createElementNS:(_:string,tag:string)=>new Element(tag,true),
      querySelector:()=>sourceLabel,querySelectorAll:(selector:string)=>selector==='[role=tab]'?[elements.get('edit-tab'),elements.get('trace-tab')]:[]}});
  for(const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) vm.runInContext(script[1],context);
  return {elements,context,html,get:(id:string)=>elements.get(id)!};
}

test('inline editor exposes studio actions and keeps initial JSON; semantic UI blocks point mutations and invalid draft export', async () => {
  const page=await editor(), {get,context}=page;
  const initial=JSON.parse(get('source').value);
  assert.equal(initial.name,'Load pulse');assert.equal(initial.points.length,9);
  for (const action of ['studio-project', 'studio-load', 'studio-export']) {
    assert.ok(page.html.includes(`id="${action}"`));
  }
  const trace=page.html.split('<section id="trace-panel"')[1].split('<footer')[0];
  for(const id of ['image-canvas','image-file','sample-image','cal-x0','cal-x1','cal-y0','cal-y1','anchor-low','anchor-high','trace-points','undo-trace','use-trace'])assert.ok(trace.includes(`id="${id}"`));
  assert.ok(trace.includes('id="digitize-stage-csv"'));
  assert.ok(trace.includes('id="landmark-tick"'));
  assert.equal((trace.match(/<section class="panel stack">/g)||[]).length,2);
  get('source-mode').value='semantic';get('source-mode').onchange({});
  assert.match(get('semantic-timing').textContent,/duration 70 µs/);
  assert.equal(get('download').disabled,false);
  const previous=(context as any).WaveSemanticEditor.session.result;
  for(const id of ['add','remove','apply-repeat','use-trace']) {assert.equal(get(id).disabled,true);get(id).onclick?.({});}
  assert.equal((context as any).WaveSemanticEditor.session.result,previous);
  get('source').value=semanticSamples.current.replace('6 A/us','0 A/us');get('source').oninput({});
  assert.equal(get('download').disabled,true);
  assert.match(get('readout').textContent,/last valid applied source/);
  get('apply-text').onclick({});
  assert.match(get('text-message').textContent,/rise.*offsets/);
  assert.equal((context as any).WaveSemanticEditor.session.result,previous);
  get('source-mode').value='points';get('source-mode').onchange({});assert.equal(get('source-mode').value,'semantic');
  get('discard-text').onclick({});get('source-mode').value='points';get('source-mode').onchange({});
  assert.equal(JSON.parse(get('source').value).points.length,9);
  assert.equal(get('download').disabled,false);
});

function editValue(get:(id:string)=>Element, operation:string, value:string, control?:string) {
  get('semantic-operation').value=operation;get('semantic-operation').onchange({});
  if(control){get('semantic-control').value=control;get('semantic-control').onchange({});}
  get('semantic-value').value=value;get('semantic-value').oninput({});get('semantic-propose').onclick({});
}

test('semantic inspector previews dependent timing, commits percentage intent, and shares text undo history',async()=>{
  const {get,context}=await editor();
  get('source-mode').value='semantic';get('source-mode').onchange({});
  const session=(context as any).WaveSemanticEditor.session, before=get('source').value;
  assert.equal(get('point-inspector').hidden,true);assert.equal(get('semantic-inspector').hidden,false);
  assert.equal(get('semantic-selection').value,'rise');assert.equal(get('semantic-value').value,'175%');
  editValue(get,'target','200%');
  assert.equal(get('source').value,before);assert.equal(session.result.compiled.nodes[0].timing.durationS,70e-6);
  assert.match(get('semantic-proposal').textContent,/rise[\s\S]*70[\s\S]*80/);
  assert.match(get('semantic-proposal').textContent,/plateau/);
  assert.equal(get('semantic-apply-edit').disabled,false);
  get('semantic-apply-edit').onclick({});
  assert.match(get('source').value,/to: 200%/);assert.equal(session.result.compiled.nodes[0].timing.durationS,80e-6);
  assert.match(get('export-preview').textContent,/0.00008,480/);
  const graphical=get('source').value;
  get('source').value=graphical.replace('duration: 2 ms','duration: 3 ms');get('source').oninput({});get('apply-text').onclick({});
  get('undo').onclick({});assert.equal(get('source').value,graphical);
  get('undo').onclick({});assert.equal(get('source').value,before);
  get('redo').onclick({});assert.equal(get('source').value,graphical);
});

test('compiled ramp end selects its owner by keyboard and preserves invalid draft through selection and recovery',async()=>{
  const {get,context}=await editor();
  get('source-mode').value='semantic';get('source-mode').onchange({});
  const session=(context as any).WaveSemanticEditor.session, valid=session.result;
  const draft=get('source').value.replace('6 A/us','0 A/us');
  get('source').value=draft;get('source').oninput({});get('apply-text').onclick({});
  get('semantic-selection').value='plateau';get('semantic-selection').onchange({});
  const ramp=get('plot').children.filter(el=>el.attrs['data-owner']==='rise'&&el.attrs.tag==='circle');
  assert.equal(ramp.length,2,'The shared hold start must not replace the ramp end marker.');
  ramp[1].onkeydown({key:'Enter',preventDefault(){}});
  assert.equal(get('semantic-selection').value,'rise');assert.equal(get('source').value,draft);
  assert.equal(session.result,valid);assert.equal(get('semantic-propose').disabled,true);
  assert.equal(get('undo').disabled,true);assert.equal(get('download').disabled,true);
  const recovery=session.exportRecovery();
  assert.equal(recovery.draft,draft);assert.equal(recovery.selectionId,'rise');
  assert.equal(session.restoreRecovery(recovery).ok,true);assert.equal(session.source,draft);
  get('discard-text').onclick({});assert.equal(get('source').value,semanticSamples.current);
});

test('semantic inspector changes nominal references and converts only through explicit preview and apply',async()=>{
  const {get,context}=await editor();
  get('source-mode').value='semantic';get('source-mode').onchange({});
  const session=(context as any).WaveSemanticEditor.session;
  editValue(get,'nominal','120 A');get('semantic-apply-edit').onclick({});
  assert.equal(session.result.document.segments[0].to,'175%');
  assert.equal(session.result.compiled.nodes[0].points.at(-1)[1],210);
  const structured=get('source').value;
  get('semantic-convert').onclick({});assert.equal(get('source').value,structured);
  assert.match(get('semantic-proposal').textContent,/Convert removes structured intent/);
  get('semantic-apply-edit').onclick({});assert.equal(session.result.document.segments[0].kind,'points');
  assert.equal(get('semantic-operation').value,'nominal');
  get('undo').onclick({});assert.equal(get('source').value,structured);
  get('semantic-selection').value='plateau';get('semantic-selection').onchange({});
  editValue(get,'hold-duration','3 ms');get('semantic-apply-edit').onclick({});
  assert.equal(session.result.document.segments[1].duration,'3 ms');
});

test('semantic repeat inspector rejects a short period and retains burst geometry until an accepted edit',async()=>{
  const {get,context}=await editor();
  get('semantic-sample').value='burst';get('semantic-load-sample').onclick({});
  const session=(context as any).WaveSemanticEditor.session,before=get('source').value;
  editValue(get,'inner-clock','10 ns','period');
  assert.equal(get('semantic-apply-edit').disabled,true);assert.equal(get('source').value,before);
  assert.match(get('semantic-proposal').textContent,/PERIOD|period/);
  editValue(get,'outer-clock','0.1 s','period');get('semantic-apply-edit').onclick({});
  assert.match(get('source').value,/period: 0.1 s/);
  assert.equal(session.result.compiled.nodes[0].outer.periodS,.1);
  assert.equal(get('burst-overview').hasAttribute('hidden'),false);
  assert.equal(risingPoints(curvePoints(get('burst-overview'))).length,20);
});

test('continuous repeat proposals show resolved clocks, counts, and active span before source or export changes',async()=>{
  const {get,context}=await editor();
  get('semantic-sample').value='burst';get('semantic-load-sample').onclick({});
  get('semantic-horizon').value='2';get('semantic-horizon').oninput({});
  const session=(context as any).WaveSemanticEditor.session;
  const source=get('source').value,exportBefore=get('export-preview').textContent,resultBefore=session.result;
  editValue(get,'outer-clock','0.1 s','period');
  const preview=get('semantic-proposal').textContent;
  assert.match(preview,/Pattern period: 0\.000001 → 0\.000001 s/);
  assert.match(preview,/Pattern frequency: 1000000 → 1000000 Hz/);
  assert.match(preview,/Pattern count: 10 → 10/);
  assert.match(preview,/Active span: 9\.4 → 9\.4 µs/);
  assert.match(preview,/Outer period: 1 → 0\.1 s/);
  assert.match(preview,/Outer frequency: 1 → 10 Hz/);
  assert.match(preview,/Outer count: continuous → continuous/);
  assert.equal(get('source').value,source);assert.equal(session.output('yaml'),source);
  assert.equal(session.result,resultBefore);assert.equal(get('export-preview').textContent,exportBefore);
  get('semantic-apply-edit').onclick({});
  assert.equal(session.result.compiled.nodes[0].outer.periodS,.1);
  const applied=get('source').value,exportApplied=get('export-preview').textContent;
  editValue(get,'inner-count','20');
  assert.match(get('semantic-proposal').textContent,/Pattern count: 10 → 20/);
  assert.match(get('semantic-proposal').textContent,/Active span: 9\.4 → 19\.4 µs/);
  assert.match(get('semantic-proposal').textContent,/Outer period: 0\.1 → 0\.1 s/);
  assert.equal(get('source').value,applied);assert.equal(session.output('yaml'),applied);
  assert.equal(get('export-preview').textContent,exportApplied);
  get('semantic-cancel-edit').onclick({});
  editValue(get,'outer-count','2');
  assert.match(get('semantic-proposal').textContent,/Outer count: continuous → 2/);
  assert.equal(session.result.compiled.nodes[0].outer.count,'continuous');
  assert.equal(get('source').value,applied);assert.equal(get('export-preview').textContent,exportApplied);
});

test('semantic numeric controls edit the owning ramp and explicit source points without detached geometry',async()=>{
  const {get,context}=await editor();
  get('source-mode').value='semantic';get('source-mode').onchange({});
  const session=(context as any).WaveSemanticEditor.session;
  assert.equal(get('undo').disabled,true,'The first valid source establishes the baseline.');
  editValue(get,'ramp-control','100 us','duration');get('semantic-apply-edit').onclick({});
  assert.equal(session.result.document.segments[0].duration,'100 us');assert.equal(session.result.document.segments[0].slew,undefined);
  editValue(get,'timing','200 us');get('semantic-apply-edit').onclick({});
  assert.equal(session.result.document.segments[0].arriveAt,'200 us');
  assert.equal(session.result.compiled.nodes[0].kind,'idle');
  const source=`schema: wavecraft/1\nname: Explicit source points\nsignal: {dimension: current, initial: 0 A}\nsegments:\n  - id: drawn\n    kind: points\n    points:\n      - {id: p0, time: 0 us, value: 0 A}\n      - {id: p1, time: 10 us, value: 5 A}\n      - {id: p2, time: 20 us, value: 0 A}\n`;
  get('source').value=source;get('source').oninput({});get('apply-text').onclick({});
  get('semantic-operation').value='nominal';get('semantic-operation').onchange({});
  const marker=get('plot').children.find(el=>el.attrs['data-source-point']==='p1')!;
  assert.ok(marker);marker.click();assert.equal(get('semantic-operation').value,'point');
  assert.equal(get('semantic-point').value,'p1');assert.equal(get('semantic-value').value,'10 us');assert.equal(get('semantic-second').value,'5 A');
  get('semantic-value').value='12 us';get('semantic-second').value='7 A';get('semantic-propose').onclick({});
  assert.equal(get('source').value,source);get('semantic-apply-edit').onclick({});
  assert.equal(session.result.document.segments[0].points[1].time,'12 us');
  assert.equal(session.result.document.segments[0].points[1].value,'7 A');
  assert.equal(session.result.document.segments[0].points.length,3);
  get('source').value=source.replace('time: 0 us','time: 2 us');get('source').oninput({});get('apply-text').onclick({});
  const implicit=get('plot').children.find(el=>el.attrs.tag==='circle'&&!el.attrs['data-source-point'])!;
  assert.ok(implicit);assert.match(implicit.attrs['aria-label'],/Compiled corner/);implicit.click();
  assert.equal(get('semantic-point').value,'p1');assert.equal(get('semantic-value').value,'10 us');
  assert.equal(get('plot').attrs.role,'group','Interactive corners remain visible to accessibility tools.');
});

test('inline editor voltage axis and continuous horizon state use the selected semantic document', async () => {
  const {get}=await editor();
  get('semantic-sample').value='voltage';get('semantic-load-sample').onclick({});
  assert.ok(get('plot').children.some(el=>el.textContent==='Voltage (V)'));
  assert.match(get('export-preview').textContent,/time_s,voltage_V/);
  get('semantic-sample').value='burst';get('semantic-load-sample').onclick({});
  assert.equal(get('download').disabled,true);assert.match(get('export-preview').textContent,/HORIZON_REQUIRED/);
  assert.match(get('readout').textContent,/9.4 µs/);
  assert.equal(get('burst-overview').hasAttribute('hidden'),false);
  get('semantic-horizon').value='2';get('semantic-horizon').oninput({});
  assert.equal(get('download').disabled,false);assert.match(get('export-state').textContent,/horizon 2 s/);
  assert.match(get('export-preview').textContent,/\n2,0\n$/);
});

test('inline YAML import shows legacy evidence before an explicit migration command', async () => {
  const {get,context}=await editor();
  get('semantic-sample').value='voltage';get('semantic-load-sample').onclick({});
  const originalSource=get('source').value;
  const legacy=await readFile(new URL('../../tests/fixtures/legacy/inputs/cases/percent.yaml',import.meta.url),'utf8');
  await get('open-file').onchange({target:{files:[new File([legacy],'percent.yaml')],value:'percent.yaml'}});
  assert.equal(get('source').value,originalSource);
  assert.equal(get('legacy-preview').hidden,false);
  assert.equal(get('legacy-original').textContent,legacy);
  assert.match(get('legacy-differences').textContent,/Shape equivalent: true/);
  assert.match(get('legacy-differences').textContent,/Legacy points:/);
  assert.equal(get('apply-migration').disabled,false);
  get('apply-migration').onclick({});
  assert.match(get('source').value,/schema: wavecraft\/1/);
  assert.equal((context as any).WaveSemanticEditor.session.result.document.signal.dimension,'current');
  assert.equal(get('legacy-original').textContent,legacy);
});

test('YAML file import and untouched source export preserve UTF-8 BOM and CRLF bytes',async()=>{
  const {get,context}=await editor();
  const original='\uFEFF# Original bytes\r\n'+semanticSamples.current.replace(/\n/g,'\r\n');
  const file=new File([original],'original.yaml',{type:'application/yaml'});
  assert.notEqual(await file.text(),original,'File.text strips a BOM. The YAML importer must decode raw bytes.');
  await get('open-file').onchange({target:{files:[file],value:'original.yaml'}});
  assert.equal(get('source').value,original);
  const session=(context as any).WaveSemanticEditor.session;
  assert.equal(session.output('yaml'),original);
  assert.deepEqual(Buffer.from(session.output('yaml')),Buffer.from(await file.arrayBuffer()));
  const revision=session.revision;
  get('source').value=original.replace(/\r\n/g,'\n');
  get('apply-text').onclick({});
  assert.equal(session.revision,revision,'Apply without an input event is a no-op after textarea line-ending normalization.');
  assert.equal(session.output('yaml'),original);
});

test('finite repeat previews disclose clipping and resource failures clear the previous geometry', async () => {
  const {get}=await editor();
  get('source-mode').value='semantic';get('source-mode').onchange({});
  const finite=semanticSamples.burst.replace('outer: {period: 1 s, count: continuous}', 'outer: {period: 1 s, count: 2}');
  get('source').value=finite;get('source').oninput({});get('apply-text').onclick({});
  assert.match(get('readout').textContent,/finite source · clipped preview/);
  const dense={schema:'wavecraft/1',name:'Dense compiled waveform',signal:{dimension:'current',initial:'0 A'},segments:[{
    id:'dense-repeat',kind:'repeat',count:10,period:'1 us',pattern:[{id:'dense-points',kind:'points',points:Array.from({length:3500},(_,i)=>({id:`point-${i}`,time:`${(i+1)/3500*.8} us`,value:`${i===3499?0:i%2} A`}))}]
  }]};
  get('source').value=JSON.stringify(dense);get('source').oninput({});get('apply-text').onclick({});
  assert.equal(get('wave-title').textContent,'Dense compiled waveform');
  assert.match(get('readout').textContent,/Preview unavailable/);
  assert.match(get('plot-message').textContent,/RESOURCE_LIMIT/);
  assert.equal(get('plot').children.some(el=>el.attrs.class==='curve'),false);
});

function curvePoints(target:Element) {
  const curve=target.children.find(el=>el.attrs.class==='curve');
  assert.ok(curve,'The burst overview must draw the waveform.');
  if(target.id==='burst-overview') {
    assert.equal(curve.attrs.fill,'none');
    assert.equal(curve.attrs.stroke,'var(--accent)');
    assert.equal(curve.attrs['stroke-width'],'2.5');
  }
  return [...curve.attrs.d.matchAll(/[ML]\s*([\d.e+-]+)\s+([\d.e+-]+)/gi)].map(m=>[Number(m[1]),Number(m[2])]);
}
function risingPoints(points:number[][]) { return points.filter((p,i)=>i>0&&p[1]<points[i-1][1]); }

test('point burst overview shows ten patterns, the idle gap, and the second burst at 0.1 s',async()=>{
  const {get}=await editor();
  const project={version:1,name:'Load pulse',units:{time:'us',current:'A'},maxSlew:100,
    points:[[0,25],[15.5,25],[18,180],[19,150],[57,150],[58,100],[77,100],[78,25],[128,25]],
    repetition:{mode:'burst',periodUs:150,count:10,burstPeriodUs:100000}};
  get('source').value=JSON.stringify(project);get('source').oninput({});get('apply-text').onclick({});
  const overview=get('burst-overview');
  assert.equal(overview.hasAttribute('hidden'),false,'SVG visibility uses its actual attribute.');
  assert.equal(risingPoints(curvePoints(get('repeat-plot'))).length,10);
  const points=curvePoints(overview),rises=risingPoints(points);
  assert.equal(rises.length,20);
  assert.ok(Math.abs((rises[0][0]-50)/630*.2-.000018)<1e-12);
  assert.ok(Math.abs((rises[10][0]-50)/630*.2-.100018)<1e-12);
  assert.ok(points.some((p,i)=>i>0&&p[1]===points[i-1][1]&&p[0]-points[i-1][0]>300),'The baseline gap uses the actual time scale.');
  assert.deepEqual(overview.children.filter(el=>el.attrs.tag==='text').map(el=>el.textContent),['0 s','0.1 s','0.2 s']);
  assert.deepEqual(JSON.parse(get('source').value),project);
  get('repeat-mode').value='periodic';get('apply-repeat').onclick({});assert.equal(overview.hasAttribute('hidden'),true);
  get('repeat-mode').value='single';get('apply-repeat').onclick({});assert.equal(overview.hasAttribute('hidden'),true);
});

test('semantic mode hides the separate point repetition state and returning restores the exact point burst',async()=>{
  const {get}=await editor();
  const project=JSON.parse(await readFile(new URL('../../outputs/burst-fix/user-reported-project.json',import.meta.url),'utf8'));
  get('source').value=JSON.stringify(project);get('source').oninput({});get('apply-text').onclick({});
  assert.equal(get('repeat-mode').value,'burst');
  assert.equal(get('repeat-period').value,'150');assert.equal(get('repeat-count').value,10);assert.equal(get('burst-period').value,'100000');
  get('source-mode').value='semantic';get('source-mode').onchange({});
  assert.equal(get('point-repeat-controls').hidden,true);
  assert.match(get('source').value,/name: Load pulse · 175%/);
  assert.doesNotMatch(get('source').value,/kind: repeat/);
  assert.equal(get('repeat-preview').hidden,true);assert.equal(get('burst-overview').hasAttribute('hidden'),true);
  get('source-mode').value='points';get('source-mode').onchange({});
  assert.equal(get('point-repeat-controls').hidden,false);
  assert.equal(get('repeat-mode').value,'burst');assert.equal(get('repeat-period').value,'150');
  assert.equal(get('repeat-count').value,10);assert.equal(get('burst-period').value,'100000');
  assert.deepEqual(JSON.parse(get('source').value),project);
  assert.equal(get('burst-overview').hasAttribute('hidden'),false);
  assert.equal(risingPoints(curvePoints(get('burst-overview'))).length,20);
});

test('semantic burst overview uses SVG visibility, actual outer timing, and finite burst counts',async()=>{
  const {get}=await editor();
  get('source-mode').value='semantic';get('source-mode').onchange({});
  const continuous=semanticSamples.burst.replace('period: 1 s','period: 0.1 s');
  get('source').value=continuous;get('source').oninput({});get('apply-text').onclick({});
  const overview=get('burst-overview'),rises=risingPoints(curvePoints(overview));
  assert.equal(overview.hasAttribute('hidden'),false);
  assert.equal(rises.length,20);
  assert.ok(Math.abs(rises[10][0]-rises[0][0]-315)<1e-8);
  assert.deepEqual(overview.children.filter(el=>el.attrs.tag==='text').map(el=>el.textContent),['0 s','0.1 s','0.2 s']);
  get('source').value=continuous.replace('count: continuous','count: 1');get('source').oninput({});get('apply-text').onclick({});
  assert.equal(risingPoints(curvePoints(overview)).length,10);
  assert.deepEqual(overview.children.filter(el=>el.attrs.tag==='text').map(el=>el.textContent),['0 s','0.1 s']);
  assert.equal(get('source').value,continuous.replace('count: continuous','count: 1'));
  get('semantic-sample').value='voltage';get('semantic-load-sample').onclick({});assert.equal(overview.hasAttribute('hidden'),true);
});


function createViaGui(get:(id:string)=>Element, dimension='current') {
  get('semantic-new-dimension').value=dimension;get('semantic-new-dimension').onchange({});
  get('semantic-new').onclick({});
}
function insertViaGui(get:(id:string)=>Element, id:string, kind:string, target:string, duration:string, arrival='') {
  get('semantic-add-kind').value=kind;get('semantic-add-kind').onchange({});
  get('semantic-add-id').value=id;get('semantic-add-target').value=target;get('semantic-add-duration').value=duration;get('semantic-add-arrival').value=arrival;
  get('semantic-add-segment').onclick({});assert.equal(get('semantic-apply-edit').disabled,false,get('semantic-proposal').textContent);get('semantic-apply-edit').onclick({});
}
test('GUI creates an authored pulse, wraps periodic timing, and explicitly corrects an absolute conflict without YAML input',async()=>{
  const {get,context}=await editor();createViaGui(get);
  const session=(context as any).WaveSemanticEditor.session;
  assert.equal(session.result.document.segments.length,0);
  insertViaGui(get,'rise','ramp','175%','6 A/us','70 us');
  insertViaGui(get,'plateau','hold','','2 ms');
  insertViaGui(get,'return','ramp','0 A','6 A/us');
  assert.equal(session.result.compiled.nodes[0].timing.durationS,70e-6);
  assert.equal(session.result.compiled.nodes[1].timing.durationS,.002);
  get('semantic-wrap-clock').value='3 ms';get('semantic-wrap').onclick({});assert.equal(get('semantic-apply-edit').disabled,false,get('semantic-proposal').textContent);get('semantic-apply-edit').onclick({});
  assert.equal(session.result.compiled.nodes[0].periodS,.003);
  assert.match(get('semantic-resolved').textContent,/period 0.003 s; frequency 333/);
  get('semantic-selection').value='rise';get('semantic-selection').onchange({});
  const before=get('source').value;editValue(get,'target','200%');
  assert.match(get('semantic-proposal').textContent,/ANCHOR_CONFLICT/);assert.equal(get('source').value,before);
  assert.equal(get('semantic-corrections').children.length,2);
  get('semantic-corrections').children[0].click();assert.equal(get('source').value,before);get('semantic-apply-edit').onclick({});
  const ramp=session.result.compiled.nodes[0].pattern.find((n:any)=>n.id==='rise');
  assert.equal(ramp.timing.durationS,80e-6);assert.equal(ramp.points.at(-1)[1],480);
  assert.match(get('source').value,/to: 200%/);assert.doesNotMatch(get('source').value,/arriveAt/);
  assert.equal(session.result.compiled.nodes[0].pattern.find((n:any)=>n.id==='plateau').timing.durationS,.002);
  get('undo').onclick({});assert.equal(get('source').value,before);get('redo').onclick({});assert.equal(session.result.compiled.nodes[0].pattern.find((n:any)=>n.id==='rise').timing.durationS,80e-6);
  assert.equal(get('source-panel').hidden,true);get('semantic-yaml-toggle').onclick({});assert.equal(get('source-panel').hidden,false);get('semantic-yaml-toggle').onclick({});assert.equal(get('source-panel').hidden,true);
});
test('GUI creates signed voltage, explicit points, keyboard table selection, insertion and removal without YAML input',async()=>{
  const {get,context}=await editor();createViaGui(get,'voltage');
  const session=(context as any).WaveSemanticEditor.session;
  insertViaGui(get,'rise','ramp','6 V','30 us');
  assert.equal(session.result.compiled.initialValue,-12);assert.equal(session.result.compiled.finalValue,6);
  assert.equal(session.result.document.segments[0].duration,'30 us');
  insertViaGui(get,'top','hold','','40 us');
  insertViaGui(get,'points','points','-12 V','30 us');
  const row=get('semantic-table-body').children.find(el=>el.attrs['data-segment']==='points')!;
  row.onkeydown({key:'Enter',preventDefault(){}});assert.equal(session.selectionId,'points');
  get('semantic-value').value='20 us';get('semantic-second').value='-10 V';get('semantic-insert-point').onclick({});get('semantic-apply-edit').onclick({});
  assert.equal(session.result.document.segments[2].points.length,2);
  assert.deepEqual(Array.from(session.result.document.segments[2].points,(p:any)=>p.time),['20 us','30 us']);
  get('semantic-point').value=session.result.document.segments[2].points[1].id;get('semantic-point').onchange({});
  get('semantic-remove-point').onclick({});get('semantic-apply-edit').onclick({});assert.equal(session.result.document.segments[2].points.length,1);
  get('semantic-remove-segment').onclick({});get('semantic-apply-edit').onclick({});assert.equal(session.result.document.segments.length,2);
  get('undo').onclick({});assert.equal(session.result.document.segments.length,3);
});
test('GUI rejects repeat fit and commits only the explicit period correction; burst counts stay independent',async()=>{
  const {get,context}=await editor();createViaGui(get);
  const session=(context as any).WaveSemanticEditor.session;
  insertViaGui(get,'rise','ramp','175%','6 A/us');insertViaGui(get,'top','hold','','2 ms');insertViaGui(get,'return','ramp','0 A','6 A/us');
  get('semantic-wrap-mode').value='burst';get('semantic-wrap-count').value='10';get('semantic-wrap-clock').value='1 ms';get('semantic-wrap-outer-clock').value='1 s';get('semantic-wrap-outer-count').value='2';
  const before=get('source').value;get('semantic-wrap').onclick({});assert.match(get('semantic-proposal').textContent,/REPEAT_FIT/);assert.equal(get('source').value,before);
  get('semantic-corrections').children[0].click();assert.equal(get('source').value,before);get('semantic-apply-edit').onclick({});
  const repeat=session.result.compiled.nodes[0];assert.equal(repeat.count,10);assert.equal(repeat.outer.count,2);assert.equal(repeat.outer.periodS,1);assert.ok(Math.abs(repeat.periodS-.00214)<1e-15);
  assert.equal(get('burst-overview').hasAttribute('hidden'),false);
});

test('GUI preserves a custom segment ID, invalidates changed inputs, and links both clock quantities',async()=>{
  const {get}=await editor();createViaGui(get);
  get('semantic-add-id').value='custom-plateau';get('semantic-add-kind').value='hold';get('semantic-add-kind').onchange({});assert.equal(get('semantic-add-id').value,'custom-plateau');
  get('semantic-add-segment').onclick({});assert.equal(get('semantic-apply-edit').disabled,false);
  get('semantic-add-duration').value='3 ms';get('semantic-add-duration').oninput({});assert.equal(get('semantic-apply-edit').disabled,true);
  get('semantic-wrap-clock').value='3 ms';get('semantic-wrap-control').value='frequency';get('semantic-wrap-control').onchange({});assert.match(get('semantic-wrap-clock').value,/333\.333333333333 Hz/);
  get('semantic-wrap-control').value='period';get('semantic-wrap-control').onchange({});assert.equal(get('semantic-wrap-clock').value,'0.003 s');
  get('semantic-wrap-outer-clock').value='1 s';get('semantic-wrap-outer-control').value='frequency';get('semantic-wrap-outer-control').onchange({});assert.equal(get('semantic-wrap-outer-clock').value,'1 Hz');
});
test('keyboard table selection covers every authored kind and highlights its current source range',async()=>{
  const {get,context}=await editor();createViaGui(get);
  const session=(context as any).WaveSemanticEditor.session;
  insertViaGui(get,'rise','ramp','175%','6 A/us');insertViaGui(get,'top','hold','','2 ms');insertViaGui(get,'return','ramp','0 A','6 A/us');
  get('semantic-wrap-count').value='2';get('semantic-wrap').onclick({});get('semantic-apply-edit').onclick({});
  insertViaGui(get,'points','points','0 A','1 ms');
  for(const id of ['repetition','rise','top','points']) {
    const row=get('semantic-table-body').children.find(el=>el.attrs['data-segment']===id)!;row.onkeydown({key:' ',preventDefault(){}});assert.equal(session.selectionId,id);
    assert.equal(get('source').selectionStart,session.sourceMap.get(id).range[0]);assert.equal(get('source').selectionEnd,session.sourceMap.get(id).range[1]);
  }
  get('semantic-operation').value='point';get('semantic-operation').onchange({});const id=get('semantic-point').value;get('semantic-point').onchange({});assert.equal(get('source').selectionStart,session.sourceMap.get(id).range[0]);
});

test('ramp time handle keyboard selects anchored arrival and relative control without changing source',async()=>{
  const {get,context}=await editor();get('source-mode').value='semantic';get('source-mode').onchange({});
  const session=(context as any).WaveSemanticEditor.session;
  const handle=()=>get('plot').children.find(el=>el.attrs['data-owner']==='rise'&&el.attrs['data-role']==='ramp-time')!;
  const selectOther=()=>{get('semantic-selection').value='plateau';get('semantic-selection').onchange({});};
  selectOther();let before=get('source').value;handle().onkeydown({key:'Enter',preventDefault(){}});
  assert.equal(session.selectionId,'rise');assert.equal(get('semantic-operation').value,'ramp-control');assert.equal(get('semantic-control').value,'slew');assert.equal(get('semantic-value').value,'6 A/us');assert.equal(get('source').value,before);
  selectOther();handle().click();assert.equal(get('semantic-operation').value,'ramp-control');assert.equal(get('semantic-control').value,'slew');assert.equal(get('source').value,before);
  editValue(get,'timing','100 us');get('semantic-apply-edit').onclick({});selectOther();before=get('source').value;
  handle().onkeydown({key:'Enter',preventDefault(){}});assert.equal(get('semantic-operation').value,'timing');assert.equal(get('semantic-value').value,'100 us');assert.equal(get('source').value,before);
  selectOther();handle().click();assert.equal(get('semantic-operation').value,'timing');assert.equal(get('semantic-value').value,'100 us');assert.equal(get('source').value,before);
  get('semantic-sample').value='voltage';get('semantic-load-sample').onclick({});before=get('source').value;
  handle().onkeydown({key:' ',preventDefault(){}});assert.equal(get('semantic-operation').value,'ramp-control');assert.equal(get('semantic-control').value,'duration');assert.equal(get('semantic-value').value,'30 us');assert.equal(get('source').value,before);
  handle().click();assert.equal(get('semantic-control').value,'duration');assert.equal(get('source').value,before);
});
