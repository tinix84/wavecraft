import { isMap, isScalar, isSeq } from 'yaml';
import { expandFinite } from '../semantic/index.ts';
import type { CompiledLeaf, CompiledRepeat, CompiledWaveform, Diagnostic, Point, SourcePath } from '../semantic/index.ts';
import { replaceScalars, serializeSource } from './document.ts';
import type { SourceDocument } from './document.ts';
import type { EditCommand, SourceEntry, ValidCompile } from './types.ts';
import { parseQuantity } from '../semantic/units.ts';

export class EditFailure extends Error {
  diagnostics: Diagnostic[];
  constructor(code: string, message: string, path: SourcePath = []) {
    super(message);
    this.diagnostics = [{ code, severity: 'error', message, source: { path } }];
  }
}
const reject = (message: string, path: SourcePath = []): never => { throw new EditFailure('EDIT_COMMAND', message, path); };

function flattenPoints(nodes: (CompiledLeaf | CompiledRepeat)[], start: number, duration: number, dimension: 'current' | 'voltage'): Point[] {
  if (!Number.isFinite(duration)) throw new EditFailure('FLATTEN_UNBOUNDED', 'Select a finite segment. Continuous repetition cannot become a finite point sequence.');
  const first = nodes[0];
  const initial = first.kind === 'repeat' ? first.pattern[0].points[0][1] : first.points[0][1];
  const shifted = nodes.map(node => node.kind === 'repeat'
    ? { ...node, timing: { ...node.timing, startS: node.timing.startS - start, endS: node.timing.endS - start } }
    : { ...node, points: node.points.map(([t, v]) => [t - start, v] as Point), timing: { ...node.timing, startS: node.timing.startS - start, endS: node.timing.endS - start } });
  const last = nodes.at(-1)!;
  const final = last.kind === 'repeat' ? initial : last.points.at(-1)![1];
  const waveform: CompiledWaveform = { dimension, initialValue: initial, finalValue: final, durationS: duration, continuous: false, nodes: shifted };
  const expanded = expandFinite(waveform);
  if (!expanded.ok) { const failure = new EditFailure('FLATTEN_LIMIT', 'The selected segment exceeds the point conversion limit.'); failure.diagnostics = expanded.diagnostics; throw failure; }
  return expanded.points;
}

export function commandSource(source: string, original: SourceDocument, result: ValidCompile, entries: Map<string, SourceEntry>, request: EditCommand): { source: string; warnings: string[] } {
  const doc = original.clone() as SourceDocument;
  const edits: { path: SourcePath; value: string | number }[] = [];
  let structural = false;
  const warnings: string[] = [];
  const entry = (id: string, kind?: string) => {
    const e = entries.get(id);
    if (!e || e.id !== e.ownerId && e.kind !== 'point' || kind && e.kind !== kind) return reject('Select an authored item with the required kind.');
    return e;
  };
  const set = (path: SourcePath, value: string | number) => {
    const node = doc.getIn(path, true);
    if (isScalar(node)) node.value = value;
    else { doc.setIn(path, value); structural = true; }
    edits.push({ path, value });
  };
  const remove = (path: SourcePath) => { if (doc.deleteIn(path)) structural = true; };
  const commands = request.type === 'batch' ? request.commands : [request];
  if (!commands.length || commands.some(command => !['target','nominal','initial','max-slew','ramp-control','timing','hold-duration','point','repeat-clock','repeat-count'].includes(command.type)) && request.type === 'batch') reject('Use one or more scalar commands in a combined edit.');
  for (const command of commands) switch (command.type) {
    case 'nominal': set(['signal', 'nominal'], command.value); break;
    case 'initial': set(['signal', 'initial'], command.value); break;
    case 'max-slew': {
      const p = [...entry(command.id, 'ramp').path, 'maxSlew'];
      if (command.value === null) remove(p); else set(p, command.value);
      break;
    }
    case 'insert-point': {
      const p = [...entry(command.id, 'points').path, 'points'];
      const seq = doc.getIn(p, true);
      if (!isSeq(seq)) reject('Select an explicit point sequence.', p);
      let index = seq.items.length;
      if (command.beforeId) {
        const before = entry(command.beforeId, 'point');
        if (JSON.stringify(before.path.slice(0, -1)) !== JSON.stringify(p)) reject('Select a point in this sequence.', p);
        index = Number(before.path.at(-1));
      }
      seq.items.splice(index, 0, doc.createNode(command.point)); structural = true; break;
    }
    case 'remove-point': remove(entry(command.id, 'point').path); break;
    case 'wrap-repeat': {
      if (!command.ids.length || new Set(command.ids).size !== command.ids.length) reject('Select an ordered pattern of distinct segments.');
      const selected = command.ids.map(id => entry(id));
      const start = Number(selected[0].path[1]);
      if (selected.some((item, i) => item.path.length !== 2 || item.path[0] !== 'segments' || item.path[1] !== start + i || !['hold','ramp','points'].includes(item.kind))) reject('Select contiguous top-level leaf segments.');
      const seq = doc.getIn(['segments'], true);
      if (!isSeq(seq)) reject('Select the top-level sequence.');
      const firstIndex = result.compiled.nodes.findIndex(n => n.id === command.ids[0]);
      let origin = result.compiled.nodes[firstIndex].timing.startS;
      const preceding = result.compiled.nodes[firstIndex - 1];
      if (preceding?.kind === 'idle' && preceding.source.id === command.ids[0]) origin = preceding.timing.startS;
      const pattern = seq.items.slice(start, start + selected.length);
      for (const node of pattern) if (isMap(node) && node.has('arriveAt')) {
        const arrival = parseQuantity(node.get('arriveAt'), 'time');
        node.set('arriveAt', `${arrival - origin} s`);
        warnings.push('Wrapping changes the absolute arrival time to the local pattern clock. Review the rebased arrival before applying.');
      }
      const repeat = doc.createNode({ ...command.repeat, kind: 'repeat', pattern: [] });
      repeat.set('pattern', doc.createNode([]));
      const target = repeat.get('pattern', true);
      if (!isSeq(target)) reject('The repeat pattern is unavailable.');
      target.items.push(...pattern);
      seq.items.splice(start, selected.length, repeat); structural = true; break;
    }
    case 'target': set([...entry(command.id, 'ramp').path, 'to'], command.value); break;
    case 'hold-duration': set([...entry(command.id, 'hold').path, 'duration'], command.value); break;
    case 'timing': {
      const path = [...entry(command.id, 'ramp').path, 'arriveAt'];
      if (command.arriveAt === null) remove(path); else set(path, command.arriveAt);
      break;
    }
    case 'ramp-control': {
      const p = entry(command.id, 'ramp').path;
      if (command.control !== 'duration' && command.control !== 'slew') reject('Select duration or slew.', p);
      remove([...p, command.control === 'duration' ? 'slew' : 'duration']);
      set([...p, command.control], command.value);
      break;
    }
    case 'point': {
      const p = entry(command.id, 'point').path;
      if (command.time === undefined && command.value === undefined) reject('Supply a point time or value.', p);
      if (command.time !== undefined) set([...p, 'time'], command.time);
      if (command.value !== undefined) set([...p, 'value'], command.value);
      break;
    }
    case 'repeat-clock':
    case 'repeat-count': {
      const p = [...entry(command.id, 'repeat').path];
      if (command.level !== 'inner' && command.level !== 'outer') reject('Select the inner or outer repeat level.', p);
      if (command.level === 'outer') {
        p.push('outer');
        if (!isMap(doc.getIn(p, true))) reject('This repeat has no outer schedule.', p);
      }
      if (command.type === 'repeat-count') set([...p, 'count'], command.count);
      else {
        if (command.control !== 'period' && command.control !== 'frequency') reject('Select period or frequency.', p);
        remove([...p, command.control === 'period' ? 'frequency' : 'period']);
        set([...p, command.control], command.value);
      }
      break;
    }
    case 'insert-segment': {
      const p: SourcePath = command.parentId ? [...entry(command.parentId, 'repeat').path, 'pattern'] : ['segments'];
      const seq = doc.getIn(p, true);
      if (!isSeq(seq)) reject('Select a segment sequence.', p);
      let index = seq.items.length;
      if (command.beforeId) {
        const before = entry(command.beforeId);
        if (JSON.stringify(before.path.slice(0, -1)) !== JSON.stringify(p)) reject('The insertion reference must belong to the selected sequence.', p);
        index = Number(before.path.at(-1));
      }
      seq.items.splice(index, 0, doc.createNode(command.segment));
      structural = true;
      break;
    }
    case 'remove-segment': {
      const e = entry(command.id);
      if (e.kind === 'point') reject('Select a segment to remove.', e.path);
      remove(e.path);
      break;
    }
    case 'flatten': {
      const e = entry(command.id);
      if (command.scope !== undefined && command.scope !== 'segment' && command.scope !== 'pattern') reject('Select segment or pattern conversion.', e.path);
      if (e.kind === 'point' || e.kind === 'points') reject('Select a structured segment to convert.', e.path);
      let timeline: (CompiledLeaf | CompiledRepeat)[] = result.compiled.nodes;
      if (e.path.includes('pattern')) {
        const repeat = result.compiled.nodes.find(n => n.kind === 'repeat' && n.source.path[1] === e.path[1]);
        if (!repeat || repeat.kind !== 'repeat') reject('The selected pattern is unavailable.', e.path);
        timeline = repeat.pattern;
      }
      const selected = timeline.find(n => n.id === command.id && !('derived' in n && n.derived));
      if (!selected) reject('The selected compiled segment is unavailable.', e.path);
      const pattern = command.scope === 'pattern';
      if (pattern && selected.kind !== 'repeat') reject('Select a repeat to convert its pattern.', e.path);
      let nodes: (CompiledLeaf | CompiledRepeat)[], start: number, duration: number;
      if (pattern && selected.kind === 'repeat') {
        nodes = selected.pattern.filter(n => !(n.derived && n.id === `${selected.id}:idle`));
        start = 0; duration = selected.patternDurationS;
      } else {
        const index = timeline.indexOf(selected);
        const idle = timeline[index - 1];
        nodes = idle && idle.kind === 'idle' && idle.source.id === selected.source.id ? [idle, selected] : [selected];
        start = nodes[0].timing.startS; duration = selected.timing.endS - start;
      }
      const points = flattenPoints(nodes, start, duration, result.compiled.dimension);
      const ids = new Set(entries.keys());
      const pointSegmentId = pattern ? uniqueId(`${command.id}:points`, ids) : command.id;
      const unit = result.compiled.dimension === 'current' ? 'A' : 'V';
      const replacement = { id: pointSegmentId, kind: 'points', points: points.map(([t, value], i) => ({ id: uniqueId(`${pointSegmentId}:point:${i + 1}`, ids), time: `${t} s`, value: `${value} ${unit}` })) };
      const old = doc.getIn(e.path, true);
      if (pattern) doc.setIn([...e.path, 'pattern'], doc.createNode([replacement]));
      else {
        const node = doc.createNode(replacement);
        if (isMap(old)) { node.comment = old.comment; node.commentBefore = old.commentBefore; node.spaceBefore = old.spaceBefore; }
        doc.setIn(e.path, node);
      }
      structural = true;
      warnings.push('Conversion to points removes percentage intent, ramp controls, timing anchors, and other structured constraints from the selected shape.');
      break;
    }
    default: reject('The edit command is not supported.');
  }
  const latestEdits = [...new Map(edits.map(edit => [JSON.stringify(edit.path),edit])).values()];
  const bounded = !structural ? replaceScalars(source, original, latestEdits) : undefined;
  return { source: bounded ?? serializeSource(doc, source), warnings };
}

function uniqueId(base: string, used: Set<string>): string {
  let candidate = base, suffix = 2;
  while (used.has(candidate)) candidate = `${base}:${suffix++}`;
  used.add(candidate);
  return candidate;
}
