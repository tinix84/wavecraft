import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
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
  const sourceLabel=new Element(), downloads:Blob[]=[];
  const downloadUrl={createObjectURL:(blob:Blob)=>{downloads.push(blob);return 'blob:local-test';},revokeObjectURL:()=>{}};
  const context=vm.createContext({console,TextEncoder,TextDecoder,Blob,setTimeout,URL:downloadUrl,structuredClone,window:{},ResizeObserver:class{observe(){}},requestAnimationFrame:(fn:any)=>fn(),
    document:{getElementById:(id:string)=>elements.get(id),createElement:(tag:string)=>new Element(tag),createElementNS:(_:string,tag:string)=>new Element(tag,true),
      querySelector:()=>sourceLabel,querySelectorAll:(selector:string)=>selector==='[role=tab]'?[elements.get('edit-tab'),elements.get('trace-tab')]:[]}});
  for(const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) vm.runInContext(script[1],context);
  return {elements,context,html,downloads,get:(id:string)=>elements.get(id)!};
}


test('initial panel computes exact metrics without changing the editor or waveform export',async()=>{
  const {get,context,html}=await editor();
  assert.equal(get('spectrum-results').hidden,false);
  assert.match(get('spectrum-summary').textContent,/DC average: .* A · Total RMS: .* A · AC \/ ripple RMS: .* A/);
  assert.match(get('spectrum-warnings').textContent,/periodic extension/i);
  assert.equal(get('spectrum-table').children.length,10);
  assert.ok(get('spectrum-wave').children.length>0);
  const source=get('source').value, output=get('export-preview').textContent;
  get('spectrum-cutoff').value='250';get('spectrum-cutoff').oninput({});
  assert.equal(get('spectrum-results').hidden,true);
  assert.ok(Math.abs(Number(get('spectrum-tau').value)-1/(2*Math.PI*250))<1e-18);
  get('spectrum-analyze').onclick({});
  assert.match(get('spectrum-filter-summary').textContent,/fc 250 Hz/);
  assert.equal(get('source').value,source);assert.equal(get('export-preview').textContent,output);
  assert.equal((context as any).WaveSemanticEditor.session.revision,0);
  const baseline=await readFile(new URL('../../outputs/fft/baseline/wavecraft-web-prototype.before-fft.html',import.meta.url),'utf8');
  for(const regex of [/<style>[\s\S]*?<\/style>/,/<header>[\s\S]*?<\/header>/,/<script id="waveform-core">[\s\S]*?<\/script>/]) assert.equal(html.match(regex)![0],baseline.match(regex)![0]);
  // Phase 7 adds calibration and CSV controls inside the two existing trace panels.
  const trace=html.split('<section id="trace-panel"')[1].split('<footer')[0];
  for(const id of ['image-canvas','image-file','sample-image','cal-x0','cal-x1','cal-y0','cal-y1','anchor-low','anchor-high','trace-points','undo-trace','use-trace','landmark-tick','digitize-stage-csv'])assert.ok(trace.includes(`id="${id}"`));
  assert.equal((trace.match(/<section class="panel stack">/g)||[]).length,2);
  assert.match(html,/const pointProject=/);
});

test('point edits, source drafts, restore and shared history invalidate every displayed result',async()=>{
  const {get}=await editor();
  get('add').onclick({});assert.equal(get('spectrum-results').hidden,true);assert.equal(get('spectrum-csv').disabled,true);
  get('spectrum-analyze').onclick({});assert.equal(get('spectrum-results').hidden,false);
  get('source').value='{ invalid';get('source').oninput({});
  assert.equal(get('spectrum-results').hidden,true);assert.equal(get('spectrum-analyze').disabled,true);
  get('spectrum-analyze').onclick({});assert.equal(get('spectrum-results').hidden,true);
  get('discard-text').onclick({});assert.equal(get('spectrum-analyze').disabled,false);
  get('spectrum-analyze').onclick({});get('undo').onclick({});assert.equal(get('spectrum-results').hidden,true);
  get('spectrum-analyze').onclick({});get('redo').onclick({});assert.equal(get('spectrum-results').hidden,true);
  get('scenario-burst').onclick({});get('spectrum-analyze').onclick({});
  assert.match(get('spectrum-basis-info').textContent,/1 s/);assert.match(get('spectrum-summary').textContent,/0\.000004 A/);
  const source=get('source').value;
  get('spectrum-basis').value='pattern';get('spectrum-basis').onchange({});get('spectrum-analyze').onclick({});
  assert.match(get('spectrum-basis-info').textContent,/0\.000001 s/);assert.match(get('spectrum-summary').textContent,/0\.4 A/);assert.equal(get('source').value,source);
});

test('semantic full burst and inner pattern use complete compiled bases and display voltage units',async()=>{
  const {get,context}=await editor();
  get('semantic-sample').value='burst';get('semantic-load-sample').onclick({});
  assert.equal(get('spectrum-results').hidden,true);get('spectrum-analyze').onclick({});
  assert.match(get('spectrum-basis-info').textContent,/1 s/);assert.match(get('spectrum-summary').textContent,/0\.00003 A/);
  const source=get('source').value,session=(context as any).WaveSemanticEditor.session,revision=session.revision;
  get('spectrum-basis').value='pattern';get('spectrum-basis').onchange({});get('spectrum-analyze').onclick({});
  assert.match(get('spectrum-basis-info').textContent,/0\.000001 s/);assert.match(get('spectrum-summary').textContent,/DC average: 3 A/);
  assert.equal(get('source').value,source);assert.equal(session.revision,revision);
  get('semantic-sample').value='voltage';get('semantic-load-sample').onclick({});get('spectrum-basis').value='schedule';get('spectrum-basis').onchange({});get('spectrum-analyze').onclick({});
  assert.match(get('spectrum-summary').textContent,/ V/);assert.equal(get('spectrum-peak-heading').textContent,'Peak (V)');assert.equal(get('spectrum-rms-heading').textContent,'RMS (V)');
  const original=get('source').value;
  get('semantic-operation').value='target';get('semantic-operation').onchange({});
  get('semantic-selection').value='rise';get('semantic-selection').onchange({});
  get('semantic-value').value='12 V';get('semantic-value').oninput({});get('semantic-propose').onclick({});
  assert.equal(get('spectrum-results').hidden,false);assert.match(get('spectrum-status').textContent,/preview is not applied/);
  get('semantic-apply-edit').onclick({});assert.equal(get('spectrum-results').hidden,true);assert.notEqual(get('source').value,original);
  get('spectrum-analyze').onclick({});get('undo').onclick({});assert.equal(get('spectrum-results').hidden,true);
  get('spectrum-analyze').onclick({});get('redo').onclick({});assert.equal(get('spectrum-results').hidden,true);
  get('source').value=semanticSamples.voltage+'  invalid';get('source').oninput({});assert.equal(get('spectrum-analyze').disabled,true);
  get('discard-text').onclick({});get('source-mode').value='points';get('source-mode').onchange({});assert.equal(get('spectrum-results').hidden,true);
});

test('filter validation, reciprocal controls and real FFT remain read-only',async()=>{
  const {get}=await editor(),source=get('source').value,output=get('export-preview').textContent;
  get('spectrum-tau').value='0.002';get('spectrum-tau').oninput({});
  assert.ok(Math.abs(Number(get('spectrum-cutoff').value)-1/(2*Math.PI*.002))<1e-12);
  get('spectrum-analyze').onclick({});assert.match(get('spectrum-filter-summary').textContent,/τ 0\.002 s/);
  for(const value of ['0','-1','','NaN','1e999']) {
    get('spectrum-cutoff').value=value;get('spectrum-cutoff').oninput({});get('spectrum-analyze').onclick({});
    assert.equal(get('spectrum-results').hidden,true);assert.match(get('spectrum-status').textContent,/finite positive/);assert.equal(get('spectrum-csv').disabled,true);
  }
  (get('spectrum-filter') as any).checked=false;get('spectrum-filter').onchange({});
  get('spectrum-method').value='fft';get('spectrum-method').onchange({});get('spectrum-analyze').onclick({});
  assert.equal(get('spectrum-results').hidden,false);assert.match(get('spectrum-basis-info').textContent,/FFT numerical estimate/);assert.match(get('spectrum-basis-info').textContent,/samples · Sample rate .* Hz · Nyquist .* Hz/);
  get('spectrum-rows').value='20';get('spectrum-rows').onchange({});assert.equal(get('spectrum-table').children.length,20);
  get('spectrum-count').value='2049';get('spectrum-count').oninput({});get('spectrum-analyze').onclick({});assert.match(get('spectrum-status').textContent,/1 to 2048/);
  assert.equal(get('source').value,source);assert.equal(get('export-preview').textContent,output);
});

test('point repetition drafts block analysis until explicit application or restoration',async()=>{
  const {get}=await editor();get('scenario-burst').onclick({});get('spectrum-analyze').onclick({});
  const source=get('source').value;
  get('repeat-count').value='20';get('repeat-count').oninput({});assert.equal(get('spectrum-results').hidden,true);assert.equal(get('spectrum-analyze').disabled,true);
  assert.match(get('spectrum-status').textContent,/Repetition settings pending/);assert.equal(get('source').value,source);
  get('discard-text').onclick({});assert.equal(get('spectrum-analyze').disabled,false);assert.equal(Number(get('repeat-count').value),10);
  get('spectrum-analyze').onclick({});get('repeat-frequency').value='500000';get('repeat-frequency').oninput({});assert.equal(get('spectrum-analyze').disabled,true);
  assert.equal(Number(get('repeat-period').value),2);get('apply-repeat').onclick({});assert.equal(get('spectrum-analyze').disabled,false);
  get('spectrum-analyze').onclick({});assert.match(get('spectrum-basis-info').textContent,/1 s/);
  get('repeat-mode').value='periodic';get('repeat-mode').onchange({});assert.equal(get('spectrum-analyze').disabled,true);
});

test('native point drag and asynchronous project open invalidate results after source commits',async()=>{
  const {get}=await editor(),svg=get('plot'),original=get('source').value;
  const hit=svg.children.find(child=>child.getAttribute('data-point')==='2')!;
  hit.dispatch('pointerdown',{pointerId:1,preventDefault(){}});
  svg.dispatch('pointermove',{pointerId:1,clientX:62+18.2/135.68*614,clientY:312-(120+21.6)/223.2*292});
  assert.equal(get('source').value,original);assert.equal(get('spectrum-results').hidden,false);
  svg.dispatch('pointerup',{pointerId:1});assert.notEqual(get('source').value,original);assert.equal(get('spectrum-results').hidden,true);
  get('spectrum-analyze').onclick({});
  const project={version:1,name:'Opened constant',units:{time:'us',current:'A'},points:[[0,-3],[100,-3]],maxSlew:null};
  get('open-file').files=[{name:'constant.json',text:async()=>JSON.stringify(project)}];
  await get('open-file').onchange({target:get('open-file')});assert.equal(get('spectrum-results').hidden,false);
  get('project-accept').onclick({});assert.equal(get('spectrum-results').hidden,true);
  get('spectrum-analyze').onclick({});assert.match(get('spectrum-summary').textContent,/DC average: -3 A · Total RMS: 3 A · AC \/ ripple RMS: 0 A/);
  assert.match(get('spectrum-basis-info').textContent,/No nonzero AC component/);
});

test('spectrum CSV uses a separate schema and leaves waveform exports unchanged',async()=>{
  const {get,downloads}=await editor(),source=get('source').value,output=get('export-preview').textContent;
  get('spectrum-csv').onclick({});assert.equal(downloads.length,1);
  const csv=await downloads[0].text();assert.match(csv,/# Spectrum analysis only/);assert.match(csv,/order,frequency_Hz,peak_A,rms_A,phase_rad,filter_gain,filtered_peak_A/);
  assert.equal(get('source').value,source);assert.equal(get('export-preview').textContent,output);
  get('spectrum-cutoff').value='3e307';get('spectrum-cutoff').oninput({});assert.ok(Number(get('spectrum-tau').value)>0);get('spectrum-analyze').onclick({});assert.equal(get('spectrum-results').hidden,false);
});
