import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { packProject, unpackProject, readProjectRecovery } from '../src/project/index.ts';
import type { ProjectSnapshot } from '../src/project/index.ts';
import { samplePngBase64 } from '../src/proof.ts';
import { projectRecoveryDatabase } from './support/project-recovery-db.ts';
class Element {
  id = ''; value = ''; textContent = ''; className = ''; disabled = false;
  style = {}; attrs: Record<string,string> = {}; children: Element[] = []; options: Element[] = [];
  parent: Element | undefined; onclick: any; oninput: any; onchange: any; onkeydown: any;
  clientWidth = 700; clientHeight = 360; width = 920; height = 430; files: any[] = [];
  checked=false;selectionStart=0;selectionEnd=0;
  toBlob(callback:any) {callback(new Blob([Buffer.from(samplePngBase64,'base64')],{type:'image/png'}));}
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
  listeners: Record<string,any[]> = {}; captured = false;
  addEventListener(type:string,handler:any) { (this.listeners[type] ||= []).push(handler); }
  dispatch(type:string,event:any) { for(const handler of this.listeners[type] || []) handler({...event,target:event.target || this}); }
  setPointerCapture() {this.captured=true;} hasPointerCapture() {return this.captured;} releasePointerCapture() {this.captured=false;}
  getBoundingClientRect() {return {left:0,top:0,width:700,height:360};}
  focus() {} click() {this.onclick?.({target:this});}
  setSelectionRange(start:number,end:number) {this.selectionStart=start;this.selectionEnd=end;}
  getContext() {return new Proxy({}, {get:()=>()=>{}});}
}
async function editor(database=projectRecoveryDatabase(), options:{decodeError?:boolean,decodeWait?:Promise<any>,decodeSize?:[number,number]}={}) {
  const html = await readFile(new URL('../../prototypes/wavecraft-web-prototype.html',import.meta.url),'utf8');
  const elements = new Map<string,Element>();
  for(const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const el=new Element(match[1],['svg','title','desc'].includes(match[1]));el.id=match[3];if(/\bhidden\b/.test(match[2]))el.setAttribute('hidden','');
    el.value=match[2].match(/\bvalue="([^"]*)"/)?.[1] || '';elements.set(el.id,el);
  }
  for(const id of ['format','source-mode','semantic-sample','repeat-mode','spectrum-basis','spectrum-method','spectrum-rows']) {
    const el=elements.get(id)!;
    const body=html.match(new RegExp(`<select id="${id}">([\\s\\S]*?)<\\/select>`))![1];
    el.options=[...body.matchAll(/<option value="([^"]+)">([^<]*)/g)].map(m=>{const option=new Element();option.value=m[1];option.textContent=m[2];return option;});el.value=el.options[0].value;
  }
  const sourceLabel=new Element(), downloads:Blob[]=[], anchors:any[]=[], urls=new Map<string,Blob>(), observers:any[]=[];
  let sourceValue='';Object.defineProperty(elements.get('source'),'value',{get:()=>sourceValue,set:(value:string)=>{sourceValue=value.replace(/\r\n?/g,'\n');}});
  const downloadUrl={createObjectURL:(blob:Blob)=>{const url='blob:'+urls.size;urls.set(url,blob);return url;},revokeObjectURL:()=>{}};
  class TestImage {width=options.decodeSize?.[0]||640;height=options.decodeSize?.[1]||480;naturalWidth=this.width;naturalHeight=this.height;onload:any;onerror:any;set src(value:string){void Promise.resolve(options.decodeWait).then(()=>{if(options.decodeError)this.onerror?.();else this.onload?.();});}}
  const context=vm.createContext({console,TextEncoder,TextDecoder,Blob,Uint8Array,DOMException,clearTimeout,indexedDB:database.factory,Image:TestImage,setTimeout,URL:downloadUrl,structuredClone,window:{},ResizeObserver:class{constructor(callback:any){observers.push(callback);}observe(){}},requestAnimationFrame:(fn:any)=>fn(),
    document:{getElementById:(id:string)=>elements.get(id),createElement:(tag:string)=>{const el=new Element(tag);if(tag==='a'){anchors.push(el);el.click=()=>{downloads.push(urls.get((el as any).href)!);};}return el;},createElementNS:(_:string,tag:string)=>new Element(tag,true),
      querySelector:()=>sourceLabel,querySelectorAll:(selector:string)=>selector==='[role=tab]'?[elements.get('edit-tab'),elements.get('trace-tab')]:[]}});
  for(const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) vm.runInContext(script[1],context);
  await (context as any).WaveProjectControls.startup;
  return {database,elements,context,html,downloads,anchors,observers,get:(id:string)=>elements.get(id)!};
}

const snapshot=(source:string,mode:'points'|'semantic'='points',evidence:ProjectSnapshot['evidence']={}):ProjectSnapshot=>({revisionId:'fixture-1',mode,source,evidence});
const sourceDocument={version:1,name:'Imported point source',units:{time:'us',current:'A'},points:[[0,-3],[100,-3]],maxSlew:null,articleMetadata:{doi:'unknown preserved field'}};
const rawPoint='\uFEFF'+JSON.stringify(sourceDocument,null,2).replace(/\n/g,'\r\n')+'\r\n';
function localFile(name:string,bytes:Uint8Array,type='application/zip') {const blob=new Blob([bytes],{type});return {name,type,size:blob.size,arrayBuffer:()=>blob.arrayBuffer(),text:()=>blob.text()};}
async function openZip(page:any,project:ProjectSnapshot) {page.get('project-open').files=[localFile('project.zip',packProject(project))];await page.get('project-open').onchange({target:page.get('project-open')});}
async function saveZip(page:any) {const count=page.downloads.length;await page.get('project-save').onclick({});assert.equal(page.downloads.length,count+1,page.get('project-state').textContent);return unpackProject(new Uint8Array(await page.downloads.at(-1).arrayBuffer()));}

function field(page:any,id:string,value:string) {const el=page.get(id);el.value=value;(el.oninput||el.onchange)?.({target:el});}
function check(page:any,id:string,value=true) {const el=page.get(id);el.checked=value;el.onchange?.({target:el});}
async function stageCsv(page:any,text='time,level\n0,-2\n1,4\n2,-2',dimension='voltage') {
  field(page,'digitize-csv-text',text);field(page,'digitize-dimension',dimension);field(page,'digitize-time-unit','ms');field(page,'digitize-value-unit',dimension==='voltage'?'V':'A');
  check(page,'digitize-map-confirm');await page.get('digitize-stage-csv').onclick({});
}
function assumptions(page:any,text='Manual extraction estimates the curve between the recorded points.') {field(page,'digitize-assumptions',text);}
function clickPixel(page:any,x:number,y:number) {const canvas=page.get('image-canvas');canvas.onclick({clientX:x*700/canvas.width,clientY:y*360/canvas.height});}
async function sample(page:any) {page.get('image-canvas').toBlob=(cb:any)=>cb(new Blob([Buffer.from(samplePngBase64,'base64')],{type:'image/png'}));await page.get('sample-image').onclick({});}
function mark(page:any,id:string,x:number,y:number) {page.get(id).onclick({});clickPixel(page,x,y);}
function sampleTrace(page:any,tickValue='100') {
  mark(page,'anchor-low',80,365);mark(page,'anchor-high',850,35);field(page,'digitize-tick-value',tickValue);mark(page,'landmark-tick',465,365);
  clickPixel(page,80,323.75);clickPixel(page,465,68);clickPixel(page,850,323.75);
}

test('CSV paste requires explicit mapping and physical units, then accepts signed voltage as committed semantic YAML',async()=>{
  const page=await editor(),before=page.get('source').value;
  field(page,'digitize-csv-text','t,y\n0,-2\n1,4\n2,-2');await page.get('digitize-stage-csv').onclick({});assert.match(page.get('trace-message').textContent,/Confirm the CSV/);assert.equal(page.get('source').value,before);
  field(page,'digitize-dimension','voltage');check(page,'digitize-map-confirm');await page.get('digitize-stage-csv').onclick({});assert.match(page.get('trace-message').textContent,/unit/i);assert.equal(page.context.WaveDigitizeControls.record,undefined);
  await stageCsv(page);assert.equal(page.get('source').value,before);assert.equal(page.get('use-trace').disabled,true);assert.match(page.get('cal-status').textContent,/calibration is unavailable/);
  assumptions(page);field(page,'digitize-article','Article DOI: example');field(page,'digitize-page','6');field(page,'digitize-figure','2b');field(page,'digitize-series','blue curve');check(page,'digitize-overlay-review');assert.equal(page.get('use-trace').disabled,false);
  await page.get('use-trace').onclick({});assert.equal(page.context.WaveSemanticEditor.active,true);assert.match(page.get('source').value,/dimension: voltage/);assert.match(page.get('source').value,/-2 V/);assert.match(page.get('source').value,/0.001 s/);assert.match(page.get('project-notes').value,/Article DOI: example/);
  const saved=await saveZip(page);assert.equal(saved.mode,'semantic');assert.equal(saved.evidence.digitization!.extraction.kind,'csv');assert.equal(saved.evidence.digitization!.provenance!.figure,'2b');assert.equal(saved.evidence.image,undefined);
});

test('duplicate edges require an explicit point correction and numeric finite edge review, without changing raw CSV',async()=>{
  const page=await editor(),raw='time,level\n0,0\n1,0\n1,5\n2,5';await stageCsv(page,raw);assumptions(page,'The rising transition is an assumed finite edge.');check(page,'digitize-overlay-review');await page.get('use-trace').onclick({});assert.match(page.get('trace-message').textContent,/duplicate|backward/i);
  page.get('digitize-point').value='2';page.get('digitize-point').onchange({});field(page,'digitize-point-time','0.0011');field(page,'digitize-point-value','5');page.get('digitize-correct').onclick({});assert.match(page.get('trace-message').textContent,/reason/);
  field(page,'digitize-point-reason','Assume a 100 microsecond rising transition.');page.get('digitize-correct').onclick({});assert.match(page.get('digitize-overlay-notes').textContent,/finite edge duration 0.0001 s/);
  check(page,'digitize-overlay-review');assert.equal(page.get('use-trace').disabled,true);check(page,'digitize-finite-edges');check(page,'digitize-overlay-review');assert.equal(page.get('use-trace').disabled,false);await page.get('use-trace').onclick({});
  const saved=await saveZip(page),record=saved.evidence.digitization!;assert.equal(record.extraction.kind,'csv');if(record.extraction.kind==='csv')assert.equal(record.extraction.text,raw);assert.deepEqual(record.corrections,[{index:2,point:[0.0011,5],note:'Assume a 100 microsecond rising transition.'}]);assert.equal(record.finiteEdgesConfirmed,true);assert.match(saved.evidence.notes!,/finite edge duration 0.0001 s/);
});

test('positive first timestamps need an explicit initial hold review and show its numeric interval',async()=>{
  const page=await editor();await stageCsv(page,'t,v\n1,2\n2,5');assumptions(page);check(page,'digitize-overlay-review');assert.equal(page.get('use-trace').disabled,true);assert.match(page.get('digitize-overlay-notes').textContent,/Initial hold.*0.001 s/);
  check(page,'digitize-initial-hold');check(page,'digitize-overlay-review');assert.equal(page.get('use-trace').disabled,false);await page.get('use-trace').onclick({});assert.match(page.get('project-notes').value,/Confirmed initial hold: 0 to 0.001 s/);
});

test('native image calibration checks an independent tick and retains intrinsic pixels through CSS zoom',async()=>{
  const page=await editor();await sample(page);sampleTrace(page,'130');await page.get('digitize-stage-image').onclick({});assumptions(page);check(page,'digitize-overlay-review');assert.match(page.get('cal-status').textContent,/FAIL/);await page.get('use-trace').onclick({});assert.match(page.get('trace-message').textContent,/tick check fails/);
  page.get('digitize-new').onclick({});sampleTrace(page);field(page,'digitize-zoom','2');await page.get('digitize-stage-image').onclick({});assert.match(page.get('cal-status').textContent,/PASS/);assumptions(page);check(page,'digitize-overlay-review');await page.get('use-trace').onclick({});
  const saved=await saveZip(page),record=saved.evidence.digitization!;assert.equal(record.extraction.kind,'image');if(record.extraction.kind==='image'){assert.deepEqual(record.extraction.pixels,[[80,323.75],[465,68],[850,323.75]]);assert.deepEqual(record.extraction.size,[920,430]);assert.equal(record.extraction.calibration.tick.value,100);}
  assert.equal(record.view!.zoom,2);assert.deepEqual(saved.evidence.image!.bytes,new Uint8Array(Buffer.from(samplePngBase64,'base64')));
});

test('source drafts, repetition drafts, source changes and ABA edits cannot accept an old reconstruction preview',async()=>{
  const page=await editor();await stageCsv(page);assumptions(page);check(page,'digitize-overlay-review');
  const initial=page.get('source').value;field(page,'source','unfinished draft');await page.get('use-trace').onclick({});assert.equal(page.get('source').value,'unfinished draft');assert.match(page.get('trace-message').textContent,/Apply or restore/);
  page.get('discard-text').onclick({});assert.equal(page.get('source').value,initial);check(page,'digitize-overlay-review');await page.get('use-trace').onclick({});assert.match(page.get('trace-message').textContent,/stale/);assert.equal(page.get('source').value,initial);
  page.get('digitize-restage').onclick({});check(page,'digitize-overlay-review');page.get('add').onclick({});page.get('undo').onclick({});await page.get('use-trace').onclick({});assert.match(page.get('trace-message').textContent,/stale/);
  page.get('scenario-burst').onclick({});field(page,'repeat-count','11');page.get('digitize-restage').onclick({});assert.match(page.get('trace-message').textContent,/repetition drafts/);
});

test('project ZIP and browser recovery retain raw extraction, correction reasons, provenance and an unapplied YAML draft',async()=>{
  const db=projectRecoveryDatabase(),page=await editor(db);await stageCsv(page);assumptions(page);field(page,'digitize-article','Recorded source');check(page,'digitize-overlay-review');await page.get('use-trace').onclick({});
  const zip=await saveZip(page),source=page.get('source').value;field(page,'source',source+'\ninvalid: [');await page.get('recovery-save').onclick({});
  const recovery=await readProjectRecovery({factory:db.factory});assert.equal(recovery!.draft.text,page.get('source').value);assert.equal(recovery!.snapshot.source,source);assert.deepEqual(recovery!.snapshot.evidence.digitization,zip.evidence.digitization);
  const reopened=await editor(db);await reopened.get('recovery-restore').onclick({});assert.equal(reopened.get('source').value,page.get('source').value);assert.equal(reopened.context.WaveSemanticEditor.session.dirty,true);assert.equal(reopened.get('digitize-article').value,'Recorded source');assert.equal(reopened.get('digitize-csv-text').value,'time,level\n0,-2\n1,4\n2,-2');
  reopened.get('discard-text').onclick({});const saved=await saveZip(reopened);assert.deepEqual(saved.evidence.digitization,zip.evidence.digitization);
  const fresh=await editor();await openZip(fresh,saved);fresh.get('project-accept').onclick({});assert.deepEqual((await saveZip(fresh)).evidence.digitization,saved.evidence.digitization);
});

test('digitization preserves FFT, filter and target exports until acceptance and evidence survives later YAML edits',async()=>{
  const page=await editor();page.get('scenario-burst').onclick({});field(page,'semantic-horizon','0.00001');page.get('spectrum-analyze').onclick({});const source=page.get('source').value,output=page.get('export-preview').textContent,analysis=page.get('spectrum-summary').textContent;
  await stageCsv(page);assumptions(page);assert.equal(page.get('source').value,source);assert.equal(page.get('export-preview').textContent,output);assert.equal(page.get('spectrum-summary').textContent,analysis);
  check(page,'digitize-overlay-review');await page.get('use-trace').onclick({});const evidence=(await saveZip(page)).evidence.digitization;
  field(page,'source',page.get('source').value.replace('Reconstructed waveform','Edited reconstruction'));page.get('apply-text').onclick({});assert.deepEqual((await saveZip(page)).evidence.digitization,evidence);assert.match(page.get('export-preview').textContent,/-2/);
});

test('CSV file reads reject stale completion and external CSV can attach a source image without losing its mapping',async()=>{
  const page=await editor();let release:any;const reading=new Promise<ArrayBuffer>(resolve=>release=resolve);page.get('digitize-csv-file').files=[{name:'slow.csv',size:20,arrayBuffer:()=>reading}];const pending=page.get('digitize-csv-file').onchange({target:page.get('digitize-csv-file')});field(page,'digitize-csv-text','newer paste');release(new TextEncoder().encode('old,data\n0,1').buffer);await pending;assert.equal(page.get('digitize-csv-text').value,'newer paste');
  await stageCsv(page);const raw=page.context.WaveDigitizeControls.record.extraction;await sample(page);assert.deepEqual(page.context.WaveDigitizeControls.record.extraction,raw);assumptions(page);page.get('digitize-restage').onclick({});check(page,'digitize-overlay-review');await page.get('use-trace').onclick({});const saved=await saveZip(page);assert.ok(saved.evidence.image);assert.equal(saved.evidence.digitization!.extraction.kind,'csv');assert.match(page.get('cal-status').textContent,/calibration is unavailable/);
});

test('CSV file intake retains exact BOM and CRLF text while the visible textarea normalizes newlines',async()=>{
  const page=await editor(),textarea=page.get('digitize-csv-text');let visible='';Object.defineProperty(textarea,'value',{get:()=>visible,set:(value:string)=>visible=value.replace(/\r\n?/g,'\n')});
  const original='\uFEFFtime;level\r\n0,0;-2,0\r\n1,0;4,0\r\n2,0;-2,0\r\n';page.get('digitize-csv-file').files=[localFile('original.csv',new TextEncoder().encode(original),'text/csv')];await page.get('digitize-csv-file').onchange({target:page.get('digitize-csv-file')});assert.notEqual(textarea.value,original);
  field(page,'digitize-dimension','voltage');field(page,'digitize-value-unit','V');field(page,'digitize-time-unit','ms');field(page,'digitize-delimiter',';');field(page,'digitize-decimal',',');check(page,'digitize-map-confirm');await page.get('digitize-stage-csv').onclick({});assumptions(page);check(page,'digitize-overlay-review');await page.get('use-trace').onclick({});
  const saved=await saveZip(page);assert.equal(saved.evidence.digitization!.extraction.kind,'csv');if(saved.evidence.digitization!.extraction.kind==='csv')assert.equal(saved.evidence.digitization!.extraction.text,original);
  await openZip(page,saved);page.get('project-accept').onclick({});const reopened=await saveZip(page);assert.deepEqual(reopened.evidence.digitization,saved.evidence.digitization);
});

test('native archives restore cropped views with off-crop raw points and landmarks before any source mutation',async()=>{
  const page=await editor(undefined,{decodeSize:[920,430]});await sample(page);sampleTrace(page);await page.get('digitize-stage-image').onclick({});assumptions(page);check(page,'digitize-overlay-review');await page.get('use-trace').onclick({});const saved=await saveZip(page);
  saved.evidence.transforms!.crop=[200,80,500,250];saved.evidence.transforms!.viewSize=[700,350];await openZip(page,saved);assert.equal(page.get('project-accept').disabled,false,page.get('project-state').textContent);page.get('project-accept').onclick({});assert.match(page.get('project-state').textContent,/Project accepted/);assert.equal(page.get('image-canvas').width,700);assert.match(page.get('digitize-overlay-notes').textContent,/Rectangular plot assumption/);assert.deepEqual((await saveZip(page)).evidence.digitization,saved.evidence.digitization);
});

test('native image decode must match extraction dimensions even when transforms are absent',async()=>{
  const page=await editor();await sample(page);sampleTrace(page);await page.get('digitize-stage-image').onclick({});assumptions(page);check(page,'digitize-overlay-review');await page.get('use-trace').onclick({});const saved=await saveZip(page);const {transforms,...evidence}=saved.evidence;saved.evidence=evidence;
  const fresh=await editor(),initial=fresh.get('source').value;await openZip(fresh,saved);assert.match(fresh.get('project-state').textContent,/dimensions do not match/);assert.equal(fresh.get('project-accept').disabled,true);assert.equal(fresh.get('source').value,initial);
});

test('successful image replacement resets unsealed landmarks even for identical bytes while a failed decode preserves them',async()=>{
  const page=await editor();await sample(page);sampleTrace(page);assert.match(page.get('digitize-landmarks').textContent,/x0:/);
  page.get('image-file').files=[localFile('same.png',new Uint8Array(Buffer.from(samplePngBase64,'base64')),'image/png')];await page.get('image-file').onchange({target:page.get('image-file')});assert.match(page.get('digitize-landmarks').textContent,/No landmarks/);
  mark(page,'landmark-x0',30,50);page.get('image-file').files=[localFile('same.png',new Uint8Array(Buffer.from(samplePngBase64,'base64')),'image/png')];await page.get('image-file').onchange({target:page.get('image-file')});assert.match(page.get('digitize-landmarks').textContent,/No landmarks/);
  const failure=await editor(undefined,{decodeError:true});await sample(failure);mark(failure,'landmark-x0',80,365);const prior=failure.get('digitize-landmarks').textContent;failure.get('image-file').files=[localFile('bad.png',new Uint8Array(Buffer.from(samplePngBase64,'base64')),'image/png')];await failure.get('image-file').onchange({target:failure.get('image-file')});assert.equal(failure.get('digitize-landmarks').textContent,prior);assert.match(failure.get('trace-message').textContent,/could not decode/);
});

test('canvas clicks use the responsive content box and reject border clicks',async()=>{
  const page=await editor();await sample(page);const canvas:any=page.get('image-canvas');canvas.offsetWidth=700;canvas.offsetHeight=360;page.context.getComputedStyle=()=>({borderLeftWidth:'1px',borderRightWidth:'1px',borderTopWidth:'1px',borderBottomWidth:'1px'});
  page.get('landmark-x0').onclick({});canvas.onclick({clientX:0.5,clientY:100});assert.match(page.get('trace-message').textContent,/inside the original image/);assert.match(page.get('digitize-landmarks').textContent,/No landmarks/);
  canvas.onclick({clientX:1+80/920*698,clientY:1+365/430*358});assert.match(page.get('digitize-landmarks').textContent,/x0: original pixel \(80, 365\)/);
  canvas.getBoundingClientRect=()=>({left:20,top:30,width:1400,height:720});page.get('landmark-x1').onclick({});canvas.onclick({clientX:22+850/920*1396,clientY:32+365/430*716});assert.match(page.get('digitize-landmarks').textContent,/x1: original pixel \(850, 365\)/);
});

test('resize and tab visibility do not synthesize optional evidence fields or rewrite stored view metadata',async()=>{
  const page=await editor();await stageCsv(page);assumptions(page);check(page,'digitize-overlay-review');await page.get('use-trace').onclick({});const saved=await saveZip(page),record=saved.evidence.digitization!;const {view,provenance,initialHoldConfirmed,finiteEdgesConfirmed,...minimal}=record;saved.evidence.digitization=minimal;
  await openZip(page,saved);page.get('project-accept').onclick({});page.observers.forEach(callback=>callback());page.get('image-canvas').getBoundingClientRect=()=>({left:0,top:0,width:0,height:0});page.observers.forEach(callback=>callback());assert.deepEqual((await saveZip(page)).evidence.digitization,minimal);
  saved.evidence.digitization={...minimal,view:{zoom:1.5,displaySize:[812,410]}};await openZip(page,saved);page.get('project-accept').onclick({});page.get('image-canvas').getBoundingClientRect=()=>({left:0,top:0,width:900,height:450});page.observers.forEach(callback=>callback());assert.deepEqual((await saveZip(page)).evidence.digitization,saved.evidence.digitization);
  field(page,'digitize-article','new citation');const edited=page.context.WaveDigitizeControls.record;assert.equal(edited.provenance!.article,'new citation');assert.equal(edited.provenance!.page,undefined);assert.deepEqual(JSON.parse(JSON.stringify(edited.view)),{zoom:1.5,displaySize:[812,410]});assert.equal(edited.initialHoldConfirmed,undefined);assert.deepEqual((await saveZip(page)).evidence.digitization,saved.evidence.digitization);
});

test('a new extraction clears candidate attribution and confirmations while mapping edits require a new confirmation',async()=>{
  const page=await editor();await stageCsv(page);assumptions(page,'Old extraction assumption.');field(page,'digitize-article','Old article');field(page,'digitize-figure','Old figure');check(page,'digitize-overlay-review');await page.get('use-trace').onclick({});const notes=page.get('project-notes').value;
  page.get('digitize-new').onclick({});for(const id of ['digitize-assumptions','digitize-article','digitize-figure','digitize-csv-text'])assert.equal(page.get(id).value,'');for(const id of ['digitize-map-confirm','digitize-overlay-review','digitize-finite-edges','digitize-initial-hold'])assert.equal(page.get(id).checked,false);assert.equal(page.get('project-notes').value,notes);
  check(page,'digitize-map-confirm');field(page,'digitize-csv-text','t,v\n0,0\n1,1');assert.equal(page.get('digitize-map-confirm').checked,false);check(page,'digitize-map-confirm');field(page,'digitize-time-unit','s');assert.equal(page.get('digitize-map-confirm').checked,false);check(page,'digitize-map-confirm');field(page,'digitize-x-column','2');assert.equal(page.get('digitize-map-confirm').checked,false);
});

test('acceptance rejects complete project note and JSON entry limits before changing any committed source or notes',async()=>{
  const page=await editor(),initial=page.get('source').value;await stageCsv(page);assumptions(page,'x'.repeat(65535));check(page,'digitize-overlay-review');await page.get('use-trace').onclick({});assert.equal(page.get('source').value,initial);assert.equal(page.get('project-notes').value,'');assert.match(page.get('trace-message').textContent,/notes exceed 64 KiB/);assert.equal(page.context.WaveSemanticEditor.active,false);
  assumptions(page);field(page,'project-notes','z'.repeat(65520));page.get('digitize-restage').onclick({});check(page,'digitize-overlay-review');await page.get('use-trace').onclick({});assert.equal(page.get('source').value,initial);assert.equal(page.get('project-notes').value,'z'.repeat(65520));assert.match(page.get('trace-message').textContent,/notes exceed 64 KiB/);
  field(page,'project-notes','');page.get('digitize-new').onclick({});await stageCsv(page,'t,v,ignored\n0,1,'+'\\'.repeat(600000)+'\n1,2,small');assert.ok(page.context.WaveDigitizeControls.record);assumptions(page);check(page,'digitize-overlay-review');await page.get('use-trace').onclick({});assert.equal(page.get('source').value,initial);assert.equal(page.get('project-notes').value,'');assert.match(page.get('trace-message').textContent,/entry exceeds its size limit/);
});

test('pending CSV reads and image staging cannot survive source Add and Undo ABA changes',async()=>{
  const page=await editor();let release:any;const reading=new Promise<ArrayBuffer>(resolve=>release=resolve);page.get('digitize-csv-file').files=[{name:'old.csv',size:10,arrayBuffer:()=>reading}];const pending=page.get('digitize-csv-file').onchange({target:page.get('digitize-csv-file')});page.get('add').onclick({});page.get('undo').onclick({});release(new TextEncoder().encode('t,y\n0,1\n1,2').buffer);await pending;assert.equal(page.get('digitize-csv-text').value,'');
  await sample(page);sampleTrace(page);const staging=page.get('digitize-stage-image').onclick({});page.get('add').onclick({});page.get('undo').onclick({});await staging;assert.equal(page.context.WaveDigitizeControls.record,undefined);assert.match(page.get('trace-message').textContent,/changed during capture/);
});

test('loaded legacy raw clicks stay visible and unsolicited canvas clicks cannot replace them',async()=>{
  const page=await editor(),evidence={rawPoints:[[80,365],[465,68],[850,365]] as [number,number][],calibration:{low:[80,365] as [number,number],high:[850,35] as [number,number],x0:0,x1:200,y0:0,y1:200},transforms:{originalSize:[920,430] as [number,number],viewSize:[920,430] as [number,number],crop:null,reference:'unavailable' as const}};
  await openZip(page,snapshot(rawPoint,'points',evidence));page.get('project-accept').onclick({});assert.match(page.get('trace-points').textContent,/Legacy raw clicks/);clickPixel(page,200,100);assert.match(page.get('trace-message').textContent,/sealed/);assert.deepEqual((await saveZip(page)).evidence,evidence);assert.equal(page.context.WaveDigitizeControls.record,undefined);
});

test('replacement candidates preserve accepted extraction and source evidence until preflighted acceptance, and cancel restores it',async()=>{
  const page=await editor(undefined,{decodeSize:[920,430]});await sample(page);sampleTrace(page);await page.get('digitize-stage-image').onclick({});assumptions(page);check(page,'digitize-overlay-review');await page.get('use-trace').onclick({});const accepted=await saveZip(page),source=page.get('source').value;
  page.get('digitize-new').onclick({});await stageCsv(page,'malformed data');assert.equal(page.get('source').value,source);assert.deepEqual((await saveZip(page)).evidence,accepted.evidence);
  await stageCsv(page);assumptions(page);assert.deepEqual((await saveZip(page)).evidence,accepted.evidence);await page.get('recovery-save').onclick({});assert.deepEqual((await readProjectRecovery({factory:page.database.factory}))!.snapshot.evidence,accepted.evidence);
  await page.get('digitize-cancel').onclick({});assert.equal(page.get('source').value,source);assert.deepEqual(JSON.parse(JSON.stringify(page.context.WaveDigitizeControls.record)),accepted.evidence.digitization);assert.deepEqual((await saveZip(page)).evidence,accepted.evidence);
  page.get('digitize-new').onclick({});await stageCsv(page);assumptions(page);check(page,'digitize-overlay-review');await page.get('use-trace').onclick({});const replacement=await saveZip(page);assert.equal(replacement.evidence.digitization!.extraction.kind,'csv');assert.notEqual(replacement.source,accepted.source);
});

test('main source CSV picker opens explicit mapping without changing accepted source or evidence and retains original BOM and CRLF',async()=>{
  const page=await editor();await stageCsv(page);assumptions(page);check(page,'digitize-overlay-review');await page.get('use-trace').onclick({});const accepted=await saveZip(page),source=page.get('source').value;
  const textarea=page.get('digitize-csv-text');let visible=textarea.value;Object.defineProperty(textarea,'value',{get:()=>visible,set:(value:string)=>visible=value.replace(/\r\n?/g,'\n')});
  const original='\uFEFFtime,level\r\n0,-3\r\n1,7\r\n2,-3\r\n';page.get('open-file').files=[localFile('main-picker.CSV',new TextEncoder().encode(original),'text/csv')];await page.get('open-file').onchange({target:page.get('open-file')});
  assert.equal(page.get('source').value,source);assert.deepEqual((await saveZip(page)).evidence,accepted.evidence);assert.equal(page.get('trace-panel').hidden,false);assert.equal((page.get('digitize-csv-details') as any).open,true);assert.equal(page.get('digitize-map-confirm').checked,false);assert.equal(page.context.WaveDigitizeControls.record,undefined);assert.notEqual(textarea.value,original);
  await page.get('digitize-stage-csv').onclick({});assert.match(page.get('trace-message').textContent,/Confirm the CSV/);assert.equal(page.get('source').value,source);
  check(page,'digitize-map-confirm');await page.get('digitize-stage-csv').onclick({});check(page,'digitize-overlay-review');await page.get('use-trace').onclick({});assert.match(page.get('trace-message').textContent,/assumptions/);assert.equal(page.get('source').value,source);
  assumptions(page,'Explicit column mapping and manually reviewed measurements.');check(page,'digitize-overlay-review');await page.get('use-trace').onclick({});const saved=await saveZip(page);assert.notEqual(saved.source,accepted.source);assert.equal(saved.evidence.digitization!.extraction.kind,'csv');if(saved.evidence.digitization!.extraction.kind==='csv'){assert.equal(saved.evidence.digitization!.extraction.text,original);assert.equal(saved.evidence.digitization!.extraction.name,'main-picker.CSV');assert.equal(saved.evidence.digitization!.extraction.mapping.timeUnit,'s');}
});

test('main source CSV picker refuses dirty sources, unsupported extensions, source ABA and newer Trace paste while reading',async()=>{
  const page=await editor(),original=page.get('source').value;field(page,'source','unfinished source draft');page.get('open-file').files=[localFile('draft.csv',new TextEncoder().encode('t,y\n0,1\n1,2'),'text/csv')];await page.get('open-file').onchange({target:page.get('open-file')});assert.equal(page.get('source').value,'unfinished source draft');assert.equal(page.get('digitize-csv-text').value,'');page.get('discard-text').onclick({});
  page.get('open-file').files=[localFile('bypass.txt',new TextEncoder().encode('t,y\n0,1\n1,2'),'text/plain')];await page.get('open-file').onchange({target:page.get('open-file')});assert.equal(page.get('source').value,original);assert.match(page.get('global-message').textContent,/Use a JSON, CSV, or YAML/);
  for(const mutate of [()=>{page.get('add').onclick({});page.get('undo').onclick({});},()=>field(page,'digitize-csv-text','newer Trace paste')]){
    let release:any;const bytes=new Promise<ArrayBuffer>(resolve=>release=resolve);page.get('open-file').files=[{name:'slow.csv',size:20,arrayBuffer:()=>bytes}];const pending=page.get('open-file').onchange({target:page.get('open-file')});mutate();release(new TextEncoder().encode('t,y\n0,5\n1,8').buffer);await pending;assert.equal(page.get('source').value,original);assert.notEqual(page.get('digitize-csv-text').value,'t,y\n0,5\n1,8');assert.equal(page.get('open-file').value,'');
  }
  assert.equal(page.get('digitize-csv-text').value,'newer Trace paste');
});
