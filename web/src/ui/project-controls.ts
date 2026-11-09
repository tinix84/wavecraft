import { packProject, unpackProject, readProjectRecovery, writeProjectRecovery } from '../project/index.ts';
import type { ProjectSnapshot, RecoveryDraft } from '../project/index.ts';

export interface ProjectEditor {
  key(): string;
  dirty(): boolean;
  snapshot(revisionId: string): Promise<ProjectSnapshot>;
  draft(): RecoveryDraft;
  prepare(snapshot: ProjectSnapshot): Promise<() => void>;
  restoreDraft(draft: RecoveryDraft): void;
}

// File.arrayBuffer and Blob object URLs retain imported bytes.
// https://developer.mozilla.org/en-US/docs/Web/API/Blob/arrayBuffer
export function mountProjectControls(editor: ProjectEditor) {
  const $ = (id:string) => document.getElementById(id) as any;
  if (!$('project-save')) return;
  let sequence = 0, generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let queue = Promise.resolve(), ready = false, unresolved = false, head: string | null = null;
  let savedKey = '', recovery: Awaited<ReturnType<typeof readProjectRecovery>>;
  let storageFailure='';
  const initialKey=editor.key();
  let observedKey=initialKey;
  let candidate: {snapshot:ProjectSnapshot, apply:()=>void, key:string, generation:number} | undefined;
  const message = (id:string,text:string,error=false) => { $(id).textContent=text; $(id).className='notice '+(error?'error':'ok'); };
  const revision = () => `editor-${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2)}`;
  const denied = () => !!$('recovery-denied')?.checked;
  function refresh() {
    $('project-save').disabled = editor.dirty();
    $('project-accept').disabled = !candidate || candidate.generation!==generation || editor.dirty();
  }
  async function capture() {
    const key=editor.key(), draft=structuredClone(editor.draft()), snapshot=await editor.snapshot(revision());
    if (key!==editor.key()) throw Error('The project changed during capture. Try again.');
    return {key,draft,snapshot};
  }
  function persist(explicit=false) {
    queue=queue.then(async()=>{
      if(!ready || unresolved) {if(explicit)message('recovery-state','Resolve the recovery offer before saving recovery.',true);return;}
      const record=await capture();
      if(!explicit && record.key===savedKey)return;
      const result=await writeProjectRecovery(record.snapshot,record.draft,{expectedHead:head,denied:denied()});
      head=result.snapshot.revisionId;savedKey=record.key;storageFailure='';
      message('recovery-state',record.key===editor.key()?'Browser recovery saved. Download a project ZIP for a portable backup.':'An earlier revision is saved. Newer changes are pending browser recovery.');
    }).catch(error=>{storageFailure=`Browser recovery unavailable: ${error.message} Project ZIP save and open remain available.`;message('recovery-state',storageFailure,true);});
    return queue;
  }
  function changed() {
    const currentKey=editor.key();
    if(currentKey!==observedKey){observedKey=currentKey;++generation;if(candidate)message('project-state','This preview is stale. Open the project again.',true);}
    refresh();
    if(ready && !unresolved && savedKey!==editor.key() && !storageFailure)message('recovery-state','Changes are pending browser recovery. Download a project ZIP for a portable backup.');
    if(timer && typeof clearTimeout==='function')clearTimeout(timer);
    if(ready && !unresolved)timer=setTimeout(()=>persist(),350);
  }
  $('project-save').onclick=async()=>{
    try {
      if(editor.dirty())throw Error('Apply or restore source and repetition drafts before saving a project ZIP.');
      const {snapshot}=await capture(), bytes=packProject(snapshot);
      const blob=new Blob([bytes],{type:'application/zip'}), url=URL.createObjectURL(blob), link=document.createElement('a');
      link.href=url;link.download='wavecraft-project.zip';link.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
      message('project-state',`Project ZIP download started (${snapshot.mode} mode). It contains committed source and available evidence. Unapplied edit previews are excluded.`);
    }catch(error){message('project-state',(error as Error).message,true);}
  };
  async function preview(snapshot:ProjectSnapshot,label:string,ticket=++generation,key=editor.key()) {
    candidate=undefined;refresh();
    const apply=await editor.prepare(snapshot);
    if(ticket!==generation)return;
    if(key!==editor.key())throw Error('The project changed while opening the file. Open it again.');
    candidate={snapshot,apply,key,generation:ticket};$('project-preview').hidden=false;
    const evidence=snapshot.evidence;
    $('project-preview-text').textContent=`${label}\nRevision: ${snapshot.revisionId}\nMode: ${snapshot.mode}\nSource: ${new TextEncoder().encode(snapshot.source).length} UTF-8 bytes\nImage: ${evidence.image ? `${evidence.image.name} (${evidence.image.bytes.length} bytes)` : 'No image bytes. Attach the original image if required.'}\nRaw clicks: ${evidence.rawPoints?.length || 0}; corrections: ${evidence.corrections?.length || 0}.\nCalibration: ${evidence.calibration ? `${Number(!!evidence.calibration.low)+Number(!!evidence.calibration.high)} of 2 anchors` : 'absent'}.\nImage transform: ${evidence.transforms ? `${evidence.transforms.originalSize.join(' × ')} original; ${evidence.transforms.viewSize.join(' × ')} view; crop ${evidence.transforms.crop?.join(', ') || 'none'}; ${evidence.transforms.reference || 'unspecified reference'}` : 'absent'}.\n${evidence.notes || ''}\n\n${snapshot.source}`;
    message('project-state','Preview only. Accept replaces the active source and evidence.');refresh();
  }
  function reserve() {const ticket=++generation,key=editor.key();candidate=undefined;refresh();return {ticket,key};}
  $('project-open').onchange=async(event:any)=>{
    const file=event.target.files[0];if(!file)return;
    // Reserve the generation before reading bytes to reject older file reads.
    const ticket=++generation, key=editor.key();candidate=undefined;refresh();
    try {
      if(file.size>16*1024*1024)throw Error('The project ZIP exceeds 16 MiB.');
      const bytes=new Uint8Array(await file.arrayBuffer());
      if(ticket!==generation)return;
      if(key!==editor.key())throw Error('The project changed while opening the file. Open it again.');
      await preview(unpackProject(bytes),file.name,ticket,key);
    }catch(error){if(ticket===generation)message('project-state',(error as Error).message,true);}
    finally{event.target.value='';}
  };
  $('project-accept').onclick=()=>{
    try {
      if(!candidate)throw Error('Open a project preview first.');
      if(editor.dirty())throw Error('Apply or restore source and repetition drafts before accepting a project.');
      if(candidate.key!==editor.key() || candidate.generation!==generation)throw Error('This preview is stale. Open the project again.');
      candidate.apply();candidate=undefined;++generation;$('project-preview').hidden=true;changed();
      message('project-state','Project accepted. Source and evidence now belong to the imported project.');
    }catch(error){message('project-state',(error as Error).message,true);}
  };
  $('project-cancel').onclick=()=>{candidate=undefined;++generation;$('project-preview').hidden=true;refresh();message('project-state','Project preview canceled.');};
  $('recovery-save').onclick=()=>persist(true);
  $('recovery-restore').onclick=async()=>{
    if(!recovery)return;
    const key=editor.key(),ticket=++generation;
    try {
      const apply=await editor.prepare(recovery.snapshot);
      if(ticket!==generation || !unresolved)return;
      if(key!==editor.key())throw Error('The project changed during recovery. Try Restore again.');
      if(editor.dirty())throw Error('Apply or restore the current draft before restoring recovery.');
      apply();editor.restoreDraft(recovery.draft);unresolved=false;$('recovery-offer').hidden=true;changed();
      message('recovery-state','Recovery restored. An unapplied draft remains a draft.');
    }catch(error){message('recovery-state',(error as Error).message,true);}
  };
  $('recovery-keep').onclick=()=>{++generation;unresolved=false;$('recovery-offer').hidden=true;message('recovery-state','Current project kept. The previous recovery stays stored until the next recovery save.');};
  $('project-notes').oninput=changed;
  $('recovery-denied').onchange=()=>message('recovery-state',denied()?'Recovery storage denial is enabled. Project ZIP save and open remain available.':'Recovery storage denial is disabled.');
  const startup=readProjectRecovery({denied:denied()}).then(record=>{
    ready=true;recovery=record;head=record?.snapshot.revisionId || null;
    if(record){unresolved=true;$('recovery-offer').hidden=false;message('recovery-state','A browser recovery record is available. Restore it or keep the current project.');}
    else {message('recovery-state','No browser recovery record. Recovery stays local to this browser.');if(initialKey!==editor.key())changed();}
  }).catch(error=>{ready=true;unresolved=true;message('recovery-state',`Browser recovery unavailable: ${error.message} Existing records stay untouched. Project ZIP save and open remain available.`,true);});
  refresh();
  return {changed,preview,reserve,current:(ticket:number)=>ticket===generation,persist,startup,get pending(){return candidate?.snapshot;}};
}
