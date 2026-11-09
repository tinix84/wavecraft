import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { unzipSync, strFromU8 } from 'fflate';
import { semanticSamples } from '../src/editor-semantic-entry.ts';

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
  listeners: Record<string,any[]> = {}; captured = false;
  addEventListener(type:string,handler:any) { (this.listeners[type] ||= []).push(handler); }
  dispatch(type:string,event:any) { for(const handler of this.listeners[type] || []) handler({...event,target:event.target || this}); }
  setPointerCapture() {this.captured=true;} hasPointerCapture() {return this.captured;} releasePointerCapture() {this.captured=false;}
  getBoundingClientRect() {return {left:0,top:0,width:700,height:360};}
  focus() {} click() {this.onclick?.({target:this});}
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
  for(const id of ['format','source-mode','semantic-sample','repeat-mode','spectrum-basis','spectrum-method','spectrum-rows']) {
    const el=elements.get(id)!;
    const body=html.match(new RegExp(`<select id="${id}">([\\s\\S]*?)<\\/select>`))![1];
    el.options=[...body.matchAll(/<option value="([^"]+)">([^<]*)/g)].map(m=>{const option=new Element();option.value=m[1];option.textContent=m[2];return option;});el.value=el.options[0].value;
  }
  const sourceLabel=new Element(), downloads:Blob[]=[], anchors:any[]=[];
  const downloadUrl={createObjectURL:(blob:Blob)=>{downloads.push(blob);return 'blob:local-test';},revokeObjectURL:()=>{}};
  const context=vm.createContext({console,TextEncoder,TextDecoder,Blob,setTimeout,URL:downloadUrl,structuredClone,window:{},ResizeObserver:class{observe(){}},requestAnimationFrame:(fn:any)=>fn(),
    document:{getElementById:(id:string)=>elements.get(id),createElement:(tag:string)=>{const el=new Element(tag);if(tag==='a')anchors.push(el);return el;},createElementNS:(_:string,tag:string)=>new Element(tag,true),
      querySelector:()=>sourceLabel,querySelectorAll:(selector:string)=>selector==='[role=tab]'?[elements.get('edit-tab'),elements.get('trace-tab')]:[]}});
  for(const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) vm.runInContext(script[1],context);
  return {elements,context,html,downloads,anchors,get:(id:string)=>elements.get(id)!};
}

function select(get:any, format:string) { get('format').value=format;get('format').onchange({}); }

test('all point data formats download the committed source through the shared adapter',async()=>{
  const {get,downloads,anchors}=await editor(), source=get('source').value;
  for(const format of ['csv','csv-uniform','pwl','pwl-file','plecs','python','javascript','matlab','yaml','json']) {
    select(get,format);assert.equal(get('download').disabled,false,`${format}: ${get('export-preview').textContent}`);
    const preview=get('export-preview').textContent;
    get('download').onclick({});const blob=downloads.at(-1)!;
    if(['pwl-file','plecs'].includes(format)) {
      assert.match(anchors.at(-1).download,/\.zip$/);
      const files=unzipSync(new Uint8Array(await blob.arrayBuffer()));
      assert.ok(Object.keys(files).length>=2);
      for(const [name,bytes] of Object.entries(files)) {assert.ok(preview.includes(name));assert.ok(preview.includes(strFromU8(bytes)));}
    } else assert.equal(await blob.text(),preview);
    assert.equal(get('source').value,source);
  }
  assert.equal(JSON.parse(source).points.length,9);
});

test('signed voltage exports retain physical dimensions, source bytes, and actual download names',async()=>{
  const {get,downloads,anchors,context}=await editor();get('semantic-sample').value='voltage';get('semantic-load-sample').onclick({});
  const source=get('source').value,revision=(context as any).WaveSemanticEditor.session.revision;
  for(const format of ['csv','csv-uniform','pwl','pwl-file','plecs','python','javascript','matlab','yaml','json']) {
    select(get,format);assert.equal(get('download').disabled,false,format);
    const preview=get('export-preview').textContent;
    if(!['yaml','json'].includes(format)) {assert.match(get('export-state').textContent,/Voltage \(V\)/);assert.match(preview,/-12/);assert.doesNotMatch(preview,/current_A/);}
    get('download').onclick({});assert.match(anchors.at(-1).download,/^Signed[-_]voltage/);
    if(format==='yaml')assert.equal(await downloads.at(-1)!.text(),source);
    assert.equal(get('source').value,source);assert.equal((context as any).WaveSemanticEditor.session.revision,revision);
  }
});

test('point continuous repetition requires an explicit horizon for all data formats including YAML',async()=>{
  const {get}=await editor();get('scenario-burst').onclick({});const source=get('source').value;
  assert.equal(get('semantic-horizon-field').hidden,false);
  for(const format of ['csv','csv-uniform','pwl','pwl-file','plecs','python','javascript','matlab','yaml']) {
    select(get,format);assert.equal(get('download').disabled,true,format);assert.match(get('export-preview').textContent,/HORIZON_REQUIRED/);
    get('semantic-horizon').value='0.00001';get('semantic-horizon').oninput({});assert.equal(get('download').disabled,false,format);
    assert.match(get('export-state').textContent,/horizon 0.00001 s/);
    get('semantic-horizon').value='';get('semantic-horizon').oninput({});
  }
  select(get,'json');assert.equal(get('download').disabled,false);assert.equal(JSON.parse(get('export-preview').textContent).repetition.burstPeriodUs,1000000);
  assert.equal(get('source').value,source);assert.match(get('repeat-summary').textContent,/10/);
});

test('uniform grid reports terminal coverage and refuses invalid or excessive sample counts',async()=>{
  const {get,context}=await editor();select(get,'csv-uniform');
  get('semantic-horizon').value='0.0000105';get('semantic-horizon').oninput({});get('export-sample-interval').value='0.000003';get('export-sample-interval').oninput({});
  assert.equal(get('download').disabled,false);assert.match(get('export-state').textContent,/Last sample: 0.000009 s/);assert.match(get('export-state').textContent,/only on the grid/);
  const rows=get('export-preview').textContent.split('\n').filter(s=>s&&!s.startsWith('#')).slice(1).map(s=>s.split(',').map(Number));
  assert.deepEqual(rows.map(p=>p[0]),[0,0.000003,0.000006,0.000009]);
  const source=get('source').value,revision=(context as any).WaveSemanticEditor.session.revision,analysis=get('spectrum-summary').textContent;
  for(const value of ['','0','-1','NaN','1e999','1e-30']) {get('export-sample-interval').value=value;get('export-sample-interval').oninput({});assert.equal(get('download').disabled,true,value);}
  assert.equal(get('source').value,source);assert.equal((context as any).WaveSemanticEditor.session.revision,revision);assert.equal(get('spectrum-summary').textContent,analysis);assert.equal(get('spectrum-results').hidden,false);
});

test('source drafts and repetition drafts block exports in both modes, including direct download handlers',async()=>{
  const {get,downloads}=await editor();get('scenario-burst').onclick({});get('semantic-horizon').value='0.00002';get('semantic-horizon').oninput({});
  get('repeat-count').value='11';get('repeat-count').oninput({});assert.equal(get('download').disabled,true);assert.match(get('export-state').textContent,/Repetition settings pending/);
  get('download').onclick({});assert.equal(downloads.length,0);select(get,'json');assert.equal(get('download').disabled,true);
  get('discard-text').onclick({});assert.equal(get('download').disabled,false);
  for(const mode of ['points','semantic']) {
    if(mode==='semantic'){get('source-mode').value=mode;get('source-mode').onchange({});}
    const source=get('source').value;get('source').value=source+'\n ';get('source').oninput({});
    for(const format of ['csv','csv-uniform','pwl-file','plecs','yaml','json']){select(get,format);assert.equal(get('download').disabled,true);get('download').onclick({});}
    assert.equal(downloads.length,0);get('discard-text').onclick({});
  }
});

test('analysis settings and unapplied semantic proposals leave the selected export byte-identical',async()=>{
  const {get,context}=await editor();get('semantic-sample').value='voltage';get('semantic-load-sample').onclick({});select(get,'pwl-file');
  const source=get('source').value,preview=get('export-preview').textContent,revision=(context as any).WaveSemanticEditor.session.revision;
  get('spectrum-cutoff').value='25';get('spectrum-cutoff').oninput({});get('spectrum-analyze').onclick({});
  get('semantic-value').value='3 V';get('semantic-value').oninput({});get('semantic-propose').onclick({});
  assert.equal(get('export-preview').textContent,preview);assert.equal(get('source').value,source);assert.equal((context as any).WaveSemanticEditor.session.revision,revision);
  get('semantic-cancel-edit').onclick({});assert.equal(get('export-preview').textContent,preview);
});

test('semantic burst data retains ten inner starts and the independent one-second outer clock',async()=>{
  const {get}=await editor();get('semantic-sample').value='burst';get('semantic-load-sample').onclick({});
  get('semantic-horizon').value='1.00001';get('semantic-horizon').oninput({});
  const source=get('source').value;
  const rows=get('export-preview').textContent.trim().split('\n').slice(1).map(s=>s.split(',').map(Number));
  assert.equal(rows.filter(p=>p[1]===10).length,40);
  for(let i=0;i<10;i++)assert.ok(rows.some(p=>Math.abs(p[0]-(1+i*1e-6+1e-7))<1e-14&&p[1]===10));
  assert.deepEqual(rows.at(-1),[1.00001,0]);
  get('export-sample-interval').value='0.0001';get('export-sample-interval').oninput({});
  for(const format of ['csv-uniform','pwl','pwl-file','plecs','python','javascript','matlab']) {select(get,format);assert.equal(get('download').disabled,false,format);assert.equal(get('source').value,source);}
});

test('native point drag updates preview and actual CSV download after the source commit',async()=>{
  const {get,downloads}=await editor(),svg=get('plot'),source=get('source').value,preview=get('export-preview').textContent;
  svg.children.find(child=>child.getAttribute('data-point')==='2')!.dispatch('pointerdown',{pointerId:1,preventDefault(){}});
  svg.dispatch('pointermove',{pointerId:1,clientX:62+18.2/135.68*614,clientY:312-(120+21.6)/223.2*292});
  assert.equal(get('source').value,source);assert.equal(get('export-preview').textContent,preview);
  svg.dispatch('pointerup',{pointerId:1});assert.notEqual(get('source').value,source);assert.notEqual(get('export-preview').textContent,preview);
  get('download').onclick({});assert.equal(await downloads.at(-1)!.text(),get('export-preview').textContent);
  get('undo').onclick({});assert.equal(get('source').value,source);assert.equal(get('export-preview').textContent,preview);
});

test('finite horizon cuts a ramp without a reset and exact CSV reimports each serialized number',async()=>{
  const {get,context}=await editor();get('semantic-sample').value='voltage';get('semantic-load-sample').onclick({});
  get('semantic-horizon').value='0.000035';get('semantic-horizon').oninput({});
  const csv=get('export-preview').textContent,rows=csv.trim().split('\n').slice(1).map(s=>s.split(',').map(Number));
  assert.deepEqual(rows.at(-1),[0.000035,-3]);
  const compiled=(context as any).WaveSemanticEditor.session.result.compiled;
  assert.equal(compiled.finalValue,-12);assert.ok(Math.abs(compiled.durationS-0.00012)<1e-19);
  assert.equal(rows.map(p=>p.join(',')).join('\n'),csv.trim().split('\n').slice(1).join('\n'));
  get('semantic-horizon').value='-1';get('semantic-horizon').oninput({});assert.equal(get('download').disabled,true);
  get('spectrum-analyze').onclick({});assert.equal(get('spectrum-results').hidden,false);
});

test('verified LTspice compact repeats are an explicit export choice and a horizon overrides it',async()=>{
  const {get,context,downloads}=await editor();
  for(const sourceMode of ['points','semantic']) {
    if(sourceMode==='points')get('scenario-burst').onclick({});
    else {get('semantic-sample').value='burst';get('semantic-load-sample').onclick({});}
    const source=get('source').value,revision=(context as any).WaveSemanticEditor.session.revision;
    for(const format of ['pwl','pwl-file']) {
      get('semantic-horizon').value='';get('semantic-horizon').oninput({});select(get,format);
      get('export-repeat-mode').value='expand';get('export-repeat-mode').onchange({});assert.equal(get('download').disabled,true);
      get('export-repeat-mode').value='auto';get('export-repeat-mode').onchange({});assert.equal(get('download').disabled,false,get('export-preview').textContent);
      assert.match(get('export-preview').textContent,/REPEAT FOREVER/);assert.match(get('export-state').textContent,/Compact target repetition/);
      get('download').onclick({});assert.ok(downloads.length>0);
      get('semantic-horizon').value='0.00001';get('semantic-horizon').oninput({});assert.equal(get('download').disabled,false);assert.doesNotMatch(get('export-preview').textContent,/REPEAT FOREVER/);
      assert.equal(get('source').value,source);assert.equal((context as any).WaveSemanticEditor.session.revision,revision);
    }
  }
});
