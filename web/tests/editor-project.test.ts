import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { packProject, unpackProject, writeProjectRecovery, readProjectRecovery } from '../src/project/index.ts';
import type { ProjectSnapshot } from '../src/project/index.ts';
import { projectRecoveryDatabase } from './support/project-recovery-db.ts';
import { samplePngBase64 } from '../src/proof.ts';
import { unzipSync, zipSync } from 'fflate';
import { semanticSamples } from '../src/editor-semantic-entry.ts';

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
  const sourceLabel=new Element(), downloads:Blob[]=[], anchors:any[]=[], urls=new Map<string,Blob>();
  let sourceValue='';Object.defineProperty(elements.get('source'),'value',{get:()=>sourceValue,set:(value:string)=>{sourceValue=value.replace(/\r\n?/g,'\n');}});
  const downloadUrl={createObjectURL:(blob:Blob)=>{const url='blob:'+urls.size;urls.set(url,blob);return url;},revokeObjectURL:()=>{}};
  class TestImage {width=options.decodeSize?.[0]||640;height=options.decodeSize?.[1]||480;naturalWidth=this.width;naturalHeight=this.height;onload:any;onerror:any;set src(value:string){void Promise.resolve(options.decodeWait).then(()=>{if(options.decodeError)this.onerror?.();else this.onload?.();});}}
  const context=vm.createContext({console,TextEncoder,TextDecoder,Blob,Uint8Array,DOMException,clearTimeout,indexedDB:database.factory,Image:TestImage,setTimeout,URL:downloadUrl,structuredClone,window:{},ResizeObserver:class{observe(){}},requestAnimationFrame:(fn:any)=>fn(),
    document:{getElementById:(id:string)=>elements.get(id),createElement:(tag:string)=>{const el=new Element(tag);if(tag==='a'){anchors.push(el);el.click=()=>{downloads.push(urls.get((el as any).href)!);};}return el;},createElementNS:(_:string,tag:string)=>new Element(tag,true),
      querySelector:()=>sourceLabel,querySelectorAll:(selector:string)=>selector==='[role=tab]'?[elements.get('edit-tab'),elements.get('trace-tab')]:[]}});
  for(const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) vm.runInContext(script[1],context);
  await (context as any).WaveProjectControls.startup;
  return {database,elements,context,html,downloads,anchors,get:(id:string)=>elements.get(id)!};
}

const snapshot=(source:string,mode:'points'|'semantic'='points',evidence:ProjectSnapshot['evidence']={}):ProjectSnapshot=>({revisionId:'fixture-1',mode,source,evidence});
const sourceDocument={version:1,name:'Imported point source',units:{time:'us',current:'A'},points:[[0,-3],[100,-3]],maxSlew:null,articleMetadata:{doi:'unknown preserved field'}};
const rawPoint='\uFEFF'+JSON.stringify(sourceDocument,null,2).replace(/\n/g,'\r\n')+'\r\n';
function localFile(name:string,bytes:Uint8Array,type='application/zip') {const blob=new Blob([bytes],{type});return {name,type,size:blob.size,arrayBuffer:()=>blob.arrayBuffer(),text:()=>blob.text()};}
async function openZip(page:any,project:ProjectSnapshot) {page.get('project-open').files=[localFile('project.zip',packProject(project))];await page.get('project-open').onchange({target:page.get('project-open')});}
async function saveZip(page:any) {const count=page.downloads.length;await page.get('project-save').onclick({});assert.equal(page.downloads.length,count+1,page.get('project-state').textContent);return unpackProject(new Uint8Array(await page.downloads.at(-1).arrayBuffer()));}

test('actual project handlers preview, cancel and accept exact point BOM/CRLF source with unknown metadata',async()=>{
  const page=await editor(),{get}=page,initial=get('source').value,output=get('export-preview').textContent;
  await openZip(page,snapshot(rawPoint));assert.equal(get('source').value,initial);assert.equal(get('export-preview').textContent,output);assert.equal((get('project-preview') as any).hidden,false);
  get('project-cancel').onclick({});assert.equal(get('source').value,initial);
  await openZip(page,snapshot(rawPoint));get('project-accept').onclick({});
  assert.equal(JSON.parse(get('source').value.replace(/^\uFEFF/,'')).articleMetadata.doi,'unknown preserved field');
  assert.notEqual(get('source').value,rawPoint,'textarea normalizes CRLF while committed text retains it');
  assert.equal((await saveZip(page)).source,rawPoint);assert.match(get('export-preview').textContent,/-3/);
  get('discard-text').onclick({});assert.equal((await saveZip(page)).source,rawPoint);
});

test('project save and import acceptance block source and repetition drafts without losing the draft',async()=>{
  const page=await editor(),{get}=page;
  await openZip(page,snapshot(rawPoint));get('source').value='{ invalid draft';get('source').oninput({});
  await get('project-save').onclick({});get('project-accept').onclick({});assert.equal(page.downloads.length,0);assert.equal(get('source').value,'{ invalid draft');assert.match(get('project-state').textContent,/Apply or restore/);
  get('discard-text').onclick({});get('scenario-burst').onclick({});get('repeat-count').value='11';get('repeat-count').oninput({});
  await get('project-save').onclick({});assert.equal(page.downloads.length,0);assert.match(get('project-state').textContent,/repetition drafts/);
  get('discard-text').onclick({});assert.equal(get('project-save').disabled,false);
});

test('semantic project saves committed intent while edit proposals remain outside the archive and FFT/export stay unchanged',async()=>{
  const page=await editor(),{get}=page;
  const raw='\uFEFF# Keep source bytes.\r\n'+semanticSamples.voltage.replace(/\n/g,'\r\n');
  await openZip(page,snapshot(raw,'semantic'));get('project-accept').onclick({});
  get('spectrum-analyze').onclick({});const analysis=get('spectrum-summary').textContent,output=get('export-preview').textContent;
  get('semantic-value').value='3 V';get('semantic-value').oninput({});get('semantic-propose').onclick({});
  assert.equal((await saveZip(page)).source,raw);assert.equal(get('export-preview').textContent,output);assert.equal(get('spectrum-summary').textContent,analysis);
  get('semantic-cancel-edit').onclick({});const archive=await saveZip(page);
  await openZip(page,archive);get('project-accept').onclick({});get('spectrum-analyze').onclick({});
  assert.equal(get('spectrum-summary').textContent,analysis);assert.equal(get('export-preview').textContent,output);
});

test('corrupt archives, oversized files and failed image decode show errors before active state changes',async()=>{
  const page=await editor(undefined,{decodeError:true}),{get}=page,initial=get('source').value;
  get('project-open').files=[localFile('bad.zip',new Uint8Array([1,2,3]))];await get('project-open').onchange({target:get('project-open')});assert.match(get('project-state').textContent,/ZIP|project/);
  let read=false;get('project-open').files=[{name:'huge.zip',size:17*1024*1024,arrayBuffer:()=>{read=true;throw Error('read');}}];await get('project-open').onchange({target:get('project-open')});assert.equal(read,false);assert.match(get('project-state').textContent,/16 MiB/);
  await openZip(page,snapshot(rawPoint,'points',{image:{name:'source.png',mime:'image/png',bytes:new Uint8Array(Buffer.from(samplePngBase64,'base64'))}}));
  assert.match(get('project-state').textContent,/decode the project image/);assert.equal(get('source').value,initial);assert.equal(get('project-accept').disabled,true);
});

test('stale preview and out-of-order file reads cannot replace a newer active project',async()=>{
  const page=await editor(),{get}=page;await openZip(page,snapshot(rawPoint));get('add').onclick({});const edited=get('source').value;get('project-accept').onclick({});assert.equal(get('source').value,edited);assert.match(get('project-state').textContent,/stale/);
  let release:any;const first=new Promise<ArrayBuffer>(resolve=>{release=resolve;});
  get('project-open').files=[{name:'slow.zip',arrayBuffer:()=>first}];const pending=get('project-open').onchange({target:get('project-open')});
  const newest=snapshot(semanticSamples.voltage,'semantic');await openZip(page,newest);release(packProject(snapshot(rawPoint)).buffer);await pending;
  get('project-accept').onclick({});assert.equal((await saveZip(page)).source,newest.source);
});

test('legacy JSON requires explicit acceptance and retains original bytes and metadata',async()=>{
  const page=await editor(),{get}=page,initial=get('source').value;
  get('open-file').files=[localFile('old.json',new TextEncoder().encode(rawPoint),'application/json')];await get('open-file').onchange({target:get('open-file')});
  assert.equal(get('source').value,initial);assert.match(get('project-preview-text').textContent,/Legacy JSON migration/);get('project-accept').onclick({});assert.equal((await saveZip(page)).source,rawPoint);
});

test('imported image original bytes, raw trace, calibration, corrections, transforms and notes round-trip',async()=>{
  const page=await editor(),{get}=page;
  const bytes=new Uint8Array(Buffer.from(samplePngBase64,'base64'));
  const evidence:ProjectSnapshot['evidence']={image:{name:'original.png',mime:'image/png',bytes},rawPoints:[[80,365],[850,35]],calibration:{low:[80,365],high:[850,35],x0:0,x1:200,y0:0,y1:200},corrections:[{index:1,point:[849,36],note:'article rounding'}],transforms:{originalSize:[640,480],viewSize:[920,430],crop:[1,2,600,400],reference:'image'},notes:'Article figure 4.'};
  await openZip(page,snapshot(rawPoint,'points',evidence));get('project-accept').onclick({});const saved=await saveZip(page);
  assert.deepEqual(saved.evidence,evidence);assert.equal(saved.source,rawPoint);
  get('image-file').files=[localFile('upload.png',bytes,'image/png')];await get('image-file').onchange({target:get('image-file')});const uploaded=await saveZip(page);
  assert.deepEqual(uploaded.evidence.image!.bytes,bytes);assert.deepEqual(uploaded.evidence.transforms!.originalSize,[640,480]);
});

test('generated demo PNG captures once before tracing and keeps its bytes after reopen',async()=>{
  const page=await editor(undefined,{decodeSize:[920,430]}),{get}=page;await get('sample-image').onclick({});const first=await saveZip(page);
  assert.equal(first.evidence.image!.mime,'image/png');assert.equal(first.evidence.transforms!.reference,'sample');assert.match(first.evidence.notes!,/Generated demo PNG/);
  await openZip(page,first);get('project-accept').onclick({});const second=await saveZip(page);assert.deepEqual(second.evidence.image!.bytes,first.evidence.image!.bytes);assert.equal(second.evidence.notes,first.evidence.notes);
});

test('browser recovery preserves committed source with an invalid text draft and restores only by choice',async()=>{
  const database=projectRecoveryDatabase();const page=await editor(database),{get}=page;
  get('source').value='{ invalid text';get('source').oninput({});await get('recovery-save').onclick({});
  const saved=await readProjectRecovery({factory:database.factory});assert.equal(saved!.draft.text,'{ invalid text');assert.equal(JSON.parse(saved!.snapshot.source).points.length,9);
  const reopened=await editor(database);assert.equal(JSON.parse(reopened.get('source').value).points.length,9);assert.equal((reopened.get('recovery-offer') as any).hidden,false);
  const stored=structuredClone(database.state.stored);await reopened.context.WaveProjectControls.persist();assert.deepEqual(database.state.stored,stored);
  await reopened.get('recovery-restore').onclick({});assert.equal(reopened.get('source').value,'{ invalid text');assert.equal(reopened.get('project-save').disabled,true);assert.match(reopened.get('export-state').textContent,/Apply or restore/);
});

test('Keep current cancels a recovery image restore that is still decoding',async()=>{
  const database=projectRecoveryDatabase();await writeProjectRecovery(snapshot(rawPoint,'points',{image:{name:'original.png',mime:'image/png',bytes:new Uint8Array(Buffer.from(samplePngBase64,'base64'))}}),{text:null,selection:0},{factory:database.factory});
  let release:any;const wait=new Promise(resolve=>release=resolve);const page=await editor(database,{decodeWait:wait}),initial=page.get('source').value;
  const pending=page.get('recovery-restore').onclick({});page.get('recovery-keep').onclick({});release();await pending;assert.equal(page.get('source').value,initial);
});

test('recovery quota, denied and corrupt storage stay visible while explicit ZIP save/open work',async()=>{
  const database=projectRecoveryDatabase(),page=await editor(database),{get}=page;
  database.state.errorNext=new DOMException('Quota exceeded.','QuotaExceededError');await get('recovery-save').onclick({});assert.match(get('recovery-state').textContent,/Quota exceeded/);assert.equal(database.state.stored,undefined);
  get('recovery-denied').checked=true;await get('recovery-save').onclick({});assert.match(get('recovery-state').textContent,/denied/);const saved=await saveZip(page);await openZip(page,snapshot(rawPoint));get('project-accept').onclick({});assert.equal((await saveZip(page)).source,rawPoint);
  database.state.stored={corrupt:true};const corrupt=await editor(database);assert.match(corrupt.get('recovery-state').textContent,/corrupt/);await saveZip(corrupt);assert.deepEqual(database.state.stored,{corrupt:true});assert.ok(saved.source);
});

test('serialized recovery writes publish the latest source and draft after transaction completion',async()=>{
  const database=projectRecoveryDatabase(),page=await editor(database),{get}=page;
  database.state.paused=true;get('source').value='draft one';get('source').oninput({});const first=get('recovery-save').onclick({});
  for(let i=0;i<100 && !database.state.requestSuccess;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.ok(database.state.requestSuccess,get('recovery-state').textContent);
  get('source').value='draft two';get('source').oninput({});const second=get('recovery-save').onclick({});assert.equal(database.state.stored,undefined);
  database.state.paused=false;database.state.complete();await Promise.all([first,second]);const latest=await readProjectRecovery({factory:database.factory});assert.equal(latest!.draft.text,'draft two');
});

test('project replacement resets undo across both source modes while rejected import preserves history and proposal',async()=>{
  const page=await editor(),{get,context}=page;get('add').onclick({});assert.equal(get('undo').disabled,false);
  get('semantic-sample').value='voltage';get('semantic-load-sample').onclick({});
  get('source').value=get('source').value.replace('-12 V','-10 V');get('source').oninput({});get('apply-text').onclick({});assert.equal(context.WaveSemanticEditor.session.canUndo,true);
  get('semantic-value').value='3 V';get('semantic-value').oninput({});get('semantic-propose').onclick({});const proposal=get('semantic-proposal').textContent;
  get('project-open').files=[localFile('bad.zip',new Uint8Array([1,2]))];await get('project-open').onchange({target:get('project-open')});assert.equal(get('semantic-proposal').textContent,proposal);assert.equal(context.WaveSemanticEditor.session.canUndo,true);
  await openZip(page,snapshot(semanticSamples.current,'semantic'));get('project-accept').onclick({});assert.equal(context.WaveSemanticEditor.session.canUndo,false);assert.equal(get('undo').disabled,true);
  get('source-mode').value='points';get('source-mode').onchange({});assert.equal(get('undo').disabled,true);
  await openZip(page,snapshot(rawPoint));get('project-accept').onclick({});assert.equal(get('undo').disabled,true);
});

test('image dimensions and canvas allocation limits reject before acceptance',async()=>{
  const page=await editor(),initial=page.get('source').value,bytes=new Uint8Array(Buffer.from(samplePngBase64,'base64'));
  await openZip(page,snapshot(rawPoint,'points',{image:{name:'x.png',mime:'image/png',bytes},transforms:{originalSize:[999,999],viewSize:[920,430],crop:null,reference:'image'}}));
  assert.match(page.get('project-state').textContent,/dimensions do not match/);assert.equal(page.get('source').value,initial);
  const files=unzipSync(packProject(snapshot(rawPoint,'points',{image:{name:'x.png',mime:'image/png',bytes},transforms:{originalSize:[640,480],viewSize:[920,430],crop:null,reference:'image'}})));
  const transform=JSON.parse(new TextDecoder().decode(files['evidence/transforms.json']));transform.data.viewSize=[100000,100000];files['evidence/transforms.json']=new TextEncoder().encode(JSON.stringify(transform));
  const manifest=JSON.parse(new TextDecoder().decode(files['manifest.json']));manifest.entries['evidence/transforms.json'].bytes=files['evidence/transforms.json'].length;files['manifest.json']=new TextEncoder().encode(JSON.stringify(manifest));
  page.get('project-open').files=[localFile('huge-view.zip',zipSync(files))];await page.get('project-open').onchange({target:page.get('project-open')});
  assert.match(page.get('project-state').textContent,/2000 pixels/);assert.equal(page.get('source').value,initial);
});

test('legacy image references retain original clicks and calibration while showing missing bytes',async()=>{
  const page=await editor(),{get}=page;
  const source={...sourceDocument,source:{imageName:'figure.jpg',pixelSize:[920,430],rawTrace:[[80,365],[850,35]],calibration:{low:[80,365],high:[850,35],x0:0,x1:200,y0:0,y1:200}}};
  const text=JSON.stringify(source);get('open-file').files=[localFile('old-trace.json',new TextEncoder().encode(text),'application/json')];await get('open-file').onchange({target:get('open-file')});get('project-accept').onclick({});
  const saved=await saveZip(page);assert.equal(saved.source,text);assert.equal(saved.evidence.image,undefined);assert.deepEqual(saved.evidence.rawPoints,source.source.rawTrace);assert.deepEqual(saved.evidence.calibration,source.source.calibration);assert.equal(saved.evidence.transforms!.reference,'unavailable');assert.match(saved.evidence.notes!,/Attach the original image/);
});

test('a newer ZIP preview supersedes a slow read from the source picker',async()=>{
  const page=await editor(),{get}=page;let release:any;const bytes=new Promise<ArrayBuffer>(resolve=>release=resolve);
  get('open-file').files=[{name:'slow.yaml',size:100,arrayBuffer:()=>bytes}];const pending=get('open-file').onchange({target:get('open-file')});
  await openZip(page,snapshot(rawPoint));release(new TextEncoder().encode(semanticSamples.voltage).buffer);await pending;
  get('project-accept').onclick({});assert.equal((await saveZip(page)).source,rawPoint);
});

test('debounced recovery saves selection and visibly tracks pending changes',async()=>{
  const database=projectRecoveryDatabase(),page=await editor(database),{get}=page;
  get('point-choice').value='4';get('point-choice').onchange({});get('source').value='unfinished draft';get('source').oninput({});
  assert.match(get('recovery-state').textContent,/pending/);await new Promise(resolve=>setTimeout(resolve,420));await page.context.WaveProjectControls.persist();
  const record=await readProjectRecovery({factory:database.factory});assert.equal(record!.draft.selection,4);assert.equal(record!.draft.text,'unfinished draft');assert.match(get('recovery-state').textContent,/Browser recovery saved/);
});

test('optional evidence stays absent across image-only, notes-only and empty correction round-trips',async()=>{
  const page=await editor(),{get}=page;
  for(const evidence of [{image:{name:'single.png',mime:'image/png' as const,bytes:new Uint8Array(Buffer.from(samplePngBase64,'base64'))}},{image:{name:'sized.png',mime:'image/png' as const,bytes:new Uint8Array(Buffer.from(samplePngBase64,'base64'))},transforms:{originalSize:[640,480] as [number,number],viewSize:[920,430] as [number,number],crop:null}},{notes:'Only a citation.'},{notes:''},{corrections:[]}]) {
    await openZip(page,snapshot(rawPoint,'points',evidence));get('project-accept').onclick({});const saved=await saveZip(page);assert.deepEqual(saved.evidence,evidence);
    await openZip(page,saved);get('project-accept').onclick({});assert.equal((await saveZip(page)).source,rawPoint);
  }
});

test('an edit followed by the same text or undo cannot revive an invalidated preview',async()=>{
  const page=await editor(),{get}=page;await openZip(page,snapshot(rawPoint));
  get('project-notes').value='changed';get('project-notes').oninput({});get('project-notes').value='';get('project-notes').oninput({});
  const initial=get('source').value;get('project-accept').onclick({});assert.equal(get('source').value,initial);assert.equal(get('project-accept').disabled,true);assert.match(get('project-state').textContent,/stale/);
  await openZip(page,snapshot(rawPoint));get('add').onclick({});get('undo').onclick({});get('project-accept').onclick({});assert.equal(get('source').value,initial);assert.match(get('project-state').textContent,/stale/);
});

test('explicit unknown JSON wrapper formats do not fall back to point migration',async()=>{
  const page=await editor(),{get}=page,initial=get('source').value;
  get('open-file').files=[localFile('future.json',new TextEncoder().encode(JSON.stringify({...sourceDocument,format:'wavecraft-semantic-project/2'})),'application/json')];await get('open-file').onchange({target:get('open-file')});
  assert.match(get('global-message').textContent,/format or schema is not supported/);assert.equal(get('source').value,initial);assert.equal(get('project-accept').disabled,true);
});
