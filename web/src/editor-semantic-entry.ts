import { mountMeasurements } from './ui/measurement-cursors.ts';
import { compileYaml, expandFinite } from './semantic/index.ts';
import type { CompiledWaveform, Diagnostic, Point } from './semantic/index.ts';
import { previewLegacyMigration } from './semantic/legacy.ts';
import { SemanticController } from './source/controller.ts';
import type { EditCommand, EditProposal } from './source/controller.ts';
import type { LeafSegment, Repeat } from './semantic/types.ts';
import { newDocumentSource, unusedId, segmentCommand, findCompiled, inspectorSummary, correctionCommands, rampTimeCommand } from './ui/semantic-authoring.ts';
import { attachPlotGestures, fitViewport, pointQuantity, rampTargetValue } from './ui/plot-tools.ts';
import type { Viewport, PlotRect } from './ui/plot-tools.ts';
import { parseQuantity } from './semantic/units.ts';
import { semanticSpectrumInput, pointSpectrumInput } from './analysis/spectrum.ts';
import { mountSpectrumPanel } from './ui/spectrum-panel.ts';
import { compilePointProject, exportWaveform } from './export/index.ts';
import type { ExportFormat, ExportResult } from './export/index.ts';
import { exportPreview, exportDownload, exportSummary } from './ui/export-controls.ts';
import { mountProjectControls } from './ui/project-controls.ts';
import type { ProjectEvidence } from './project/index.ts';
import { packProject, validateProject } from './project/index.ts';
import { mountDigitizeControls } from './ui/digitize-controls.ts';

export const semanticSamples = {
  current: `schema: wavecraft/1
name: Load pulse · 175%
signal: {dimension: current, nominal: 240 A, initial: 0 A}
segments:
  - {id: rise, kind: ramp, to: 175%, slew: 6 A/us}
  - {id: plateau, kind: hold, duration: 2 ms}
  - {id: return, kind: ramp, to: 0 A, slew: 6 A/us}
`,
  voltage: `schema: wavecraft/1
name: Signed voltage
signal: {dimension: voltage, initial: -12 V}
segments:
  - {id: negative-hold, kind: hold, duration: 20 us}
  - {id: rise, kind: ramp, to: 6 V, duration: 30 us}
  - {id: top, kind: hold, duration: 40 us}
  - {id: return, kind: ramp, to: -12 V, duration: 30 us}
`,
  burst: `schema: wavecraft/1
name: Ten patterns per burst
signal: {dimension: current, nominal: 10 A, initial: 0 A}
segments:
  - id: burst
    kind: repeat
    frequency: 1 MHz
    count: 10
    outer: {period: 1 s, count: continuous}
    pattern:
      - {id: rise, kind: ramp, to: 100%, duration: 100 ns}
      - {id: top, kind: hold, duration: 200 ns}
      - {id: return, kind: ramp, to: 0 A, duration: 100 ns}
`
};
const number = (n: number) => Number(n.toPrecision(15)).toString();
const display = (n: number) => Number(n.toPrecision(10)).toString();
export function diagnosticText(items: Diagnostic[]) {
  return items.map(d => `${d.code} · ${d.source.id || d.source.path.join('.') || 'document'}${d.source.range ? ` · offsets ${d.source.range[0]}–${d.source.range[1]}` : ''}: ${d.message}`).join('\n');
}

export class SemanticSession extends SemanticController {
  get validSource() { return this.committedSource; }
  migration: ReturnType<typeof previewLegacyMigration> | undefined;
  draft(text: string) { this.setDraft(text); }
  apply(text = this.source) {
    this.draft(text);
    return this.applyDraft().ok;
  }
  restore() { this.restoreDraft(); }
  previewMigration(text: string) { return this.migration = previewLegacyMigration(text); }
  applyMigration() {
    const candidate = this.migration?.candidateSource;
    if (!candidate || !this.migration?.candidate?.ok || !this.migration.shapeEquivalent) return false;
    return this.apply(candidate);
  }
  output(format: string, horizonS?: number) {
    if (this.dirty) throw Error('Apply or restore the YAML before exporting.');
    if (!this.result) throw Error('Apply a valid semantic document first.');
    if (format === 'yaml') return this.validSource;
    if (format === 'json') return JSON.stringify({ format: 'wavecraft-semantic-project/1', sourceFormat: 'yaml', sourceText: this.validSource, document: this.result.document }, null, 2) + '\n';
    const result = exportWaveform(this.result.compiled, {format:format as ExportFormat, name:this.result.document.name, horizonS, repeatMode:'expand'});
    if (!result.ok) throw Error(diagnosticText(result.diagnostics));
    return exportPreview(result);
  }
}

export function localDetail(compiled: CompiledWaveform) {
  const repeat = compiled.nodes.find(n => n.kind === 'repeat');
  const horizonS = Math.min(compiled.durationS, repeat?.kind === 'repeat' ? repeat.timing.startS + (repeat.outer ? Math.min(Number(repeat.count), 10) - 1 : 2) * repeat.periodS + repeat.patternDurationS : compiled.durationS);
  return expandFinite(compiled, {horizonS, maxPoints: 10000});
}

export function mountSemanticEditor(point: { sync: () => void; preview: () => void; isDirty: () => boolean; project?: any }) {
  const $ = (id: string) => document.getElementById(id) as any;
  if (!$('source-mode')) return;
  const session = new SemanticSession();
  for(const [id,value] of Object.entries({'semantic-tool':'select','semantic-new-dimension':'current','semantic-add-kind':'ramp','semantic-add-control':'slew','semantic-wrap-mode':'periodic','semantic-wrap-control':'period','semantic-wrap-outer-control':'period','export-repeat-mode':'expand'})) $(id).value ||= value;
  let active = false;
  let spectrumRefresh = () => {};
  let pending: EditProposal | undefined;
  let pendingSelection: string | undefined;
  let viewport: Viewport = fitViewport([]), viewportRevision = -1;
  let plotRect: PlotRect = {left:62,right:676,top:20,bottom:312};
  let suggestedAddId = 'segment';
  const ids = ['add','remove','update-point','apply-slew','apply-repeat','repeat-mode','repeat-period','repeat-frequency','repeat-count','burst-period','burst-frequency','point-time','point-value','point-choice','slew'];
  const source = $('source');
  const pointSource = () => point.project?.source() ?? source.value;
  const pointDocument = () => JSON.parse(pointSource().replace(/^\uFEFF/,''));
  let projectControls: ReturnType<typeof mountProjectControls>;
  let digitize: ReturnType<typeof mountDigitizeControls>;
  let projectNotesPresent=false;
  let sourceOpenGeneration=0, migrationKey='', migrationTicket:number|undefined;
  const sourceOpenKey=()=>JSON.stringify([active,session.revision,session.source,pointSource(),source.value,point.project?.evidenceKey(),$('project-notes')?.value]);
  $('text-message').style.whiteSpace='pre-wrap';
  const original = { input: source.oninput, apply: $('apply-text').onclick, restore: $('discard-text').onclick, download: $('download').onclick, open: $('open-file').onchange, undo: $('undo').onclick, redo: $('redo').onclick };
  const message = (id: string, text: string, error = false) => { $(id).textContent = text; $(id).className = 'notice ' + (error ? 'error' : 'ok'); };
  function segments() {
    const entries: (LeafSegment | Repeat)[] = [];
    for (const segment of session.result?.document.segments || []) {
      entries.push(segment);
      if (segment.kind === 'repeat') entries.push(...segment.pattern);
    }
    return entries;
  }
  function selected() { return segments().find(segment => segment.id === session.selectionId); }
  function options(id: string, values: [string, string][], value?: string) {
    const select = $(id); select.replaceChildren();
    for (const [key, label] of values) { const option = document.createElement('option'); option.value = key; option.textContent = label; select.appendChild(option); }
    select.value = values.some(([key]) => key === value) ? value : values[0]?.[0] || '';
  }
  function clearProposal() { pending = undefined; pendingSelection=undefined; $('semantic-proposal').textContent = ''; $('semantic-corrections').replaceChildren(); $('semantic-apply-edit').disabled = true; $('semantic-cancel-edit').disabled = true; }
  function editFields() {
    const segment = selected(), operation = $('semantic-operation').value;
    const isPoint = operation === 'point', isRamp = operation === 'ramp-control', isClock = operation.endsWith('-clock');
    $('semantic-point-field').hidden = !isPoint;
    $('semantic-control-field').hidden = !(isRamp || isClock);
    $('semantic-second-field').hidden = !isPoint;
    if (isPoint && segment?.kind === 'points') options('semantic-point', segment.points.map(p => [p.id,p.id]), $('semantic-point').value);
    if (isRamp) options('semantic-control', [['duration','Duration'],['slew','Slew']], segment?.kind === 'ramp' && segment.slew ? 'slew' : 'duration');
    if (isClock && segment?.kind === 'repeat') {
      const clock = operation.startsWith('outer') ? segment.outer! : segment;
      options('semantic-control', [['period','Period'],['frequency','Frequency']], clock.frequency ? 'frequency' : 'period');
    }
    populateValue();
  }
  function populateValue() {
    const segment = selected(), operation = $('semantic-operation').value, control = $('semantic-control').value;
    let value = '', label = 'Quantity';
    if (operation === 'nominal' || operation === 'initial') { value = session.result?.document.signal[operation] || ''; label = operation === 'initial' ? 'Initial level · units' : 'Nominal reference · units'; }
    if (segment?.kind === 'ramp') {
      if (operation === 'target') { value = segment.to; label = 'Target · quantity or %'; }
      if (operation === 'ramp-control') { value = (control === 'slew' ? segment.slew : segment.duration) || ''; label = control === 'slew' ? 'Slew · units/time' : 'Duration · time units'; }
      if (operation === 'timing') { value = segment.arriveAt || ''; label = 'Arrival time · blank removes constraint'; }
      if (operation === 'max-slew') { value = segment.maxSlew || ''; label = 'Maximum slew · blank removes limit'; }
    }
    if (operation === 'hold-duration' && segment?.kind === 'hold') { value = segment.duration; label = 'Hold duration · time units'; }
    if (isRepeatOperation(operation) && segment?.kind === 'repeat') {
      const clock = operation.startsWith('outer') ? segment.outer! : segment;
      if (operation.endsWith('-count')) { value = String(clock.count); label = 'Count · integer or continuous'; }
      else { const compiled=findCompiled(session.result!,segment.id);const resolved=compiled?.kind==='repeat'?(operation.startsWith('outer')?compiled.outer:compiled):undefined;value = (control === 'frequency' ? clock.frequency : clock.period) || (resolved ? control==='frequency'?`${number(resolved.frequencyHz)} Hz`:`${number(resolved.periodS)} s`:''); label = control === 'frequency' ? 'Frequency · units' : 'Period · time units'; }
    }
    if (operation === 'point' && segment?.kind === 'points') {
      const p = segment.points.find(p => p.id === $('semantic-point').value);
      value = p?.time || ''; $('semantic-second').value = p?.value || ''; label = 'Point time · local time units';
    }
    $('semantic-value-label').textContent = label; $('semantic-value').value = value;
  }
  function isRepeatOperation(operation: string) { return operation.startsWith('inner-') || operation.startsWith('outer-'); }
  function authoringTable() {
    const body=$('semantic-table-body');body.replaceChildren();
    for(const segment of segments()) {
      const node=findCompiled(session.result!,segment.id), row=document.createElement('tr');
      row.setAttribute('tabindex','0');row.setAttribute('role','button');row.setAttribute('aria-selected',String(segment.id===session.selectionId));row.setAttribute('data-segment',segment.id);
      if(segment.id===session.selectionId)row.setAttribute('style','background:var(--wash);font-weight:600');
      const anchor=segment.kind==='ramp'?(segment.arriveAt?`Absolute ${segment.arriveAt}`:'Relative · sequential'):segment.kind==='repeat'?'Pattern clock':segment.kind==='points'?'Explicit points':'Hold duration';
      for(const value of [`${segment.id} · ${segment.kind}`,node?display(node.timing.startS*1e6):'',node?display(node.timing.durationS*1e6):'',anchor]) {const cell=document.createElement('td');cell.textContent=value;row.appendChild(cell);}
      row.onclick=()=>choose(segment.id);row.onkeydown=(e:KeyboardEvent)=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose(segment.id);}};body.appendChild(row);
    }
    options('semantic-add-parent',[['','Top-level sequence'],...segments().filter(s=>s.kind==='repeat').map(s=>[s.id,`${s.id} pattern`] as [string,string])],$('semantic-add-parent').value);
    insertionOptions();
  }
  function insertionOptions() {
    const parent=segments().find(s=>s.id===$('semantic-add-parent').value), entries=parent?.kind==='repeat'?parent.pattern:session.result?.document.segments || [];
    options('semantic-add-before',[['','Append'],...entries.map(s=>[s.id,s.id] as [string,string])],$('semantic-add-before').value);
  }
  function inspector() {
    if (!active) return;
    const entries = segments();
    if (!entries.some(s => s.id === session.selectionId)) session.select(entries[0]?.id || null);
    options('semantic-selection', entries.map(s => [s.id,`${s.id} · ${s.kind}`]), session.selectionId || undefined);
    const segment = selected(), ops: [string,string][] = [];
    if (segment?.kind === 'ramp') ops.push(['target','Target'],['ramp-control','Duration / slew'],['timing','Arrival constraint'],['max-slew','Maximum slew']);
    if (segment?.kind === 'hold') ops.push(['hold-duration','Hold duration']);
    if (segment?.kind === 'points') ops.push(['point','Source point']);
    if (segment?.kind === 'repeat') { ops.push(['inner-clock','Pattern period / frequency'],['inner-count','Pattern count']); if (segment.outer) ops.push(['outer-clock','Burst period / frequency'],['outer-count','Burst count']); }
    ops.push(['nominal','Nominal reference'],['initial','Initial level']);
    options('semantic-operation', ops, $('semantic-operation').value);
    const reference = session.sourceMap.get(segment?.id || '');
    $('semantic-selection-info').textContent = `${segment?.id || 'No segment'} owns the selected geometry. Revision ${session.revision}.${reference?.range ? ` Source offsets ${reference.range[0]}–${reference.range[1]}.` : ''}${session.dirty ? ' The source draft stays unchanged. Apply or restore it before an edit.' : ''}`;
    $('semantic-resolved').textContent = segment && session.result ? inspectorSummary(session.result,segment) : 'Add an authored segment to the empty waveform.';
    $('semantic-insert-point').hidden = $('semantic-remove-point').hidden = segment?.kind !== 'points';
    authoringTable();
    editFields();
  }
  function choose(id: string) {
    session.select(id); clearProposal(); inspector(); state(); draw();
    projectControls?.changed();
    const reference=session.sourceMap.get(id);
    if(!session.dirty && reference?.range) source.setSelectionRange?.(reference.range[0],reference.range[1]);
  }
  function command(): EditCommand {
    const id = session.selectionId!, value = $('semantic-value').value.trim(), operation = $('semantic-operation').value;
    if (operation === 'target' || operation === 'nominal' || operation === 'initial' || operation === 'hold-duration') return {type:operation,...(['nominal','initial'].includes(operation) ? {} : {id}),value} as EditCommand;
    if (operation === 'max-slew') return {type:'max-slew',id,value:value||null};
    if (operation === 'ramp-control') return {type:'ramp-control',id,control:$('semantic-control').value,value};
    if (operation === 'timing') return {type:'timing',id,arriveAt:value || null};
    if (operation === 'point') return {type:'point',id:$('semantic-point').value,time:value,value:$('semantic-second').value.trim()};
    const level = operation.startsWith('outer') ? 'outer' : 'inner';
    if (operation.endsWith('-count')) return {type:'repeat-count',id,level,count:value === 'continuous' ? 'continuous' : Number(value)};
    return {type:'repeat-clock',id,level,control:$('semantic-control').value,value};
  }
  function propose(edit: EditCommand) {
    clearProposal();
    const result = session.propose(edit);
    if (!result.ok) {
      message('semantic-proposal',diagnosticText(result.diagnostics),true);
      for(const correction of correctionCommands(edit,result.diagnostics)) { const button=document.createElement('button');button.textContent=correction.label;button.onclick=()=>propose(correction.command);$('semantic-corrections').appendChild(button); }
      return;
    }
    pending = result.proposal;
    pendingSelection=edit.type==='insert-segment'?edit.segment.id:edit.type==='wrap-repeat'?edit.repeat.id:undefined;
    const timing = (t: {startS:number,endS:number,durationS:number}) => `${display(t.startS * 1e6)} → ${display(t.endS * 1e6)} µs; duration ${display(t.durationS * 1e6)} µs`;
    message('semantic-proposal', [edit.type === 'flatten' ? 'Convert removes structured intent in this segment. Apply edit to confirm conversion. Undo restores the source.' : 'Preview only. Apply edit to commit this revision.', ...pending.warnings, ...repeatPreview(edit,pending), ...pending.changes.map(change => `${change.id}\n  Before: ${timing(change.before)}\n  After:  ${timing(change.after)}`)].join('\n'));
    $('semantic-apply-edit').disabled = false; $('semantic-cancel-edit').disabled = false;
  }
  function repeatPreview(edit: EditCommand, proposal: EditProposal): string[] {
    if(edit.type==='batch')return edit.commands.flatMap(command=>repeatPreview(command,proposal));
    if(edit.type==='wrap-repeat') {const after=proposal.result.compiled.nodes.find(n=>n.id===edit.repeat.id);return after?.kind==='repeat'?[`${after.id} · resolved repetition preview`,`Pattern period ${display(after.periodS)} s; frequency ${display(after.frequencyHz)} Hz; pattern repetitions ${after.count}; pattern duration ${display(after.patternDurationS)} s; active span ${display(after.activeSpanS)} s.`,...(after.outer?[`Outer period ${display(after.outer.periodS)} s; frequency ${display(after.outer.frequencyHz)} Hz; burst repetitions ${after.outer.count}.`]:[])]:[];}
    if(edit.type !== 'repeat-clock' && edit.type !== 'repeat-count') return [];
    const before=session.result?.compiled.nodes.find(node=>node.id===edit.id);
    const after=proposal.result.compiled.nodes.find(node=>node.id===edit.id);
    if(before?.kind !== 'repeat' || after?.kind !== 'repeat') return [];
    const lines=[`${edit.id} · resolved repetition preview`,
      `  Pattern period: ${display(before.periodS)} → ${display(after.periodS)} s`,
      `  Pattern frequency: ${display(before.frequencyHz)} → ${display(after.frequencyHz)} Hz`,
      `  Pattern count: ${before.count} → ${after.count}`,
      `  Active span: ${display(before.activeSpanS * 1e6)} → ${display(after.activeSpanS * 1e6)} µs`];
    if(before.outer && after.outer) lines.push(
      `  Outer period: ${display(before.outer.periodS)} → ${display(after.outer.periodS)} s`,
      `  Outer frequency: ${display(before.outer.frequencyHz)} → ${display(after.outer.frequencyHz)} Hz`,
      `  Outer count: ${before.outer.count} → ${after.outer.count}`);
    return lines;
  }
  function horizon() {
    const raw = $('semantic-horizon').value.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw Error('Use a finite nonnegative export horizon in seconds.');
    return value;
  }
  function state() {
    ids.forEach(id => $(id).disabled = active);
    $('point-inspector').hidden = active;
    $('point-repeat-controls').hidden = active;
    $('semantic-inspector').hidden = !active;
    $('semantic-authoring').hidden = !active;
    $('semantic-snap-value-label').textContent=`Snap level (${session.result?.compiled.dimension==='voltage'?'V':'A'}; 0 = off)`;
    $('semantic-yaml-toggle').textContent = active ? 'Source YAML' : 'Source JSON';
    $('plot').setAttribute('role',active?'group':'img');
    if (active) {
      $('undo').disabled = session.dirty || !session.canUndo;
      $('redo').disabled = session.dirty || !session.canRedo;
      for (const id of ['semantic-propose','semantic-convert','semantic-value','semantic-second','semantic-control','semantic-point']) $(id).disabled = session.dirty || !session.result;
      $('semantic-apply-edit').disabled = session.dirty || !pending;
      $('semantic-cancel-edit').disabled = !pending;
      for(const id of ['semantic-add-segment','semantic-remove-segment','semantic-wrap','semantic-insert-point','semantic-remove-point']) $(id).disabled=session.dirty||!session.result;
    }
    $('semantic-horizon-field').hidden = $('format').value === 'json' || active && $('format').value === 'yaml';
    $('semantic-timing').hidden = !active;
    if(active) $('text-state').textContent = session.dirty ? 'Unapplied YAML' : `In sync · revision ${session.revision}`;
    const lastValidLabel=' · last valid applied source';
    $('readout').textContent=$('readout').textContent.replace(lastValidLabel,'')+(active && session.dirty ? lastValidLabel : '');
    $('source-help').textContent = active ? 'YAML owns the waveform. Select a compiled corner to edit its owning segment. Preview edits, then apply. Errors keep the last valid plot.' : 'Pairs are [time in µs, current in A]. Apply the text to update the plot. Invalid text keeps the last valid plot.';
    document.querySelector('label[for="source"]')!.textContent = active ? 'Waveform text · semantic YAML' : 'Waveform text · JSON';
    const options = $('format').options;
    if (options) for (const option of options) {
      if(option.value === 'pwl') option.textContent = active && session.result?.compiled.dimension === 'voltage' ? 'LTspice · inline PWL voltage source' : 'LTspice · inline PWL current source';
      if(option.value === 'yaml') option.textContent = active ? 'Semantic YAML · original source' : 'Wavecraft YAML · finite point data';
      if(option.value === 'json') option.textContent = active ? 'Semantic project JSON · YAML source' : 'Project JSON · editable source';
    }
    if(active) message('repeat-message','The semantic segment inspector owns repetition for this source.');
    spectrumRefresh();
  }
  function preview() {
    let error = '';
    const format = $('format').value, sourceOnly = format === 'json' || active && format === 'yaml';
    $('semantic-horizon-field').hidden = sourceOnly;
    $('export-sample-field').hidden = format !== 'csv-uniform';
    $('export-repeat-field').hidden = !['pwl','pwl-file'].includes(format);
    $('export-validation').textContent = ['pwl','pwl-file'].includes(format) ? 'LTspice current and voltage adapter fixtures passed simulator comparisons. Check the exported source polarity and coverage for your circuit.' : format === 'plecs' ? 'PLECS lookup instructions are prepared. The simulator waveform comparison is pending.' : '';
    try {
      const result = prepareExport();
      $('export-preview').textContent = exportPreview(result);
      $('export-state').textContent = (sourceOnly ? 'Committed authoring source. Quantities, constraints, and repeats remain intact.' : exportSummary(result)) + (active && pending ? ' The unapplied edit preview is excluded. Export uses the committed source.' : '');
      $('export-polarity').textContent = sourceOnly ? '' : result.metadata.dimension === 'voltage' ? 'Positive voltage is V(1) − V(0). Negative values reverse the voltage.' : 'Positive current flows from node 0 to node 1. Negative values reverse the current.';
    } catch (e) { error = (e as Error).message; $('export-preview').textContent = error; $('export-state').textContent = error; $('export-polarity').textContent = ''; }
    $('download').disabled = !!error;
  }
  function prepareExport(): Extract<ExportResult,{ok:true}> {
    if (active ? session.dirty : point.isDirty()) throw Error('Apply or restore the source before exporting.');
    if (!active && pointRepetitionDraft()) throw Error('Repetition settings pending. Apply repetition or restore valid text before exporting.');
    const format = $('format').value, project = active ? undefined : pointDocument();
    const name = active ? session.result?.document.name || 'waveform' : project.name;
    if (format === 'json' || active && format === 'yaml') {
      const content = active ? session.output(format) : JSON.stringify(project,null,2)+'\n';
      return {ok:true, artifacts:[{filename:`${name.replace(/[^a-zA-Z0-9_-]/g,'_')}.${format}`,content,mimeType:'text/plain;charset=utf-8',role:'primary'}], warnings:[],metadata:{format:'csv',dimension:active ? session.result!.compiled.dimension : 'current',representation:'exact-points',horizonS:null,pointCount:0,capabilities:{endpointHold:true,compactRepeat:false,twoLevelRepeat:false}}};
    }
    const compiled = active ? session.result ? {ok:true as const,compiled:session.result.compiled} : undefined : compilePointProject(project);
    if (!compiled) throw Error('Apply a valid semantic document first.');
    if (!compiled.ok) throw Error(diagnosticText(compiled.diagnostics));
    const result = exportWaveform(compiled.compiled, {format:(format === 'yaml' ? 'csv' : format) as ExportFormat,name,horizonS:horizon(),sampleIntervalS:format==='csv-uniform'?Number($('export-sample-interval').value):undefined,repeatMode:['pwl','pwl-file'].includes(format) && $('export-repeat-mode').value==='auto'?'auto':'expand'});
    if (!result.ok) throw Error(diagnosticText(result.diagnostics));
    if (format === 'yaml') {
      const rows = result.artifacts[0].content.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#')).slice(1).map(line => line.split(',').map(Number));
      const content = `# Finite point export; horizon ${result.metadata.horizonS} s. Repetition stops at this horizon.\n# Authoring constraints are not included. Save Project JSON to retain repetition.\nname: ${JSON.stringify(name)}\nsteps:\n`+rows.map(([t,v])=>`  - {t: "${t}s", value: "${v}A"}`).join('\n')+'\n';
      return {...result,artifacts:[{filename:`${name.replace(/[^a-zA-Z0-9_-]/g,'_')}.yaml`,content,mimeType:'application/yaml',role:'primary'}]};
    }
    return result;
  }
  function append(parent: any, tag: string, attrs: Record<string, any>, text?: string) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
    if (text !== undefined) element.textContent = text;
    parent.appendChild(element); return element;
  }
  function drawPoints(target: any, points: Point[], height: number, unit: string, view?:Viewport) {
    target.querySelectorAll(':scope > :not(title):not(desc)').forEach((el: any) => el.remove());
    const width = target.clientWidth || 700, left = 62, right = width - 24, bottom = height - 48;
    target.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const end = Math.max(points.at(-1)?.[0] || 0, Number.MIN_VALUE), ys = points.map(v => v[1]);
    const lo = Math.min(0, ...ys), hi = Math.max(1, ...ys), pad = (hi - lo) * .12;
    const minTime=view?.timeMinS ?? 0,maxTime=view?.timeMaxS ?? end,minValue=view?.valueMin ?? lo-pad,maxValue=view?.valueMax ?? hi+pad;
    const x = (t: number) => left + (t-minTime) / (maxTime-minTime) * (right - left), y = (v: number) => bottom - (v-minValue)/(maxValue-minValue)*(bottom-20);
    if(view)plotRect={left,right,top:20,bottom};
    for (let i = 0; i <= 4; i++) {
      const px = left + i / 4 * (right - left), value = minValue + i / 4 * (maxValue-minValue), py = y(value);
      append(target,'line',{x1:px,y1:20,x2:px,y2:bottom,class:'grid'});
      append(target,'text',{x:px,y:bottom+21,'text-anchor':'middle'},display((minTime+(maxTime-minTime)*i/4)*1e6));
      append(target,'line',{x1:left,y1:py,x2:right,y2:py,class:'grid'});
      append(target,'text',{x:left-10,y:py+4,'text-anchor':'end'},Number(value.toPrecision(3)).toString());
    }
    append(target,'text',{x:(left+right)/2,y:height-5,'text-anchor':'middle'},'Time (µs)');
    append(target,'text',{x:15,y:(20+bottom)/2,'text-anchor':'middle',transform:`rotate(-90 15 ${(20+bottom)/2})`},unit);
    if(view) {const defs=append(target,'defs',{}),clip=append(defs,'clipPath',{id:'semantic-main-clip'});append(clip,'rect',{x:left,y:20,width:right-left,height:bottom-20});}
    append(target,'path',{d:points.map((v,i)=>`${i?'L':'M'} ${x(v[0])} ${y(v[1])}`).join(' '),class:'curve',...(target.id==='plot'?{'stroke-dasharray':'6 4','clip-path':'url(#semantic-main-clip)'}:{})});
    return {x,y,end};
  }
  function geometry(target: any, scales: {x:(n:number)=>number,y:(n:number)=>number,end:number}) {
    const compiled = session.result!.compiled, leaves: {leaf:any,offset:number}[] = [];
    for (const node of compiled.nodes) {
      if (node.kind === 'repeat') {
        const count = Math.min(node.count === 'continuous' ? 3 : node.count,10);
        for (let i=0;i<count;i++) for (const leaf of node.pattern) leaves.push({leaf,offset:node.timing.startS+i*node.periodS});
      } else leaves.push({leaf:node,offset:0});
    }
    const corners = new Set<string>();
    for (const {leaf,offset} of leaves) {
      const owner = leaf.source.id || leaf.id;
      const isSelected = owner === session.selectionId;
      const points: Point[] = leaf.points.map((p:Point)=>[p[0]+offset,p[1]]).filter((p:Point)=>p[0]<=scales.end);
      if (!points.length) continue;
      append(target,'path',{d:points.map((p,i)=>`${i?'L':'M'}${scales.x(p[0])} ${scales.y(p[1])}`).join(' '),fill:'none',stroke:isSelected?'#113b3e':'var(--accent)','stroke-width':isSelected?4:3,...(leaf.kind!=='points'?{'stroke-dasharray':'6 4'}:{}),'pointer-events':'none','clip-path':'url(#semantic-main-clip)'});
      for (const [index,p] of points.entries()) {
        const key = `${p[0]},${p[1]}`;
        if (corners.has(key)) continue;
        corners.add(key);
        const sourcePointId = leaf.kind === 'points' ? leaf.pointSources?.[index]?.id : undefined;
        const pointId = sourcePointId !== owner ? sourcePointId : undefined;
        const editable=!!pointId || index===points.length-1 && (leaf.kind==='ramp'||leaf.kind==='hold');
        const marker = append(target,'circle',{cx:scales.x(p[0]),cy:scales.y(p[1]),r:isSelected?6:4.5,fill:isSelected||pointId?'var(--accent)':'white',stroke:'var(--accent)','stroke-width':2,tabindex:0,role:'button','aria-label':`${pointId ? 'Source point' : 'Compiled corner'} · select ${owner}`,'data-owner':owner,...(pointId?{'data-source-point':pointId}:{}),...(editable?{'data-editable':'true','data-origin-s':leaf.timing.startS+offset,'data-role':pointId?'point':leaf.kind}:{}),style:'cursor:pointer','clip-path':'url(#semantic-main-clip)'});
        const selectOwner = () => { choose(owner); if(pointId) {$('semantic-operation').value='point';editFields();$('semantic-point').value=pointId;populateValue();highlightPoint();} };
        marker.onclick=()=>{if($('semantic-tool').value==='select')selectOwner();};
        marker.onkeydown=(event:KeyboardEvent)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();selectOwner();}};
        if(leaf.kind==='ramp' && index===points.length-1) {
          const handle=append(target,'rect',{x:scales.x(p[0])-5,y:21,width:10,height:10,fill:'var(--accent)',tabindex:0,role:'button','aria-label':`Ramp time handle · select ${owner}`,'data-owner':owner,'data-editable':'true','data-role':'ramp-time','data-origin-s':leaf.timing.startS+offset,'clip-path':'url(#semantic-main-clip)',style:'cursor:ew-resize'});
          const selectTime=()=>{choose(owner);const authored=selected();$('semantic-operation').value=authored?.kind==='ramp'&&authored.arriveAt?'timing':'ramp-control';editFields();};
          handle.onclick=()=>{if($('semantic-tool').value==='select')selectTime();};
          handle.onkeydown=(event:KeyboardEvent)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();selectTime();}};
        }
      }
    }
  }
  function draw() {
    if (!active || $('edit-panel').hidden) return;
    if (!session.result) {
      (globalThis as any).studioMeasure?.();
      $('plot').querySelectorAll(':scope > :not(title):not(desc)').forEach((el:any)=>el.remove());
      $('wave-title').textContent='No applied semantic waveform';
      $('readout').textContent='Apply valid semantic YAML to show a waveform.';
      $('semantic-timing').textContent=''; $('repeat-preview').hidden=true; $('burst-overview').toggleAttribute('hidden',true);
      return;
    }
    const compiled = session.result.compiled, detail = localDetail(compiled);
    if (!detail.ok) {
      (globalThis as any).studioMeasure?.();
      $('plot').querySelectorAll(':scope > :not(title):not(desc)').forEach((el:any)=>el.remove());
      $('wave-title').textContent=session.result.document.name;
      $('readout').textContent='Compiled source applied. Preview unavailable because expansion exceeds its local point budget.';
      $('semantic-timing').textContent='Preview unavailable. Save semantic YAML or choose a smaller finite export horizon.';
      $('repeat-preview').hidden=true;
      $('burst-overview').toggleAttribute('hidden', true);
      message('plot-message', diagnosticText(detail.diagnostics), true); return;
    }
    message('plot-message','Select a segment or compiled corner. Preview a semantic edit, then apply it. Dashed geometry follows its owning source segment.');
    if(viewportRevision!==session.revision) {
      try {viewport=fitViewport(detail.points);viewportRevision=session.revision;}
      catch(error) {$('plot').querySelectorAll(':scope > :not(title):not(desc)').forEach((el:any)=>el.remove());message('plot-message',(error as Error).message,true);return;}
    }
    const scales = drawPoints($('plot'),detail.points,$('plot').clientHeight || 360, compiled.dimension === 'voltage' ? 'Voltage (V)' : 'Current (A)',viewport);
    geometry($('plot'),scales);
    (globalThis as any).studioMeasure?.({
      points: detail.points.map(([time, value]) => [time * 1e6, value]),
      unit: compiled.dimension === 'voltage' ? 'V' : 'A',
      firstUs: viewport.timeMinS * 1e6, lastUs: viewport.timeMaxS * 1e6,
      ...plotRect, y: scales.y
    });
    $('plot-title').textContent = 'Compiled semantic waveform · select owning segment';
    $('plot-desc').textContent = 'Select a corner with a click, Enter, or Space. Edit its owning segment in the inspector. YAML owns the geometry.';
    $('wave-title').textContent = session.result.document.name;
    $('readout').textContent = `${detail.points.length} derived preview corners · ${display(detail.horizonS * 1e6)} µs local span · ${compiled.continuous ? 'continuous source · clipped preview' : detail.horizonS < compiled.durationS ? 'finite source · clipped preview' : 'finite source'} · ${$('semantic-tool').value} tool${session.dirty ? ' · last valid applied source' : ''}`;
    $('selected-label').textContent = 'Geometry belongs to semantic YAML segments.';
    $('point-time').value = ''; $('point-value').value = '';
    const records: string[] = [];
    for (const node of compiled.nodes) {
      if (node.kind === 'repeat') {
        records.push(`${node.id} · repeat · period ${display(node.periodS)} s · pattern ${display(node.patternDurationS)} s · pattern repetitions ${node.count} · active span ${display(node.activeSpanS)} s${node.outer ? ` · outer period ${display(node.outer.periodS)} s · burst repetitions ${node.outer.count}` : ''}`);
        for (const leaf of node.pattern) records.push(`  ${leaf.id} · ${leaf.kind}${leaf.derived ? ' (derived)' : ''} · local duration ${display(leaf.timing.durationS * 1e6)} µs`);
      } else records.push(`${node.id} · ${node.kind}${node.derived ? ' (derived idle)' : ''} · start ${display(node.timing.startS * 1e6)} µs · end ${display(node.timing.endS * 1e6)} µs · duration ${display(node.timing.durationS * 1e6)} µs${node.resolvedSlew ? ` · slew ${display(node.resolvedSlew / 1e6)} ${compiled.dimension === 'voltage' ? 'V' : 'A'}/µs` : ''}`);
    }
    $('semantic-timing').textContent = 'Compiled timing · YAML owns all records\n' + records.join('\n');
    const repeat = compiled.nodes.find(n=>n.kind==='repeat');
    $('repeat-preview').hidden = !repeat;
    $('burst-overview').toggleAttribute('hidden', !(repeat?.kind === 'repeat' && repeat.outer));
    if (repeat?.kind === 'repeat') {
      drawPoints($('repeat-plot'),detail.points,150,compiled.dimension === 'voltage' ? 'Voltage (V)' : 'Current (A)');
      $('repeat-summary').textContent = `${detail.horizonS < compiled.durationS ? 'Clipped local preview' : 'Local preview'}: ${display(detail.horizonS)} s. ${repeat.count} patterns; period ${display(repeat.periodS)} s. YAML owns repetition.`;
      if (repeat.outer) {
        const target = $('burst-overview'), bursts = repeat.outer.count === 'continuous' ? 2 : Math.min(2, repeat.outer.count);
        const end = repeat.timing.startS + bursts * repeat.outer.periodS;
        const overview = expandFinite(compiled, {horizonS: end, maxPoints: 10000});
        target.replaceChildren(); target.setAttribute('viewBox','0 0 700 100');
        if (!overview.ok) {
          target.toggleAttribute('hidden', true);
          $('repeat-summary').textContent += ` Burst timing unavailable: ${diagnosticText(overview.diagnostics)}`;
        } else {
          const values = overview.points.map(p => p[1]), lo = Math.min(0,...values), hi = Math.max(1,...values);
          const x = (t:number) => 50 + t / end * 630, y = (value:number) => 65 - (value-lo)/(hi-lo)*50;
          append(target,'path',{class:'curve',fill:'none',stroke:'var(--accent)','stroke-width':2.5,d:overview.points.map((p,i)=>`${i?'L':'M'}${x(p[0])} ${y(p[1])}`).join(' ')});
          for(let i=0;i<=bursts;i++) {
            const start = repeat.timing.startS+i*repeat.outer.periodS, px=x(start);
            append(target,'line',{x1:px,y1:10,x2:px,y2:72,stroke:'#cad6da'});
            append(target,'text',{x:px,y:92,'text-anchor':'middle','font-size':12},`${display(start)} s`);
          }
          $('repeat-summary').textContent += ` Burst timing: ${repeat.count} patterns every ${display(repeat.outer.periodS)} s; ${bursts} burst${bursts===1?'':'s'} shown at the actual time scale. Active span ${display(repeat.activeSpanS)} s. The local detail shows individual patterns.`;
        }
      }
    }
  }
  function render() { inspector(); state(); draw(); preview(); spectrumRefresh(); }
  function apply(text?: string) {
    clearProposal();
    if(text === undefined && !session.dirty && session.result) {
      message('text-message','YAML is already applied. Source, plot, and export use the current revision.');render();return;
    }
    text ??= source.value;
    source.value = text;
    if (session.apply(text)) { source.value = session.source; message('text-message',diagnosticText(session.diagnostics) || 'YAML applied. Geometry and exports use the compiled document.'); }
    else message('text-message',diagnosticText(session.diagnostics),true);
    render();
  }
  function canSwitch() {
    if (active ? session.dirty : point.isDirty() || pointRepetitionDraft()) { message('text-message','Apply or restore the source and repetition settings before changing modes or loading a sample.',true); return false; }
    return true;
  }
  function pointMode() {
    active = false; $('source-mode').value='points';
    $('plot-title').textContent='Editable load current waveform';
    $('plot-desc').textContent='Select or drag a point. Use the numeric fields below for keyboard editing.'; $('semantic-horizon-field').hidden=true; $('semantic-timing').hidden=true;
    ids.forEach(id=>$(id).disabled=false); state(); point.sync();
    message('plot-message','Point JSON restored. Select or drag an explicit point.');
    message('repeat-message','Point JSON owns these repetition settings.');
    message('text-message','Point JSON restored.');
  }
  function semanticMode(text?: string) {
    active = true; $('source-mode').value='semantic';
    if (text !== undefined) apply(text);
    else if (!session.result) apply(semanticSamples.current);
    else { source.value=session.source; render(); }
  }
  $('source-mode').onchange=()=>{const wanted=$('source-mode').value; if(!canSwitch()){$('source-mode').value=active?'semantic':'points';return;} if(wanted==='semantic')semanticMode();else pointMode();};
  $('semantic-load-sample').onclick=()=>{if(canSwitch()){ $('semantic-horizon').value=''; semanticMode(semanticSamples[$('semantic-sample').value as keyof typeof semanticSamples]); }};
  source.oninput=(event:any)=>{if(!active)return original.input?.call(source,event); clearProposal(); session.draft(source.value); state(); preview(); message('text-message','YAML is a draft. The plot shows the last valid waveform.');};
  $('apply-text').onclick=(event:any)=>active?apply():original.apply?.call($('apply-text'),event);
  $('discard-text').onclick=(event:any)=>{if(!active)return original.restore?.call($('discard-text'),event);session.restore();source.value=session.source;message('text-message','Restored the last valid semantic YAML.');render();};
  $('semantic-horizon').oninput=preview;
  $('export-sample-interval').oninput=preview;
  $('export-repeat-mode').onchange=preview;
  $('format').onchange=preview;
  $('semantic-selection').onchange=()=>choose($('semantic-selection').value);
  $('semantic-new-dimension').onchange=()=>{clearProposal();const voltage=$('semantic-new-dimension').value==='voltage';$('semantic-new-initial').value=voltage?'-12 V':'0 A';$('semantic-new-nominal').value=voltage?'':'240 A';};
  $('semantic-new').onclick=()=>{
    if(!canSwitch())return;
    semanticMode(newDocumentSource($('semantic-new-name').value.trim(),$('semantic-new-dimension').value,$('semantic-new-initial').value.trim(),$('semantic-new-nominal').value.trim()));
    $('semantic-add-target').value=session.result?.compiled.dimension==='voltage'?'6 V':'175%';
    $('semantic-add-duration').value=session.result?.compiled.dimension==='voltage'?'30 us':'6 A/us';
    $('semantic-add-control').value=session.result?.compiled.dimension==='voltage'?'duration':'slew';
    $('semantic-new-form').open=false;
  };
  $('semantic-yaml-toggle').onclick=()=>{
    const panel = $('source-panel');
    panel.hidden = !panel.hidden;
    $('semantic-yaml-toggle').setAttribute('aria-expanded', String(!panel.hidden));
  };
  $('semantic-add-parent').onchange=()=>{clearProposal();insertionOptions();};
  $('semantic-add-kind').onchange=()=>{
    clearProposal();const kind=$('semantic-add-kind').value;
    if(!$('semantic-add-id').value.trim() || $('semantic-add-id').value===suggestedAddId){suggestedAddId=unusedId(kind,session.sourceMap.keys());$('semantic-add-id').value=suggestedAddId;}
    $('semantic-add-duration').value=kind==='hold'?'2 ms':kind==='points'?'100 us':$('semantic-add-control').value==='slew'?(session.result?.compiled.dimension==='voltage'?'1 V/us':'6 A/us'):'30 us';
  };
  $('semantic-add-control').onchange=()=>{clearProposal();$('semantic-add-duration').value=$('semantic-add-control').value==='duration'?'30 us':session.result?.compiled.dimension==='voltage'?'1 V/us':'6 A/us';};
  $('semantic-add-segment').onclick=()=>{
    const id=$('semantic-add-id').value.trim(),duration=$('semantic-add-duration').value.trim();
    propose(segmentCommand({id,kind:$('semantic-add-kind').value,duration,target:$('semantic-add-target').value.trim(),control:$('semantic-add-control').value,arriveAt:$('semantic-add-arrival').value.trim(),maxSlew:$('semantic-add-max-slew').value.trim(),pointTime:duration,pointValue:$('semantic-add-target').value.trim(),pointId:unusedId(`${id}-point`,session.sourceMap.keys())},$('semantic-add-parent').value||undefined,$('semantic-add-before').value||undefined));
  };
  $('semantic-remove-segment').onclick=()=>{if(session.selectionId)propose({type:'remove-segment',id:session.selectionId});};
  const countValue=(id:string)=>$(id).value.trim()==='continuous'?'continuous' as const:Number($(id).value);
  $('semantic-wrap').onclick=()=>{
    const outer=$('semantic-wrap-mode').value==='burst'?{[$('semantic-wrap-outer-control').value]:$('semantic-wrap-outer-clock').value.trim(),count:countValue('semantic-wrap-outer-count')}:undefined;
    propose({type:'wrap-repeat',ids:session.result?.document.segments.map(s=>s.id)||[],repeat:{id:$('semantic-wrap-id').value.trim(),count:countValue('semantic-wrap-count'),[$('semantic-wrap-control').value]:$('semantic-wrap-clock').value.trim(),...(outer?{outer:outer as any}:{})}});
  };
  $('semantic-insert-point').onclick=()=>{
    const item=selected();if(item?.kind!=='points')return;
    try {const time=$('semantic-value').value.trim(),offset=parseQuantity(time,'time'),before=item.points.find(p=>parseQuantity(p.time,'time')>offset);
      propose({type:'insert-point',id:item.id,point:{id:unusedId(`${item.id}-point`,session.sourceMap.keys()),time,value:$('semantic-second').value.trim()},...(before?{beforeId:before.id}:{})});
    }catch(error){clearProposal();message('semantic-proposal',(error as Error).message,true);}
  };
  $('semantic-remove-point').onclick=()=>{if(selected()?.kind==='points')propose({type:'remove-point',id:$('semantic-point').value});};
  $('semantic-tool').onchange=()=>{clearProposal();draw();};
  $('semantic-fit').onclick=()=>{viewportRevision=-1;draw();};
  attachPlotGestures($('plot'),{
    read:()=>({viewport,rect:plotRect,mode:active?$('semantic-tool').value:'select',enabled:active&&!session.dirty&&!!session.result,snapTimeS:Number($('semantic-snap-time').value)>0?Number($('semantic-snap-time').value)*1e-6:undefined,snapValue:Number($('semantic-snap-value').value)>0?Number($('semantic-snap-value').value):undefined}),
    onViewport:view=>{viewport=view;draw();},
    onGesture:gesture=>{
      if(!session.result)return;
      const dimension=session.result.compiled.dimension, owner=segments().find(s=>s.id===(gesture.kind==='draw'?session.selectionId:gesture.ownerId||session.selectionId));
      try {
        if(gesture.kind==='draw') {
          if(owner?.kind!=='points') {message('plot-message','Select an explicit point sequence before drawing a point.',true);return;}
          const leaf=findCompiled(session.result,owner.id)!;
          const parent=session.result.compiled.nodes.find(n=>n.kind==='repeat'&&n.pattern.some(p=>p.id===owner.id));
          const instance=parent?.kind==='repeat'?Math.floor((gesture.end.timeS-parent.timing.startS)/parent.periodS):0;
          if(parent?.kind==='repeat' && (instance<0 || instance>=(parent.count==='continuous'?Infinity:parent.count)))throw Error('Draw within a visible pattern instance.');
          const origin=leaf.timing.startS+(parent?.kind==='repeat'?parent.timing.startS+instance*parent.periodS:0),local=gesture.end.timeS-origin;
          const before=owner.points.find(p=>parseQuantity(p.time,'time')>local);
          propose({type:'insert-point',id:owner.id,point:{id:unusedId(`${owner.id}-point`,session.sourceMap.keys()),time:`${local} s`,value:`${gesture.end.value} ${dimension==='voltage'?'V':'A'}`},...(before?{beforeId:before.id}:{})});
        } else if(owner) {
          choose(owner.id);
          if(gesture.pointId && owner.kind==='points') {
            const point=owner.points.find(p=>p.id===gesture.pointId)!;
            const nominal=session.result.document.signal.nominal;
            propose({type:'point',id:point.id,time:pointQuantity(gesture.end.timeS-(gesture.originS||0),point.time,'time'),value:rampTargetValue(gesture.end.value,point.value,dimension,nominal?parseQuantity(nominal,dimension):undefined)});
          } else if(owner.kind==='ramp' && gesture.role==='ramp-time') {
            const leaf=findCompiled(session.result,owner.id)!;propose(rampTimeCommand(owner,leaf.timing.durationS,gesture.end.timeS-gesture.start.timeS));
          } else if(owner.kind==='ramp') {
            const nominal=session.result.document.signal.nominal;
            propose({type:'target',id:owner.id,value:rampTargetValue(gesture.end.value,owner.to,dimension,nominal?parseQuantity(nominal,dimension):undefined)});
          } else if(owner.kind==='hold') {
            const duration=parseQuantity(owner.duration,'time')+gesture.end.timeS-gesture.start.timeS;
            propose({type:'hold-duration',id:owner.id,value:pointQuantity(duration,owner.duration,'time')});
          }
        }
      } catch(error) {message('semantic-proposal',(error as Error).message,true);}
    }
  });
  $('semantic-operation').onchange=()=>{clearProposal();editFields();};
  $('semantic-control').onchange=()=>{clearProposal();populateValue();};
  function highlightPoint() {const ref=session.sourceMap.get($('semantic-point').value);if(!session.dirty && ref?.range)source.setSelectionRange?.(ref.range[0],ref.range[1]);}
  $('semantic-point').onchange=()=>{clearProposal();populateValue();highlightPoint();};
  for(const id of ['semantic-value','semantic-second']) $(id).oninput=clearProposal;
  for(const id of ['semantic-new-name','semantic-new-initial','semantic-new-nominal','semantic-add-id','semantic-add-target','semantic-add-duration','semantic-add-arrival','semantic-add-max-slew','semantic-wrap-id','semantic-wrap-clock','semantic-wrap-count','semantic-wrap-outer-clock','semantic-wrap-outer-count','semantic-snap-time','semantic-snap-value']) $(id).oninput=clearProposal;
  for(const id of ['semantic-add-before','semantic-wrap-mode','semantic-wrap-control','semantic-wrap-outer-control']) $(id).onchange=clearProposal;
  for(const level of ['','outer-']) {
    let previous='period';
    $(`semantic-wrap-${level}control`).onchange=()=>{
      clearProposal();const control=$(`semantic-wrap-${level}control`).value,field=$(`semantic-wrap-${level}clock`);
      if(control===previous)return;
      try {const old=parseQuantity(field.value,previous==='period'?'time':'frequency');if(old<=0)throw Error();field.value=control==='period'?`${number(1/old)} s`:`${number(1/old)} Hz`;}catch {message('semantic-proposal','Enter a valid positive clock quantity before changing its control.',true);$(`semantic-wrap-${level}control`).value=previous;return;}
      previous=control;
    };
  }
  $('semantic-wrap-mode').onchange=()=>{clearProposal();const hidden=$('semantic-wrap-mode').value!=='burst';for(const id of ['semantic-wrap-outer-control','semantic-wrap-outer-clock','semantic-wrap-outer-count'])if($(id).parentElement)$(id).parentElement.hidden=hidden;};
  $('semantic-wrap-mode').onchange();
  $('semantic-propose').onclick=()=>propose(command());
  $('semantic-convert').onclick=()=>propose({type:'flatten',id:session.selectionId!,scope:selected()?.kind==='repeat'?'pattern':'segment'});
  $('semantic-cancel-edit').onclick=clearProposal;
  $('semantic-apply-edit').onclick=()=>{
    if(!pending) return;
    const result=session.commitProposal(pending);
    if(!result.ok){message('semantic-proposal',diagnosticText(result.diagnostics),true);state();return;}
    source.value=session.source;if(pendingSelection)session.select(pendingSelection);clearProposal();render();message('text-message',`Semantic edit applied. Source, plot, and export use revision ${session.revision}.`);
  };
  for(const action of ['undo','redo'] as const) $(action).onclick=(event:any)=>{
    if(!active)return original[action]?.call($(action),event);
    const result=session[action]();
    if(!result.ok){message('text-message',diagnosticText(result.diagnostics),true);return;}
    clearProposal();source.value=session.source;render();message('text-message',`${action==='undo'?'Previous':'Next'} semantic revision restored.`);
  };
  $('download').onclick=(event:any)=>{
    try { const result=prepareExport(), name=active ? session.result!.document.name : pointDocument().name;
      const download=exportDownload(result,name), url=URL.createObjectURL(download.blob), link=document.createElement('a');link.href=url;link.download=download.filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),2000);message('global-message',`Local download started: ${download.filename}.`);
    }catch(e){message('global-message',(e as Error).message,true);}
  };
  function showMigration(text:string) {
    const migration=session.previewMigration(text); $('legacy-preview').hidden=false;
    migrationKey=sourceOpenKey();
    $('legacy-original').textContent=migration.legacy.sourceText;
    $('legacy-candidate').textContent=migration.candidateSource || 'No valid migration candidate.';
    $('legacy-differences').textContent=[`Shape equivalent: ${migration.shapeEquivalent}`,`Legacy points: ${JSON.stringify(migration.legacy.points)}`,...migration.legacy.warnings,...migration.legacy.diagnostics.map(d=>d.message),...migration.differences.map(d=>`${d.code}: ${d.message}`)].join('\n');
    $('apply-migration').disabled=!migration.candidate?.ok || !migration.shapeEquivalent;
    message('global-message','Legacy YAML preview only. Review the original, warnings, points, candidate, and differences before applying.');
  }
  $('open-file').onchange=async(event:any)=>{
    const file=event.target.files[0];if(!file)return;
    if(!canSwitch()){event.target.value='';return;}
    const ticket=++sourceOpenGeneration,key=sourceOpenKey(),projectTicket=projectControls?.reserve();
    try {
      const lower=file.name.toLowerCase();
      const csvTicket=lower.endsWith('.csv')?digitize?.reserveCSVOffer():undefined;
      if(file.size>1024*1024)throw Error('The source file exceeds 1 MiB.');
      const text=typeof file.arrayBuffer==='function' ? new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await file.arrayBuffer()) : await file.text();
      if(ticket!==sourceOpenGeneration)return;
      if(csvTicket&&!csvTicket.current())return;
      if(projectTicket && !projectControls?.current(projectTicket.ticket))return;
      if(key!==sourceOpenKey())throw Error('The project changed while opening the source. Open it again.');
      if(lower.endsWith('.csv')) {
        if(!digitize)throw Error('The CSV mapping controls are unavailable.');
        digitize.offerCSV(text,file.name,csvTicket);
        message('global-message','CSV candidate opened in Trace an image. Confirm its columns and units before reconstruction.');
      } else if(/\.ya?ml$/.test(lower)) {
        const result=compileYaml(text);
        if(result.ok || /^\s*schema\s*:/m.test(text)) semanticMode(text); else {showMigration(text);migrationTicket=projectTicket?.ticket;}
      } else if(lower.endsWith('.json')) {
        const project=JSON.parse(text.replace(/^\uFEFF/,''));
        if(projectControls) {
          const semantic=project.format==='wavecraft-semantic-project/1' && typeof project.sourceText==='string';
          if(!semantic && (project.format!==undefined || project.schema!==undefined))throw Error('This JSON project format or schema is not supported.');
          if(!semantic && (project.version!==1 || !Array.isArray(project.points)))throw Error('This JSON project schema is not supported.');
          const evidence:ProjectEvidence={};
          if(!semantic && project.source) {
            const legacy=project.source;
            evidence.notes='Legacy image metadata has no image bytes. Attach the original image.';
            if(Array.isArray(legacy.rawTrace))evidence.rawPoints=legacy.rawTrace;
            if(legacy.calibration)evidence.calibration=legacy.calibration;
            if(Array.isArray(legacy.pixelSize))evidence.transforms={originalSize:legacy.pixelSize,viewSize:legacy.pixelSize,crop:null,reference:'unavailable'};
          }
          await projectControls.preview({revisionId:`migration-${Date.now()}`,mode:semantic?'semantic':'points',source:semantic?project.sourceText:text,evidence},`Legacy JSON migration: ${file.name}. Image bytes are not included.`,projectTicket?.ticket,projectTicket?.key);
        } else if(project.format==='wavecraft-semantic-project/1' && typeof project.sourceText==='string')semanticMode(project.sourceText);
        else {if(active)pointMode();await original.open?.call($('open-file'),event);}
      } else throw Error('Use a JSON, CSV, or YAML source file. Open external CSV in Trace an image for explicit mapping.');
    }catch(e){if(ticket===sourceOpenGeneration && (!projectTicket || projectControls?.current(projectTicket.ticket)))message('global-message',(e as Error).message,true);}
    finally{event.target.value='';}
  };
  $('apply-migration').onclick=()=>{if(!canSwitch())return;if(migrationKey!==sourceOpenKey() || migrationTicket!==undefined && !projectControls?.current(migrationTicket)){message('global-message','This migration preview is stale. Open the source again.',true);return;}if(session.applyMigration()){active=true;$('source-mode').value='semantic';source.value=session.source;render();message('text-message','Migration applied explicitly. The original remains in the preview.');}};
  $('cancel-migration').onclick=()=>{session.migration=undefined;migrationKey='';$('legacy-preview').hidden=true;message('global-message','Migration preview canceled.');};
  for(const id of ids) {
    const handler=$(id).onclick;
    if(handler) $(id).onclick=(event:any)=>{if(active){message('plot-message','Edit and apply semantic YAML to change this waveform.',true);return;}return handler.call($(id),event);};
  }
  for(const id of ['scenario-edit','scenario-conflict','scenario-periodic','scenario-burst']){const handler=$(id).onclick;$(id).onclick=(event:any)=>{if(!canSwitch())return;if(active)pointMode();handler?.call($(id),event);};}
  (globalThis as any).WaveSemanticEditor={get active(){return active;},draw,preview,session};
  function pointRepetitionDraft() {
    if (active || point.isDirty()) return false;
    try {
      const project = pointDocument(), repeat = project.repetition || {mode:'single'}, mode = $('repeat-mode').value;
      if (mode !== repeat.mode) return true;
      const differs = (id:string, expected:number) => !Number.isFinite(Number($(id).value)) || $(id).value.trim() === '' || Math.abs(Number($(id).value) - expected) > Math.max(Math.abs(expected) * 1e-12, Number.MIN_VALUE);
      if (mode !== 'single' && (differs('repeat-period',repeat.periodUs) || differs('repeat-frequency',1e6/repeat.periodUs))) return true;
      return mode === 'burst' && (differs('repeat-count',repeat.count) || differs('burst-period',repeat.burstPeriodUs) || differs('burst-frequency',1e6/repeat.burstPeriodUs));
    } catch { return false; }
  }
  const spectrum = mountSpectrumPanel(() => ({
    key: active ? `semantic|${session.revision}|${session.source}` : `points|${source.value}`,
    dirty: active ? session.dirty : point.isDirty() || pointRepetitionDraft(),
    dirtyMessage: !active && pointRepetitionDraft() ? 'Repetition settings pending. Apply repetition or restore valid text before analysis.' : undefined,
    repeats: active ? (session.result?.compiled.nodes.filter(node => node.kind === 'repeat').map(node => node.id) || []) : [],
    proposal: active && !!pending,
    input: (repeatId, level) => {
      if (active) return session.result ? semanticSpectrumInput(session.result.compiled, repeatId, level) : {ok:false, diagnostics:['Apply a valid semantic document before analysis.']};
      try { return pointSpectrumInput(pointDocument(), level); }
      catch (error) { return {ok:false, diagnostics:[(error as Error).message]}; }
    }
  }));
  spectrumRefresh = spectrum.refresh;
  // Observe existing handlers after they update the committed source.
  for (const id of ['source','source-mode','apply-text','discard-text','undo','redo','open-file','add','remove','update-point','apply-slew','apply-repeat','use-trace','scenario-edit','scenario-conflict','scenario-periodic','scenario-burst','semantic-load-sample','semantic-new','semantic-apply-edit','semantic-cancel-edit','semantic-propose','semantic-add-segment','semantic-wrap','apply-migration']) {
    const element = $(id);
    for (const name of ['onclick','oninput','onchange']) {
      const handler = element[name];
      if (handler) element[name] = function(this:any, event:any) {
        digitize?.invalidate();
        const outcome = handler.call(this,event);
        if (outcome && typeof outcome.then === 'function') return outcome.finally(()=>{spectrumRefresh();preview();projectControls?.changed();});
        spectrumRefresh(); preview(); projectControls?.changed(); return outcome;
      };
    }
  }
  for (const id of ['repeat-mode','repeat-period','repeat-frequency','repeat-count','burst-period','burst-frequency']) {
    const element = $(id), name = id === 'repeat-mode' ? 'onchange' : 'oninput', handler = element[name];
    element[name] = function(this:any,event:any) { digitize?.invalidate();const outcome = handler?.call(this,event); spectrumRefresh(); preview(); projectControls?.changed(); return outcome; };
  }
  // Point dragging commits in its pre-existing pointerup listener.
  $('plot').addEventListener('pointerup',()=>{digitize?.invalidate();spectrumRefresh();preview();projectControls?.changed();});
  $('plot').addEventListener('pointercancel',()=>{digitize?.invalidate();spectrumRefresh();preview();projectControls?.changed();});
  (globalThis as any).WaveSpectrumPanel = spectrum;
  if(point.project) {
    const key=()=>JSON.stringify([active,active?session.committedSource:pointSource(),active?session.source:source.value,active?session.selectionId:point.project.selection(),point.project.evidenceKey(),digitize?.key()||'',projectNotesPresent,$('project-notes').value,...['repeat-mode','repeat-period','repeat-frequency','repeat-count','burst-period','burst-frequency'].map(id=>$(id).value)]);
    projectControls=mountProjectControls({
      key,
      dirty:()=>active?session.dirty:point.isDirty()||pointRepetitionDraft(),
      snapshot:async revisionId=>{
        const preserved=digitize?.hostEvidence(),evidence=preserved?Object.fromEntries(Object.entries(preserved).filter(([key])=>!['notes','digitization'].includes(key))):await point.project.evidence();
        const notes=$('project-notes').value;
        const combined=evidence.notes && !notes.includes(evidence.notes)?[notes,evidence.notes].filter(Boolean).join('\n'):notes;
        return {revisionId,mode:active?'semantic':'points',source:active?session.committedSource:pointSource(),evidence:{...evidence,...digitize?.evidence(),...combined||projectNotesPresent?{notes:combined}:{}}};
      },
      draft:()=>({text:(active?session.dirty:point.isDirty())?source.value:null,selection:active?session.selectionId:point.project.selection()}),
      prepare:async snapshot=>{
        validateProject(snapshot);
        if(snapshot.mode==='semantic') {const result=compileYaml(snapshot.source);if(!result.ok)throw Error(diagnosticText(result.diagnostics));}
        else point.project.validate(snapshot.source);
        const decoded=await point.project.prepareEvidence(snapshot.evidence);
        return ()=>{
          clearProposal();
          // Validation and image decoding finish before any active state changes.
          if(snapshot.mode==='semantic') {
            point.project.resetHistory();
            session.restoreRecovery({version:1,committedSource:snapshot.source,draft:null,selectionId:null});
            active=true;$('source-mode').value='semantic';source.value=session.source;
          }
          else {
            if(session.result)session.restoreRecovery({version:1,committedSource:session.committedSource,draft:null,selectionId:session.selectionId});
            active=false;point.project.install(snapshot.source);pointMode();
          }
          point.project.installEvidence(snapshot.evidence,decoded);
          digitize?.install(snapshot.evidence.digitization,snapshot.evidence);
          $('project-notes').value=snapshot.evidence.notes||'';
          projectNotesPresent=Object.hasOwn(snapshot.evidence,'notes');
          render();
        };
      },
      restoreDraft:draft=>{
        if(active){session.select(typeof draft.selection==='string'?draft.selection:null);if(draft.text!==null){session.draft(draft.text);source.value=draft.text;}render();}
        else {point.project.setDraft(draft.text,draft.selection);state();preview();spectrumRefresh();}
      }
    });
    (globalThis as any).WaveProjectControls=projectControls;
    const notesHandler=$('project-notes').oninput;
    $('project-notes').oninput=(event:any)=>{digitize?.invalidate();projectNotesPresent=true;notesHandler?.(event);};
    for(const id of ['point-choice','semantic-selection']) {const element=$(id),handler=element.onchange;element.onchange=function(event:any){const result=handler?.call(this,event);projectControls?.changed();return result;};}
  }
  digitize=mountDigitizeControls({
    trace:point.project,
    key:sourceOpenKey,
    dirty:()=>active?session.dirty:point.isDirty()||pointRepetitionDraft(),
    changed:()=>projectControls?.changed(),
    commit:async(text,notes)=>{
      const checked=compileYaml(text);if(!checked.ok)throw Error(diagnosticText(checked.diagnostics));
      const key=JSON.stringify([sourceOpenKey(),digitize?.candidateKey()]),ticket=projectControls?.reserve(),nextNotes=[$('project-notes').value,notes].filter(Boolean).join('\n');
      const evidence=await point.project.evidence();
      if((active?session.dirty:point.isDirty()||pointRepetitionDraft())||key!==JSON.stringify([sourceOpenKey(),digitize?.candidateKey()])||ticket&&!projectControls?.current(ticket.ticket))throw Error('The project changed during reconstruction acceptance. Review the staged reconstruction again.');
      const combined=evidence.notes&&!nextNotes.includes(evidence.notes)?[nextNotes,evidence.notes].filter(Boolean).join('\n'):nextNotes;
      // Validate the complete portable project before changing the committed source.
      const candidateEvidence={...evidence,...digitize?.candidateEvidence(),notes:combined};
      packProject({revisionId:'reconstruction-preview',mode:'semantic',source:text,evidence:candidateEvidence});
      digitize?.adopt(candidateEvidence);
      semanticMode(text);
      $('project-notes').value=combined;projectNotesPresent=true;
      spectrumRefresh();preview();projectControls?.changed();
      message('text-message','Reconstruction accepted as explicit semantic points. Raw evidence stays separate.');
    }
  });
  (globalThis as any).WaveDigitizeControls=digitize;
  preview();
}

if (typeof window !== 'undefined') (globalThis as any).WaveSemantic = {mount: mountSemanticEditor, mountMeasurements};
