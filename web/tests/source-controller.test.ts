import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';
import { evaluate } from '../src/semantic/index.ts';
import { SemanticController } from '../src/source/controller.ts';
import type { EditCommand, EditProposal } from '../src/source/controller.ts';

const source = `schema: wavecraft/1
name: Source fixture
signal: {dimension: current, nominal: 240 A, initial: 0 A}
segments:
  - {id: rise, kind: ramp, to: 175%, slew: 6 A/us}
  - {id: top, kind: hold, duration: 2 ms}
  - {id: fall, kind: ramp, to: 60 A, duration: 10 us}
`;
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) <= Math.max(1e-18, Math.abs(expected) * 1e-10), `${actual} != ${expected}`);
function proposal(controller: SemanticController, command: EditCommand): EditProposal {
  const result = controller.propose(command);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('Expected a valid proposal');
  return result.proposal;
}
function edit(controller: SemanticController, command: EditCommand): EditProposal {
  const p = proposal(controller, command);
  assert.deepEqual(controller.commitProposal(p), { ok: true });
  return p;
}
const burst = `schema: wavecraft/1
name: Burst
signal: {dimension: current, initial: 0 A}
segments:
  - id: burst
    kind: repeat
    period: 10 us
    count: 3
    outer: {period: 100 us, count: 2}
    pattern:
      - {id: rise, kind: ramp, to: 6 A, duration: 1 us}
      - {id: fall, kind: ramp, to: 0 A, duration: 1 us}
`;

test('percentage target proposes independently calculated 480 A and 80 us with downstream timing', () => {
  const c = new SemanticController(source), original = c.result;
  assert.equal(c.exportSource(), source);
  assert.equal(c.result!.compiled.nodes[0].points.at(-1)![1], 420);
  close(c.result!.compiled.nodes[0].timing.endS, 70e-6);
  const p = proposal(c, { type: 'target', id: 'rise', value: '200%' });
  assert.equal(c.result, original); assert.equal(c.source, source); assert.equal(c.canUndo, false);
  assert.equal(p.result.document.segments[0].kind === 'ramp' && p.result.document.segments[0].to, '200%');
  assert.equal(p.result.compiled.nodes[0].points.at(-1)![1], 480);
  close(p.result.compiled.nodes[0].timing.endS, 80e-6);
  assert.deepEqual(p.changes.map(v => v.id), ['rise', 'top', 'fall']);
  assert.deepEqual(c.commitProposal(p), { ok: true });
  assert.equal(c.canUndo, true);
  close(evaluate(c.result!.compiled, 40e-6), 240);
});

test('nominal edits rescale percentage targets while absolute targets remain literal', () => {
  const c = new SemanticController(source);
  edit(c, { type: 'nominal', value: '120 A' });
  assert.equal(c.result!.compiled.nodes[0].points.at(-1)![1], 210);
  close(c.result!.compiled.nodes[0].timing.durationS, 35e-6);
  assert.equal(c.result!.compiled.finalValue, 60);
  assert.equal(c.source, source.replace('nominal: 240 A', 'nominal: 120 A'));
});

test('scalar replacement preserves BOM, CRLF, quotes, comments and every unrelated byte', () => {
  const original = '\uFEFF' + source.replace('to: 175%', "to: '175%'").replace('slew: 6 A/us}', 'slew: "6 A/us"} # remain').replaceAll('\n', '\r\n');
  const c = new SemanticController(original);
  edit(c, { type: 'target', id: 'rise', value: '200%' });
  assert.equal(c.exportSource(), original.replace("'175%'", "'200%'"));
  edit(c, { type: 'ramp-control', id: 'rise', control: 'slew', value: '8 A/us' });
  assert.equal(c.exportSource(), original.replace("'175%'", "'200%'").replace('"6 A/us"', '"8 A/us"'));
  const before = c.exportSource();
  assert.equal(c.propose({ type: 'target', id: 'rise', value: '200%\nsegments: []' }).ok, false);
  assert.equal(c.exportSource(), before);
});

test('mixed text and command history restores source intent, numeric values and exact text', () => {
  const c = new SemanticController(source);
  edit(c, { type: 'target', id: 'rise', value: '200%' });
  const changed = c.source;
  c.setDraft(changed.replace('nominal: 240 A', 'nominal: 120 A'));
  assert.equal(c.applyDraft().ok, true);
  assert.equal(c.result!.compiled.nodes[0].points.at(-1)![1], 240);
  assert.equal(c.undo().ok, true); assert.equal(c.source, changed);
  assert.equal(c.result!.compiled.nodes[0].points.at(-1)![1], 480);
  assert.equal(c.undo().ok, true); assert.equal(c.source, source);
  assert.equal(c.result!.compiled.nodes[0].points.at(-1)![1], 420);
  assert.equal(c.redo().ok, true); assert.equal(c.redo().ok, true);
  assert.equal(c.result!.compiled.nodes[0].points.at(-1)![1], 240);
});

test('AST insertion, control switching and removal regenerate paths and token ranges', () => {
  const c = new SemanticController(source.replace('  - {id: top', '  # Keep the plateau comment\n  - {id: top'));
  edit(c, { type: 'insert-segment', segment: { id: 'lead', kind: 'hold', duration: '5 us' }, beforeId: 'rise' });
  assert.deepEqual(c.sourceMap.get('rise')!.path, ['segments', 1]);
  const range = c.sourceMap.get('rise')!.range!;
  assert.ok(c.source.slice(range[0], range[1]).includes('175%'));
  edit(c, { type: 'target', id: 'rise', value: '200%' });
  assert.ok(c.source.includes('to: 200%'));
  edit(c, { type: 'ramp-control', id: 'rise', control: 'duration', value: '50 us' });
  const doc = parseDocument(c.source);
  assert.equal(doc.getIn(['segments', 1, 'slew']), undefined);
  assert.equal(doc.getIn(['segments', 1, 'duration']), '50 us');
  assert.ok(c.source.includes('# Keep the plateau comment'));
  edit(c, { type: 'remove-segment', id: 'lead' });
  assert.deepEqual(c.sourceMap.get('rise')!.path, ['segments', 0]);
  const fresh = c.sourceMap.get('rise')!.range!;
  assert.ok(c.source.slice(fresh[0], fresh[1]).includes('50 us'));
  edit(c, { type: 'target', id: 'rise', value: '220%' });
  assert.equal(c.result!.compiled.nodes[0].points.at(-1)![1], 528);
});

test('rejected anchor, slew and repeat commands preserve source, preview, revision and redo history', () => {
  const anchored = source.replace('slew: 6 A/us}', 'slew: 6 A/us, arriveAt: 100 us}');
  const c = new SemanticController(anchored);
  edit(c, { type: 'target', id: 'rise', value: '200%' }); c.undo();
  const before = c.result, revision = c.revision;
  for (const command of [
    { type: 'timing', id: 'rise', arriveAt: '1 us' },
    { type: 'ramp-control', id: 'rise', control: 'slew', value: '0 A/us' },
  ] as EditCommand[]) assert.equal(c.propose(command).ok, false);
  assert.equal(c.source, anchored); assert.equal(c.result, before); assert.equal(c.revision, revision); assert.equal(c.canRedo, true);
  const r = new SemanticController(burst), result = r.result;
  for (const command of [
    { type: 'repeat-clock', id: 'burst', level: 'inner', control: 'period', value: '1 us' },
    { type: 'repeat-count', id: 'burst', level: 'inner', count: 20 },
    { type: 'target', id: 'fall', value: '1 A' },
  ] as EditCommand[]) assert.equal(r.propose(command).ok, false);
  assert.equal(r.source, burst); assert.equal(r.result, result); assert.equal(r.canUndo, false);
});

test('invalid draft survives selection and recovery and blocks commands, history and export', () => {
  const c = new SemanticController(source); c.select('rise');
  edit(c, { type: 'target', id: 'rise', value: '200%' });
  c.setDraft('schema: [unfinished');
  const last = c.result;
  c.select('top'); assert.equal(c.source, 'schema: [unfinished');
  assert.equal(c.applyDraft().ok, false); assert.equal(c.undo().ok, false);
  assert.equal(c.propose({ type: 'nominal', value: '120 A' }).ok, false);
  assert.throws(() => c.exportSource(), /draft/);
  assert.equal(c.result, last);
  const recovered = new SemanticController();
  assert.equal(recovered.restoreRecovery(c.exportRecovery()).ok, true);
  assert.equal(recovered.source, 'schema: [unfinished'); assert.equal(recovered.selectionId, 'top');
  assert.equal(recovered.result!.compiled.nodes[0].points.at(-1)![1], 480);
  assert.throws(() => recovered.exportSource(), /draft/);
  recovered.restoreDraft(); assert.equal(recovered.exportSource(), c.committedSource);
  const invalidInitial = new SemanticController('not: [valid');
  assert.equal(new SemanticController().restoreRecovery(invalidInitial.exportRecovery()).ok, true);
});

test('stale, foreign and caller-mutated proposals cannot replace validated state', () => {
  const c = new SemanticController(source), other = new SemanticController(source);
  const stale = proposal(c, { type: 'target', id: 'rise', value: '200%' });
  edit(c, { type: 'nominal', value: '120 A' });
  assert.equal(c.commitProposal(stale).ok, false);
  assert.equal(other.commitProposal(stale).ok, false);
  const p = proposal(c, { type: 'target', id: 'rise', value: '200%' });
  p.source = 'invalid'; p.result.compiled.finalValue = 999;
  assert.equal(c.commitProposal(p).ok, true);
  assert.equal(c.result!.compiled.finalValue, 60);
  assert.ok(c.source.includes('to: 200%'));
  const draftStale = proposal(c, { type: 'nominal', value: '240 A' });
  c.setDraft('invalid'); c.restoreDraft();
  assert.equal(c.commitProposal(draftStale).ok, false);
  assert.throws(() => { c.result!.compiled.finalValue = 999; }, TypeError);
  c.sourceMap.clear(); assert.ok(c.sourceMap.has('rise'));
});

test('finite flatten keeps anchored idle, shape, downstream timing, warning, and exact undo', () => {
  const original = source.replace('slew: 6 A/us}', 'slew: 6 A/us, arriveAt: 100 us}');
  const c = new SemanticController(original), before = c.result!.compiled;
  const p = proposal(c, { type: 'flatten', id: 'rise' });
  assert.match(p.warnings[0], /percentage intent/);
  close(p.result.compiled.durationS, before.durationS);
  for (const t of [0, 15e-6, 30e-6, 65e-6, 100e-6, 500e-6, before.durationS]) close(evaluate(p.result.compiled, t), evaluate(before, t));
  c.commitProposal(p);
  assert.equal(c.result!.document.segments[0].kind, 'points');
  assert.equal(c.undo().ok, true); assert.equal(c.source, original);
});

test('pattern flatten keeps repeat clocks and count while segment flatten retains finite idle and endpoint', () => {
  const c = new SemanticController(burst), before = c.result!.compiled;
  edit(c, { type: 'flatten', id: 'burst', scope: 'pattern' });
  const repeat = c.result!.document.segments[0];
  assert.equal(repeat.kind, 'repeat');
  if (repeat.kind !== 'repeat') throw new Error('Expected repeat');
  assert.equal(repeat.count, 3); assert.equal(repeat.period, '10 us'); assert.equal(repeat.outer!.count, 2);
  close(c.result!.compiled.durationS, 200e-6);
  for (const t of [0, 0.5e-6, 1e-6, 1.5e-6, 2e-6, 10.5e-6, 30e-6, 100.5e-6, 199e-6]) close(evaluate(c.result!.compiled, t), evaluate(before, t));
  c.undo();
  edit(c, { type: 'flatten', id: 'burst' });
  assert.equal(c.result!.document.segments[0].kind, 'points');
  close(c.result!.compiled.durationS, 200e-6);
  for (const t of [0.5e-6, 22e-6, 99e-6, 100.5e-6, 199e-6]) close(evaluate(c.result!.compiled, t), evaluate(before, t));
  c.undo(); assert.equal(c.source, burst);
  const continuous = new SemanticController(burst.replace('count: 2}', 'count: continuous}'));
  assert.equal(continuous.propose({ type: 'flatten', id: 'burst' }).ok, false);
  assert.equal(continuous.propose({ type: 'flatten', id: 'burst', scope: 'pattern' }).ok, true);
});

test('point, hold, anchor removal, repeat clock/count and nested insertion commands preserve source ownership', () => {
  const c = new SemanticController(source);
  edit(c, { type: 'hold-duration', id: 'top', value: '3 ms' });
  edit(c, { type: 'timing', id: 'rise', arriveAt: '100 us' });
  assert.ok(c.sourceMap.has('rise:idle')); c.select('rise:idle'); assert.equal(c.selectionId, 'rise');
  edit(c, { type: 'timing', id: 'rise', arriveAt: null }); assert.equal(c.sourceMap.has('rise:idle'), false);
  edit(c, { type: 'flatten', id: 'rise' });
  const points = c.result!.document.segments[0];
  if (points.kind !== 'points') throw new Error('Expected points');
  edit(c, { type: 'point', id: points.points.at(-1)!.id, time: '80 us', value: '480 A' });
  close(c.result!.compiled.nodes[0].timing.endS, 80e-6);
  const r = new SemanticController(burst);
  edit(r, { type: 'repeat-clock', id: 'burst', level: 'inner', control: 'frequency', value: '50 kHz' });
  edit(r, { type: 'repeat-count', id: 'burst', level: 'outer', count: 3 });
  edit(r, { type: 'repeat-clock', id: 'burst', level: 'outer', control: 'frequency', value: '5 kHz' });
  edit(r, { type: 'insert-segment', parentId: 'burst', segment: { id: 'idle', kind: 'hold', duration: '1 us' } });
  close(r.result!.compiled.durationS, 600e-6);
  const repeat = r.result!.document.segments[0];
  assert.equal(repeat.kind === 'repeat' && repeat.frequency, '50 kHz');
  edit(r, { type: 'remove-segment', id: 'idle' });
  assert.equal(r.sourceMap.has('idle'), false);
});

test('conversion point IDs avoid existing IDs and oversized conversion rejects without history', () => {
  const c = new SemanticController(source.replace('id: top', 'id: rise:point:1'));
  edit(c, { type: 'flatten', id: 'rise' });
  const segment = c.result!.document.segments[0];
  if (segment.kind !== 'points') throw new Error('Expected points');
  assert.notEqual(segment.points[0].id, 'rise:point:1');
  assert.equal(new Set(c.sourceMap.keys()).size, c.sourceMap.size);
  const large = new SemanticController(burst.replace('count: 3', 'count: 1000000').replace('period: 100 us', 'period: 100 s'));
  const before = large.result;
  const rejected = large.propose({ type: 'flatten', id: 'burst' });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.diagnostics[0].code, 'RESOURCE_LIMIT');
  assert.equal(large.result, before); assert.equal(large.canUndo, false);
});

test('recovery rejection is atomic and first valid source starts the history baseline', () => {
  const c = new SemanticController();
  c.setDraft(source); assert.equal(c.applyDraft().ok, true); assert.equal(c.canUndo, false);
  c.select('top');
  const before = c.exportRecovery(), revision = c.revision;
  assert.equal(c.restoreRecovery({ ...before, committedSource: 'invalid' }).ok, false);
  assert.deepEqual(c.exportRecovery(), before); assert.equal(c.revision, revision);
  edit(c, { type: 'remove-segment', id: 'top' }); assert.equal(c.selectionId, null);
  c.undo(); assert.equal(c.selectionId, 'top'); assert.equal(c.source, source);
});

test('invalid runtime control and conversion scope reject atomically', () => {
  const c = new SemanticController(source);
  edit(c, { type: 'nominal', value: '120 A' }); c.undo();
  const before = c.result, revision = c.revision;
  for (const command of [
    { type: 'ramp-control', id: 'rise', control: 'to', value: '200%' },
    { type: 'flatten', id: 'rise', scope: 'unexpected' },
  ]) {
    const result = c.propose(command as EditCommand);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.diagnostics[0].code, 'EDIT_COMMAND');
    assert.equal(c.source, source); assert.equal(c.result, before);
    assert.equal(c.revision, revision); assert.equal(c.canRedo, true);
  }
});
