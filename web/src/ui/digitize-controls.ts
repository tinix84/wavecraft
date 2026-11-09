import { candidateSource, checkCalibration, correctedPointsSI, rawPointsSI, sealExtraction, siToPixel, viewToOriginal } from '../digitize/index.ts';
import type { Calibration, Digitization, Extraction, ImageView, Pair, Units } from '../digitize/index.ts';
import type { ProjectEvidence } from '../project/index.ts';

type TraceHost = {
  traceView(): ImageView; traceReady(): Promise<void>; traceImageKey(): string;
  traceHasImage(): boolean; traceDraw(legacy?:boolean): void; traceRecord(pixels: Pair[]): void;
  traceLegacy():{present:boolean,pixels:Pair[]};
  evidence():Promise<ProjectEvidence>;prepareEvidence(evidence:ProjectEvidence):Promise<any>;installEvidence(evidence:ProjectEvidence,decoded:any):void;
};
type Editor = { trace?: TraceHost; key(): string; dirty(): boolean; changed(): void; commit(source:string,notes:string):void|Promise<void> };
function copy<T>(value:T):T {
  if(value instanceof Uint8Array)return new Uint8Array(value) as T;
  if(Array.isArray(value))return Array.from(value,item=>copy(item)) as T;
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,copy(item)])) as T;
  return value;
}
const show = (value:number) => Number.isFinite(value)?Number(value.toPrecision(9)).toString():String(value);

// Extraction coordinates always use original image pixels. CSS zoom changes only the view.
export function mountDigitizeControls(editor:Editor) {
  const $=(id:string)=>document.getElementById(id) as any;
  if(!$('digitize-stage-image') || !editor.trace)return;
  const host=editor.trace,canvas=$('image-canvas'),ctx=canvas.getContext('2d');
  const unitFields=['digitize-dimension','digitize-time-unit','digitize-value-unit','digitize-axes'];
  const calibrationFields=['cal-x0','cal-x1','cal-y0','cal-y1','digitize-tick-axis','digitize-tick-value','digitize-tick-tolerance'];
  const csvFields=['digitize-csv-text','digitize-delimiter','digitize-decimal','digitize-header','digitize-x-column','digitize-y-column','digitize-map-confirm'];
  for(const [id,value] of Object.entries({'digitize-dimension':'current','digitize-time-unit':'us','digitize-value-unit':'A','digitize-axes':'linear','digitize-tick-axis':'x','digitize-zoom':'1','digitize-delimiter':',','digitize-decimal':'.','digitize-header':'yes'}))$(id).value ||= value;
  let marks:Partial<Record<'x0'|'x1'|'y0'|'y1'|'tick',Pair>>={},pixels:Pair[]=[],marking='',csvName='pasted-data.csv';
  let independent=new Set<string>(),corners:Partial<Record<'low'|'high',Pair>>={};
  let originalCsv:{text:string,display:string}|undefined;
  let record:Digitization|undefined,stageKey:string|undefined,stale=false,readGeneration=0,legacy=false;
  let committedRecord:Digitization|undefined,committedHost:ProjectEvidence|undefined;
  const message=(text:string,error=false)=>{$('trace-message').textContent=text;$('trace-message').className='notice '+(error?'error':'ok');};
  function imageRect() {
    const rect=canvas.getBoundingClientRect(),style=typeof getComputedStyle==='function'?getComputedStyle(canvas):undefined;
    const value=(name:string)=>parseFloat((style as any)?.[name]||'0')||0,sx=canvas.offsetWidth?rect.width/canvas.offsetWidth:1,sy=canvas.offsetHeight?rect.height/canvas.offsetHeight:1;
    const left=(value('borderLeftWidth')+value('paddingLeft'))*sx,right=(value('borderRightWidth')+value('paddingRight'))*sx,top=(value('borderTopWidth')+value('paddingTop'))*sy,bottom=(value('borderBottomWidth')+value('paddingBottom'))*sy;
    return {left:rect.left+left,top:rect.top+top,width:rect.width-left-right,height:rect.height-top-bottom};
  }
  function numeric(id:string) {const raw=$(id).value.trim(),value=Number(raw);if(!raw||!Number.isFinite(value))throw Error('Enter a finite number for '+id+'.');return value;}
  function units():Units {return {dimension:$('digitize-dimension').value,timeUnit:$('digitize-time-unit').value,valueUnit:$('digitize-value-unit').value};}
  function calibration():Calibration {
    if($('digitize-axes').value!=='linear')throw Error('Logarithmic and rotated axes are unsupported. Use external CSV with explicit units.');
    if(!marks.x0||!marks.x1||!marks.y0||!marks.y1||!marks.tick)throw Error('Mark four axis landmarks and an independent unused tick.');
    if(independent.size<4&&(!corners.low||!corners.high))throw Error('Mark all four axis landmarks, or both corners of a clearly rectangular plot.');
    return {...units(),axes:'linear',rotation:'axis-aligned',...(independent.size===4?{method:'four-landmarks' as const}:{method:'two-corners' as const,originalCorners:[corners.low!,corners.high!] as [Pair,Pair]}),x:[{pixel:marks.x0,value:numeric('cal-x0')},{pixel:marks.x1,value:numeric('cal-x1')}],y:[{pixel:marks.y0,value:numeric('cal-y0')},{pixel:marks.y1,value:numeric('cal-y1')}],tick:{axis:$('digitize-tick-axis').value,pixel:marks.tick,value:numeric('digitize-tick-value'),tolerance:numeric('digitize-tick-tolerance')}};
  }
  function measureView() {const rect=imageRect();if(record&&rect.width>0&&rect.height>0)record.view={zoom:Number($('digitize-zoom').value)||1,displaySize:[rect.width,rect.height]};}
  function changed(review=true) {if(review){$('digitize-overlay-review').checked=false;$('digitize-initial-hold').checked=false;$('digitize-finite-edges').checked=false;if(record?.initialHoldConfirmed!==undefined)record.initialHoldConfirmed=false;if(record?.finiteEdgesConfirmed!==undefined)record.finiteEdgesConfirmed=false;}render();editor.changed();}
  function lock() {for(const id of [...unitFields,...calibrationFields,...csvFields])$(id).disabled=!!record||legacy;for(const id of ['landmark-x0','landmark-x1','landmark-y0','landmark-y1','landmark-tick','anchor-low','anchor-high','undo-trace'])$(id).disabled=!!record||legacy;for(const id of ['sample-image','image-file'])$(id).disabled=record?.extraction.kind==='image'||legacy;}
  function svg(tag:string,attrs:Record<string,any>,text?:string) {const el=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [name,value]of Object.entries(attrs))el.setAttribute(name,String(value));if(text!==undefined)el.textContent=text;$('digitize-overlay').appendChild(el);}
  function overlay(raw:Pair[],corrected:Pair[]) {
    $('digitize-overlay').replaceChildren();
    const held:Pair[]=corrected[0]?.[0]>0?[[0,corrected[0][1]],...corrected]:corrected;
    const finite=[...raw,...held].filter(p=>p.every(Number.isFinite));if(!finite.length)return;
    const xs=finite.map(p=>p[0]),ys=finite.map(p=>p[1]),loX=Math.min(...xs),hiX=Math.max(...xs),loY=Math.min(...ys),hiY=Math.max(...ys);
    const x=(n:number)=>55+(n-loX)/(hiX-loX||1)*620,y=(n:number)=>215-(n-loY)/(hiY-loY||1)*185;
    for(const [points,color,dash,label]of [[raw,'#737b82','6 4','Raw'],[held,'#007c75','','Corrected']] as const){
      svg('path',{d:points.filter(p=>p.every(Number.isFinite)).map((p,i)=>`${i?'L':'M'}${x(p[0])} ${y(p[1])}`).join(' '),fill:'none',stroke:color,'stroke-width':2,'stroke-dasharray':dash,'aria-label':label});
      for(const p of points.filter(p=>p.every(Number.isFinite)))svg('circle',{cx:x(p[0]),cy:y(p[1]),r:3,fill:color});
    }
    svg('text',{x:55,y:247,'font-size':12},`${show(loX)} → ${show(hiX)} s`);svg('text',{x:55,y:18,'font-size':12},`${show(loY)} → ${show(hiY)} ${record?.extraction.kind==='image'?record.extraction.calibration.dimension==='voltage'?'V':'A':record?.extraction.mapping.dimension==='voltage'?'V':'A'} · gray: raw · teal: corrected`);
  }
  function finiteEdges() {
    if(!record)return [];
    const raw=rawPointsSI(record.extraction),corrected=correctedPointsSI(record);
    return raw.flatMap((p,i)=>i>0&&p[0]<=raw[i-1][0]&&p[1]!==raw[i-1][1]?[`Points ${i} → ${i+1}: assumed finite edge duration ${show(corrected[i][0]-corrected[i-1][0])} s. ${record!.corrections.filter(c=>c.index===i||c.index===i-1).map(c=>c.note).join(' ')}`]:[]);
  }
  function rectangleAssumption(){return record?.extraction.kind==='image'&&record.extraction.calibration.method==='two-corners'?'Rectangular plot assumption: two original corner clicks define four axis-aligned landmark locations.':'';}
  function drawImage() {
    host.traceDraw(legacy);if(legacy)return;
    const view=host.traceView(),crop=view.crop||[0,0,...view.originalSize];
    // Canvas clips off-crop evidence. The original points stay unchanged.
    const project=(p:Pair):Pair=>[(p[0]-crop[0])/crop[2]*view.viewSize[0],(p[1]-crop[1])/crop[3]*view.viewSize[1]];
    const draw=(points:Pair[],color:string,dash:number[])=>{
      ctx.save();ctx.strokeStyle=color;ctx.lineWidth=2;ctx.setLineDash(dash);ctx.beginPath();points.forEach((p,i)=>{const v=project(p);i?ctx.lineTo(...v):ctx.moveTo(...v);});ctx.stroke();ctx.setLineDash([]);for(const p of points){const v=project(p);ctx.beginPath();ctx.arc(...v,4,0,Math.PI*2);ctx.stroke();}ctx.restore();
    };
    const source=record?.extraction.kind==='image'?record.extraction.pixels:pixels;draw(source,'#737b82',[5,4]);
    if(record?.extraction.kind==='image')try{draw(correctedPointsSI(record).map(p=>siToPixel(p,record!.extraction.kind==='image'?record!.extraction.calibration:calibration())),'#007c75',[]);}catch{}
    for(const [name,p]of Object.entries(marks)){const v=project(p);ctx.fillStyle='#b32e22';ctx.fillText(name,...[v[0]+7,v[1]-7]);ctx.strokeStyle='#b32e22';ctx.beginPath();ctx.moveTo(v[0]-7,v[1]);ctx.lineTo(v[0]+7,v[1]);ctx.moveTo(v[0],v[1]-7);ctx.lineTo(v[0],v[1]+7);ctx.stroke();}
  }
  function render() {
    lock();drawImage();
    $('digitize-landmarks').textContent=[...Object.entries(marks).map(([name,p])=>`${name}: original pixel (${show(p[0])}, ${show(p[1])})`),...Object.entries(corners).map(([name,p])=>`${name} original corner click: (${show(p[0])}, ${show(p[1])})`),...(independent.size===4?['Method: four independent axis landmarks.']:corners.low&&corners.high?['Method: two-corner rectangular plot assumption.']:[])].join('\n')||'No landmarks marked.';
    let diagnostic='Mark four axis landmarks and an unused tick.';
    try{const cal=record?.extraction.kind==='image'?record.extraction.calibration:calibration(),checked=checkCalibration(cal),unit=cal.tick.axis==='x'?cal.timeUnit:cal.valueUnit;diagnostic=`Unused tick: labeled ${show(cal.tick.value)} ${unit}; predicted ${show(checked.predicted)} ${unit}; error ${show(checked.error)} ${unit}; tolerance ${show(cal.tick.tolerance)} ${unit}. ${checked.passed?'PASS':'FAIL — correct the calibration.'}`;}catch(error){diagnostic=(error as Error).message;}
    if(record?.extraction.kind==='csv')diagnostic='External CSV: pixel calibration is unavailable. The confirmed mapping supplies the units.';
    if(legacy)diagnostic='Legacy image evidence has no verified independent tick. Start a new extraction to calibrate and trace again.';
    $('cal-status').textContent=marking?'Click the '+marking+' landmark in the image.':diagnostic;
    if(record){
      try{
        const raw=rawPointsSI(record.extraction),corrected=correctedPointsSI(record);overlay(raw,corrected);
        $('digitize-initial-hold-field').hidden=!(corrected[0]?.[0]>0);
        $('digitize-finite-edges-field').hidden=!finiteEdges().length;
        const selected=$('digitize-point').value;$('digitize-point').replaceChildren();
        corrected.forEach((p,index)=>{const option=document.createElement('option');option.value=String(index);option.textContent=`${index+1}. ${show(p[0])} s, ${show(p[1])} ${units().dimension==='voltage'?'V':'A'}`;$('digitize-point').appendChild(option);});$('digitize-point').value=selected&&Number(selected)<corrected.length?selected:'0';
        const faults=raw.flatMap((p,index)=>!p.every(Number.isFinite)||p[0]<0||index>0&&p[0]<=raw[index-1][0]?[`Raw point ${index+1}: ${!p.every(Number.isFinite)?'nonfinite value':p[0]<0?'negative time':'duplicate or backward time'}. Record an explicit correction.`]:[]);
        $('trace-points').textContent=raw.map((p,i)=>`${i+1}. raw ${show(p[0])} s, ${show(p[1])}; corrected ${show(corrected[i][0])} s, ${show(corrected[i][1])}`).join('\n');
        $('digitize-overlay-notes').textContent=[...faults,...record.corrections.map(c=>`Point ${c.index+1}: ${c.note}`),...finiteEdges(),rectangleAssumption(),record.assumptions?`Assumptions: ${record.assumptions}`:'Record the engineering assumptions.',...(corrected[0]?.[0]>0?[`Initial hold: the first level extends from 0 to ${show(corrected[0][0])} s. Confirm this assumption or correct the first time to zero.`]:[])].filter(Boolean).join('\n');
      }catch(error){$('digitize-overlay-notes').textContent=(error as Error).message;}
    }else{$('digitize-initial-hold-field').hidden=$('digitize-finite-edges-field').hidden=true;const raw=legacy?host.traceLegacy().pixels:pixels;$('trace-points').textContent=raw.length?(legacy?'Legacy raw clicks · calibration unverified.\n':'')+raw.map((p,i)=>`${i+1}. original pixel (${show(p[0])}, ${show(p[1])})`).join('\n'):'No points yet.';$('digitize-overlay').replaceChildren();$('digitize-overlay-notes').textContent=legacy?'Legacy raw clicks remain unchanged. Start a new extraction before replacing them.':'Stage a trace or CSV to compare the points.';}
    $('trace-points').style.whiteSpace=$('digitize-overlay-notes').style.whiteSpace='pre-line';
    let acceptable=!!record&&stageKey!==undefined&&!stale&&!editor.dirty()&&!!$('digitize-overlay-review').checked;
    if(acceptable)try{candidateSource(record!);}catch{acceptable=false;}
    $('use-trace').disabled=!acceptable;
  }
  function stage(extraction?:Extraction) {
    if(legacy)throw Error('Start a new extraction before replacing the legacy image evidence.');
    if(editor.dirty())throw Error('Apply or restore source and repetition drafts before staging a reconstruction.');
    if(extraction){if(record)throw Error('Start a new extraction before replacing the original evidence.');record={extraction:sealExtraction(extraction),corrections:[],assumptions:$('digitize-assumptions').value};const provenance=Object.fromEntries(['article','page','figure','series','notes'].map(name=>[name,$('digitize-'+name).value]).filter(([,value])=>value));if(Object.keys(provenance).length)record.provenance=provenance;}
    if(!record)throw Error('Stage an image trace or a CSV first.');
    measureView();stageKey=editor.key();stale=false;$('digitize-overlay-review').checked=false;render();selectPoint();editor.changed();
    message('Reconstruction staged. Inspect the raw and corrected overlay, record assumptions, then accept.');
  }
  function attempt(action:()=>void|Promise<void>) {try{const pending=action();if(pending&&typeof pending.then==='function')return pending.catch(error=>message(error.message,true));}catch(error){message((error as Error).message,true);}}
  function mark(name:string){if(record||legacy){message('The original extraction is sealed. Start a new extraction to mark new landmarks.',true);return;}marking=name;render();}
  for(const name of ['x0','x1','y0','y1','tick'])$('landmark-'+name).onclick=()=>mark(name);
  $('anchor-low').onclick=()=>mark('low');$('anchor-high').onclick=()=>mark('high');
  canvas.onclick=(event:any)=>attempt(()=>{
    if(record||legacy)throw Error('The original extraction is sealed. Use the point correction controls or start a new extraction.');
    const rect=imageRect(),view=host.traceView(),pixel=viewToOriginal([(event.clientX-rect.left)*canvas.width/rect.width,(event.clientY-rect.top)*canvas.height/rect.height],view);
    if(marking==='low'){independent.clear();corners.low=copy(pixel);marks.x0=pixel;marks.y0=copy(pixel);if(corners.high){marks.x1=[corners.high[0],pixel[1]];marks.y1=[pixel[0],corners.high[1]];}}else if(marking==='high'){independent.clear();corners.high=copy(pixel);marks.x1=[pixel[0],marks.x0?.[1]??pixel[1]];marks.y1=[marks.y0?.[0]??pixel[0],pixel[1]];}
    else if(marking){marks[marking as keyof typeof marks]=pixel;if(marking!=='tick')independent.add(marking);}
    else {pixels.push(pixel);host.traceRecord(pixels);message('Original point recorded. Its order and pixels stay unchanged.');}
    marking='';changed();
  });
  $('undo-trace').onclick=()=>{if(!record&&!legacy){pixels.pop();host.traceRecord(pixels);changed();}};
  for(const id of [...unitFields,...calibrationFields,...csvFields])$(id)[id==='digitize-csv-text'||id.startsWith('cal-')||id.includes('column')||id==='digitize-tick-value'||id==='digitize-tick-tolerance'?'oninput':'onchange']=()=>{++readGeneration;if(id==='digitize-csv-text'){originalCsv=undefined;csvName='pasted-data.csv';}if(id!=='digitize-map-confirm'&&(unitFields.includes(id)||csvFields.includes(id)))$('digitize-map-confirm').checked=false;changed();};
  $('digitize-stage-image').onclick=()=>attempt(async()=>{
    const ticket=++readGeneration,key=editor.key(),image=host.traceImageKey();await host.traceReady();
    if(ticket!==readGeneration||key!==editor.key()||image!==host.traceImageKey())throw Error('The image or source changed during capture. Stage it again.');
    if(!host.traceHasImage())throw Error('Load a source image or the sample figure before staging.');
    stage({kind:'image',size:copy(host.traceView().originalSize),calibration:calibration(),pixels:copy(pixels)});
  });
  $('digitize-stage-csv').onclick=()=>attempt(()=>{
    if(!$('digitize-map-confirm').checked)throw Error('Confirm the CSV columns, units, delimiter, decimal separator, and header setting.');
    stage({kind:'csv',name:csvName,text:originalCsv&&originalCsv.display===$('digitize-csv-text').value?originalCsv.text:$('digitize-csv-text').value,mapping:{...units(),delimiter:$('digitize-delimiter').value==='tab'?'\t':$('digitize-delimiter').value,decimal:$('digitize-decimal').value,header:$('digitize-header').value==='yes',xColumn:numeric('digitize-x-column')-1,yColumn:numeric('digitize-y-column')-1,confirmed:true}});
  });
  $('digitize-csv-file').onchange=async(event:any)=>{
    const file=event.target.files[0];if(!file)return;const ticket=++readGeneration,key=editor.key();
    try{if(record)throw Error('Start a new extraction before replacing the original CSV.');if(file.size>1024*1024)throw Error('The CSV exceeds 1 MiB.');const bytes=new Uint8Array(await file.arrayBuffer());if(bytes.length>1024*1024)throw Error('The CSV exceeds 1 MiB.');const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);if(ticket!==readGeneration)return;if(key!==editor.key())throw Error('The project changed while reading the CSV. Open it again.');$('digitize-csv-text').value=text;originalCsv={text,display:$('digitize-csv-text').value};csvName=file.name;$('digitize-map-confirm').checked=false;changed();message('CSV loaded locally. Confirm its mapping before staging.');}catch(error){if(ticket===readGeneration)message((error as Error).message,true);}finally{event.target.value='';}
  };
  function selectPoint(){if(!record)return;const index=Number($('digitize-point').value),point=correctedPointsSI(record)[index];if(!point)return;$('digitize-point-time').value=String(point[0]);$('digitize-point-value').value=String(point[1]);$('digitize-point-reason').value=record.corrections.find(c=>c.index===index)?.note||'';}
  $('digitize-point').onchange=selectPoint;
  $('digitize-correct').onclick=()=>attempt(()=>{if(!record)throw Error('Stage the original evidence first.');const index=Number($('digitize-point').value),note=$('digitize-point-reason').value.trim();if(!note)throw Error('Enter a reason for this point correction.');const correction={index,point:[numeric('digitize-point-time'),numeric('digitize-point-value')] as Pair,note};record.corrections=record.corrections.filter(c=>c.index!==index).concat(correction);changed();message('Point correction recorded. Review the raw and corrected overlay again.');});
  for(const name of ['assumptions','article','page','figure','series','notes'])$('digitize-'+name).oninput=()=>{if(record){if(name==='assumptions')record.assumptions=$('digitize-'+name).value;else record.provenance={...record.provenance,[name]:$('digitize-'+name).value};}changed();};
  $('digitize-overlay-review').onchange=()=>render();
  for(const [id,key]of [['digitize-initial-hold','initialHoldConfirmed'],['digitize-finite-edges','finiteEdgesConfirmed']] as const)$(id).onchange=()=>{if(record)record[key]=!!$(id).checked;$('digitize-overlay-review').checked=false;render();editor.changed();};
  $('digitize-restage').onclick=()=>attempt(()=>stage());
  $('use-trace').onclick=()=>attempt(async()=>{
    if(editor.dirty())throw Error('Apply or restore source and repetition drafts before accepting a reconstruction.');
    if(!record||stageKey===undefined)throw Error('Stage a reconstruction before acceptance.');
    if(stale||stageKey!==editor.key())throw Error('This reconstruction preview is stale. Review the staged reconstruction again.');
    if(!$('digitize-overlay-review').checked)throw Error('Review the raw and corrected overlay before acceptance.');
    const candidate=candidateSource(record),points=correctedPointsSI(record),notes=['Reconstruction assumptions: '+record.assumptions,rectangleAssumption(),...finiteEdges(),...(points[0][0]>0?[`Confirmed initial hold: 0 to ${show(points[0][0])} s at ${show(points[0][1])} ${record.extraction.kind==='image'?record.extraction.calibration.dimension==='voltage'?'V':'A':record.extraction.mapping.dimension==='voltage'?'V':'A'}.`]:[]),...Object.entries(record.provenance||{}).filter(([,value])=>value).map(([key,value])=>`${key}: ${value}`),...record.corrections.map(c=>`Point ${c.index+1} correction: ${c.note}`)].filter(Boolean).join('\n');
    await editor.commit(candidate.source,notes);stageKey=undefined;render();editor.changed();message('Reconstruction accepted. The original extraction and correction reasons remain in the project.');
  });
  function reset(){record=undefined;legacy=false;stageKey=undefined;stale=false;marks={};independent.clear();corners={};pixels=[];marking='';originalCsv=undefined;csvName='pasted-data.csv';++readGeneration;for(const id of ['digitize-overlay-review','digitize-initial-hold','digitize-finite-edges','digitize-map-confirm'])$(id).checked=false;for(const name of ['assumptions','article','page','figure','series','notes','csv-text','point-time','point-value','point-reason'])$('digitize-'+name).value='';render();editor.changed();}
  $('digitize-new').onclick=()=>{reset();host.traceRecord([]);message('New extraction started. Load its image or paste its CSV.');};
  for(const id of ['sample-image','image-file']){const name=id==='image-file'?'onchange':'onclick',handler=$(id)[name];$(id)[name]=async function(event:any){if(record?.extraction.kind==='image'||legacy){message('Start a new extraction before replacing the original image.',true);return;}const before=host.traceImageKey();await handler?.call(this,event);if(before!==host.traceImageKey()){if(record){stale=true;$('digitize-overlay-review').checked=false;editor.changed();}else reset();}render();};}
  $('digitize-zoom').onchange=()=>{const zoom=Number($('digitize-zoom').value)||1;canvas.style.width=zoom*100+'%';canvas.style.maxWidth='none';measureView();changed();};
  if(typeof ResizeObserver!=='undefined')new ResizeObserver(()=>drawImage()).observe(canvas);
  render();
  const controls={
    reserveCSVOffer(){const ticket=++readGeneration;return {current:()=>ticket===readGeneration};},
    offerCSV(text:string,name:string,ticket?:{current():boolean}){
      if(ticket&&!ticket.current())throw Error('The CSV candidate changed during reading. Open the file again.');
      if(editor.dirty())throw Error('Apply or restore source and repetition drafts before opening a CSV candidate.');
      if(new TextEncoder().encode(text).length>1024*1024)throw Error('The CSV exceeds 1 MiB.');
      reset();
      for(const [id,value]of Object.entries({'digitize-dimension':'current','digitize-time-unit':'s','digitize-value-unit':'A','digitize-delimiter':',','digitize-decimal':'.','digitize-header':'yes','digitize-x-column':'1','digitize-y-column':'2'}))$(id).value=value;
      $('digitize-csv-text').value=text;originalCsv={text,display:$('digitize-csv-text').value};csvName=name;$('digitize-map-confirm').checked=false;
      $('trace-tab').onclick?.call($('trace-tab'),{target:$('trace-tab')});$('digitize-csv-details').open=true;changed();$('digitize-csv-text').focus?.();
      message('CSV candidate loaded locally. Confirm the columns and units before staging. The active source and accepted evidence stay unchanged.');
    },
    invalidate(){++readGeneration;if(stageKey!==undefined){stale=true;$('digitize-overlay-review').checked=false;render();}},
    key:()=>committedRecord?JSON.stringify(committedRecord):'',
    candidateKey:()=>record?JSON.stringify(record):'',
    evidence:()=>committedRecord?{digitization:copy(committedRecord)}:{},
    hostEvidence:()=>committedHost?copy(committedHost):undefined,
    candidateEvidence:()=>record?{digitization:copy(record)}:{},
    adopt(evidence:ProjectEvidence){committedRecord=record?copy(record):undefined;committedHost=copy(evidence);},
    install(value?:Digitization,evidence?:ProjectEvidence){++readGeneration;committedRecord=value?copy(value):undefined;committedHost=evidence?copy(evidence):undefined;record=value?{...copy(value),extraction:sealExtraction(value.extraction)}:undefined;legacy=!record&&host.traceLegacy().present;stageKey=undefined;stale=false;marks={};independent.clear();corners={};pixels=[];originalCsv=undefined;
      csvName='pasted-data.csv';for(const id of ['digitize-overlay-review','digitize-initial-hold','digitize-finite-edges','digitize-map-confirm'])$(id).checked=false;for(const name of ['assumptions','article','page','figure','series','notes','csv-text','point-time','point-value','point-reason'])$('digitize-'+name).value='';
      if(!record)for(const [id,value]of Object.entries({'digitize-dimension':'current','digitize-time-unit':'us','digitize-value-unit':'A','digitize-axes':'linear'}))$(id).value=value;
      $('digitize-zoom').value=String(record?.view?.zoom||1);
      if(record){const extraction=record.extraction,u=extraction.kind==='image'?extraction.calibration:extraction.mapping;for(const [id,value]of Object.entries({'digitize-dimension':u.dimension,'digitize-time-unit':u.timeUnit,'digitize-value-unit':u.valueUnit,'digitize-assumptions':record.assumptions,'digitize-zoom':String(record.view?.zoom||1)}))$(id).value=value;
        if(extraction.kind==='image'){const c=extraction.calibration;marks={x0:copy(c.x[0].pixel),x1:copy(c.x[1].pixel),y0:copy(c.y[0].pixel),y1:copy(c.y[1].pixel),tick:copy(c.tick.pixel)};if(c.method==='two-corners'&&c.originalCorners)corners={low:copy(c.originalCorners[0]),high:copy(c.originalCorners[1])};else independent=new Set(['x0','x1','y0','y1']);for(const [id,value]of Object.entries({'cal-x0':c.x[0].value,'cal-x1':c.x[1].value,'cal-y0':c.y[0].value,'cal-y1':c.y[1].value,'digitize-tick-value':c.tick.value,'digitize-tick-tolerance':c.tick.tolerance,'digitize-tick-axis':c.tick.axis}))$(id).value=String(value);pixels=copy(extraction.pixels);}
        else{const m=extraction.mapping;csvName=extraction.name;$('digitize-csv-text').value=extraction.text;for(const [id,value]of Object.entries({'digitize-delimiter':m.delimiter==='\t'?'tab':m.delimiter,'digitize-decimal':m.decimal,'digitize-header':m.header?'yes':'no','digitize-x-column':m.xColumn+1,'digitize-y-column':m.yColumn+1}))$(id).value=String(value);$('digitize-map-confirm').checked=true;}
      }
      for(const name of ['article','page','figure','series','notes'])$('digitize-'+name).value=record?.provenance?.[name as keyof NonNullable<Digitization['provenance']>]||'';
      $('digitize-assumptions').value=record?.assumptions||'';$('digitize-overlay-review').checked=false;canvas.style.width=(record?.view?.zoom||1)*100+'%';render();selectPoint();
      $('digitize-initial-hold').checked=!!record?.initialHoldConfirmed;$('digitize-finite-edges').checked=!!record?.finiteEdgesConfirmed;
    },
    get record(){return record?copy(record):undefined;}
  };
  $('digitize-cancel').onclick=()=>attempt(async()=>{if(!committedHost){reset();message('Reconstruction candidate canceled. The active waveform stays unchanged.');return;}const ticket=++readGeneration,base=copy(committedHost),decoded=await host.prepareEvidence(base);if(ticket!==readGeneration)throw Error('The reconstruction changed during cancellation. Cancel it again.');host.installEvidence(base,decoded);controls.install(committedRecord,base);editor.changed();message('Reconstruction candidate canceled. The accepted source and evidence stay unchanged.');});
  return controls;
}
