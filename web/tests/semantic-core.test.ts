import test from 'node:test';
import assert from 'node:assert/strict';
import { compileDocument, compileYaml, evaluate, expandFinite, SEMANTIC_LIMITS } from '../src/semantic/index.ts';
import type { AuthoringDocument, CompiledWaveform, CompileResult, Point } from '../src/semantic/index.ts';

const doc = (segments: unknown[], signal: unknown = { dimension: 'current', nominal: '240 A', initial: '0 A' }): unknown => ({ schema: 'wavecraft/1', name: 'Independent arithmetic fixture', signal, segments });
function good(result: CompileResult) { assert.equal(result.ok, true, JSON.stringify(result.diagnostics)); if (!result.ok) throw new Error('Compilation failed'); return result; }
function bad(input: unknown, code: string) { const result = compileDocument(input); assert.equal(result.ok, false); assert.equal(result.diagnostics[0].code, code); assert.equal('compiled' in result, false); return result.diagnostics[0]; }
const close = (actual: number, expected: number, floor = 1e-18) => assert.ok(Math.abs(actual - expected) <= Math.max(Math.abs(expected) * 1e-10, floor), `${actual} != ${expected}`);
function expanded(compiled: CompiledWaveform, options?: { horizonS?: number; maxPoints?: number }): Point[] { const result = expandFinite(compiled, options); assert.equal(result.ok, true, JSON.stringify(result.diagnostics)); if (!result.ok) throw new Error('Expansion failed'); return result.points; }
const rise = { id: 'rise', kind: 'ramp', to: '175%', slew: '6 A/us' };

test('independent load arithmetic retains percentage intent, actual hold ends, and source immutability', () => {
  const source = doc([rise, { id: 'hold', kind: 'hold', duration: '2 ms' }]);
  const before = JSON.stringify(source);
  const result = good(compileDocument(source));
  close(result.compiled.nodes[0].timing.endS, 70e-6);
  close(result.compiled.durationS, 2070e-6);
  assert.equal(result.compiled.finalValue, 420);
  close(evaluate(result.compiled, 35e-6), 210);
  assert.equal(result.document.segments[0].kind, 'ramp');
  assert.equal((result.document.segments[0] as { to: string }).to, '175%');
  assert.equal(JSON.stringify(source), before);
  const changed = good(compileDocument(doc([{ ...rise, to: '200%' }, { id: 'hold', kind: 'hold', duration: '2 ms' }])));
  close(changed.compiled.nodes[0].timing.durationS, 80e-6);
  assert.equal(changed.compiled.finalValue, 480);
  const nominalChanged = good(compileDocument(doc([rise], { dimension: 'current', nominal: '120 A', initial: '0 A' })));
  close(nominalChanged.compiled.durationS, 35e-6);
  assert.equal(JSON.stringify(source), before);
  (result.document.segments[0] as { to: string }).to = '1 A';
  assert.equal(JSON.stringify(source), before);
});

test('duration and slew are independent authoring controls with explicit limits', () => {
  for (const [target, expectedSlew] of [['420 A', 6e6], ['480 A', 480 / 70e-6]] as const) {
    const result = good(compileDocument(doc([{ id: 'fixed', kind: 'ramp', to: target, duration: '70 us' }])));
    close(result.compiled.durationS, 70e-6);
    close(result.compiled.nodes[0].kind !== 'repeat' ? result.compiled.nodes[0].resolvedSlew! : NaN, expectedSlew);
  }
  bad(doc([{ id: 'limited', kind: 'ramp', to: '480 A', duration: '70 us', maxSlew: '6 A/us' }]), 'SLEW_LIMIT');
  bad(doc([{ ...rise, duration: '1 ms' }]), 'SCHEMA');
  bad(doc([{ ...rise, slew: '0 A/us' }]), 'QUANTITY');
  bad(doc([{ ...rise, to: '0 A' }]), 'NUMERIC_RANGE');
  bad(doc([{ id: 'jump', kind: 'ramp', to: '1 A', duration: '0 s' }]), 'QUANTITY');
});

test('absolute arrival preserves anchor and exposes idle while relative timing follows actual ends', () => {
  const source = doc([{ id: 'lead', kind: 'hold', duration: '20 us' }, { id: 'anchor', kind: 'ramp', to: '60 A', slew: '6 A/us', arriveAt: '100 us' }, { id: 'tail', kind: 'hold', duration: '2 us' }]);
  const result = good(compileDocument(source));
  assert.deepEqual(result.compiled.nodes.map(n => n.kind), ['hold', 'idle', 'ramp', 'hold']);
  close(result.compiled.nodes[1].timing.startS, 20e-6);
  close(result.compiled.nodes[1].timing.endS, 90e-6);
  close(result.compiled.nodes[2].timing.requestedArrivalS!, 100e-6);
  close(result.compiled.nodes[3].timing.startS, 100e-6);
  close(result.compiled.durationS, 102e-6);
  close(evaluate(result.compiled, 95e-6), 30);
  const conflict = doc([{ id: 'lead', kind: 'hold', duration: '95 us' }, { id: 'anchor', kind: 'ramp', to: '60 A', slew: '6 A/us', arriveAt: '100 us' }]);
  const before = JSON.stringify(conflict);
  const diagnostic = bad(conflict, 'ANCHOR_CONFLICT');
  assert.equal(diagnostic.source.id, 'anchor');
  assert.deepEqual(diagnostic.source.path, ['segments', 1, 'arriveAt']);
  close(diagnostic.values!.requestedArrivalS as number, 100e-6);
  assert.equal(JSON.stringify(conflict), before);
  bad(doc([{ id: 'lead', kind: 'hold', duration: '1 s' }, { id: 'anchor', kind: 'ramp', to: '1 A', duration: '1 s', arriveAt: '1.9999999999999998 s' }]), 'ANCHOR_CONFLICT');
});

test('signed voltage/current, finite supported units, exponent literals, and zero nominal percentages', () => {
  const voltage = good(compileDocument(doc([{ id: 'negative', kind: 'ramp', to: '-2.5 V', duration: '2 µs' }], { dimension: 'voltage', initial: '1 V' })));
  close(evaluate(voltage.compiled, 1e-6), -0.75);
  assert.equal(evaluate(voltage.compiled, -5), 1);
  assert.equal(evaluate(voltage.compiled, 5), -2.5);
  assert.equal(voltage.compiled.dimension, 'voltage');
  bad(doc([rise], { dimension: 'voltage', initial: '0 V', nominal: '240 A' }), 'DIMENSION');
  bad(doc([{ id: 'wrong', kind: 'ramp', to: '1 V', duration: '1 us' }]), 'DIMENSION');
  bad(doc([{ id: 'x', kind: 'ramp', to: '20%', duration: '1 ms' }], { dimension: 'current', initial: '0 A' }), 'NOMINAL_REQUIRED');
  const zero = good(compileDocument(doc([{ id: 'zero', kind: 'ramp', to: '175%', duration: '1 ms' }], { dimension: 'current', initial: '0 A', nominal: '0 A' })));
  assert.equal(zero.compiled.finalValue, 0);
  const signed = good(compileDocument(doc([{ id: 'sign', kind: 'ramp', to: '-1e2 mA', duration: '.5 μs' }])));
  close(signed.compiled.finalValue, -0.1);
  for (const value of ['1e999 A', '1e-999 A', '1e-320 nA']) bad(doc([{ ...rise, to: value }]), 'QUANTITY_RANGE');
  bad(doc([{ ...rise, slew: '6 V/us' }]), 'DIMENSION');
  bad(doc([{ ...rise, to: 'Math.sin(1) A' }]), 'QUANTITY');
  assert.throws(() => evaluate(voltage.compiled, Infinity), /finite/);
  const tinyNominal = good(compileDocument(doc([], { dimension: 'current', nominal: '1e-323 A', initial: '1e300%' })));
  assert.ok(tinyNominal.compiled.initialValue > 9e-26);
  bad(doc([{ id: 'underflow', kind: 'ramp', to: '1e-100 A', duration: '1e308 s' }]), 'NUMERIC_RANGE');
});

test('point order, derived initial level, identity, interpolation, and finite endpoint holding', () => {
  const source = doc([{ id: 'trace', kind: 'points', points: [{ id: 'a', time: '1 us', value: '4 A' }, { id: 'b', time: '3 us', value: '-4 A' }] }]);
  const result = good(compileDocument(source));
  const node = result.compiled.nodes[0];
  assert.notEqual(node.kind, 'repeat');
  if (node.kind === 'repeat') return;
  assert.deepEqual(node.pointSources!.map(p => p.id), ['trace', 'a', 'b']);
  assert.deepEqual(node.pointSources![2].path, ['segments', 0, 'points', 1]);
  close(evaluate(result.compiled, .5e-6), 2);
  close(evaluate(result.compiled, 2e-6), 0, 1e-12);
  assert.equal(evaluate(result.compiled, 1), -4);
  assert.equal(expanded(result.compiled).length, 3);
  for (const time of ['0 us', '-1 us', '1 us']) bad(doc([{ id: 'trace', kind: 'points', points: [{ id: 'a', time: '1 us', value: '4 A' }, { id: 'b', time, value: '-4 A' }] }]), 'POINT_ORDER');
  bad(doc([{ id: 'trace', kind: 'points', points: [{ id: 'a', time: '0 s', value: '1 A' }, { id: 'b', time: '1 s', value: '0 A' }] }]), 'POINT_INITIAL');
  bad(doc([{ id: 'trace', kind: 'points', points: [{ id: 'a', time: '0 s', value: '0 A' }] }]), 'POINT_ORDER');
});

const pattern = [
  { id: 'up1', kind: 'ramp', to: '10 A', duration: '100 ns' },
  { id: 'down1', kind: 'ramp', to: '0 A', duration: '100 ns' },
  { id: 'gap', kind: 'hold', duration: '100 ns' },
  { id: 'up2', kind: 'ramp', to: '20 A', duration: '100 ns' },
  { id: 'down2', kind: 'ramp', to: '0 A', duration: '100 ns' }
];

test('compact burst has ten pattern starts, twenty independent pulse peaks, and outer start-to-start timing', () => {
  const source = doc([{ id: 'burst', kind: 'repeat', frequency: '1 MHz', count: 10, outer: { frequency: '1 Hz', count: 'continuous' }, pattern }]);
  const result = good(compileDocument(source));
  assert.equal(result.compiled.continuous, true);
  assert.equal(result.compiled.nodes.length, 1);
  const repeat = result.compiled.nodes[0];
  assert.equal(repeat.kind, 'repeat');
  if (repeat.kind !== 'repeat') return;
  assert.equal(repeat.pattern.length, 6);
  close(repeat.periodS, 1e-6);
  close(repeat.frequencyHz, 1e6);
  close(repeat.patternDurationS, .5e-6);
  close(repeat.activeSpanS, 9.5e-6);
  assert.equal(repeat.outer!.periodS, 1);
  assert.equal(expandFinite(result.compiled).ok, false);
  const points = expanded(result.compiled, { horizonS: 10e-6 });
  assert.equal(points.filter(p => p[1] === 10).length, 10);
  assert.equal(points.filter(p => p[1] === 20).length, 10);
  for (let i = 0; i < 10; i++) {
    close(evaluate(result.compiled, i * 1e-6 + .05e-6), 5);
    close(evaluate(result.compiled, i * 1e-6 + .35e-6), 10);
  }
  close(evaluate(result.compiled, 1 + .05e-6), 5, 2e-8);
  assert.equal(evaluate(result.compiled, .5), 0);
  const twice = expanded(result.compiled, { horizonS: 1 + 10e-6 });
  assert.equal(twice.filter(p => p[1] === 10).length, 20);
  assert.equal(twice.filter(p => p[1] === 20).length, 20);
});

test('repeat closure, inner fit, outer active span fit, finite trailing idle, and continuous tail are strict', () => {
  bad(doc([{ id: 'r', kind: 'repeat', period: '1 us', count: 2, pattern: [pattern[0]] }]), 'REPEAT_CLOSURE');
  bad(doc([{ id: 'r', kind: 'repeat', period: '400 ns', count: 10, pattern }]), 'REPEAT_FIT');
  bad(doc([{ id: 'r', kind: 'repeat', period: '1 us', count: 10, outer: { period: '9 us', count: 2 }, pattern }]), 'REPEAT_FIT');
  bad(doc([{ id: 'r', kind: 'repeat', period: '1 us', count: 'continuous', pattern }, { id: 'after', kind: 'hold', duration: '1 s' }]), 'SCHEMA');
  bad(doc([{ id: 'r', kind: 'repeat', period: '1 us', count: 'continuous', outer: { period: '1 s', count: 1 }, pattern }]), 'SCHEMA');
  const finite = good(compileDocument(doc([{ id: 'r', kind: 'repeat', period: '1 us', count: 10, pattern }, { id: 'after', kind: 'hold', duration: '2 us' }])));
  close(finite.compiled.nodes[1].timing.startS, 10e-6);
  close(finite.compiled.durationS, 12e-6);
  assert.equal(evaluate(finite.compiled, 11e-6), 0);
  const outer = good(compileDocument(doc([{ id: 'r', kind: 'repeat', period: '1 us', count: 10, outer: { period: '1 s', count: 2 }, pattern }])));
  assert.equal(outer.compiled.durationS, 2);
  assert.equal(evaluate(outer.compiled, 3), 0);
  bad(doc([{ id: 'r', kind: 'repeat', period: '1e308 s', count: 2, pattern: [{ id: 'h', kind: 'hold', duration: '1 s' }] }]), 'NUMERIC_RANGE');
  bad(doc([{ id: 'r', kind: 'repeat', period: '1 s', count: 1, outer: { period: '1e308 s', count: 2 }, pattern: [{ id: 'h', kind: 'hold', duration: '1 s' }] }]), 'NUMERIC_RANGE');
});

test('finite expansion clips and extends held endpoints, keeps corners, and bounds huge repetition', () => {
  const finite = good(compileDocument(doc([rise, { id: 'h', kind: 'hold', duration: '2 ms' }]))).compiled;
  const clipped = expanded(finite, { horizonS: 35e-6 });
  assert.equal(clipped.length, 2); close(clipped[1][1], 210); close(clipped[1][0], 35e-6);
  const extended = expanded(finite, { horizonS: 1 });
  assert.deepEqual(extended.at(-1), [1, 420]);
  const huge = good(compileDocument(doc([{ id: 'huge', kind: 'repeat', period: '1 us', count: 1e9, pattern }]))).compiled;
  assert.equal(huge.nodes.length, 1);
  assert.equal(expandFinite(huge, { maxPoints: 50 }).ok, false);
  assert.equal(expandFinite(huge, { maxPoints: SEMANTIC_LIMITS.expandedPoints + 1 }).ok, false);
  assert.equal(expandFinite(huge, { horizonS: -1 }).ok, false);
  bad(doc([{ id: 'big', kind: 'hold', duration: '1e20 s' }, { id: 'tiny', kind: 'hold', duration: '1 ps' }]), 'NUMERIC_RANGE');
  bad(doc([{ id: 'huge', kind: 'repeat', period: '1 us', count: Number.MAX_SAFE_INTEGER, pattern }]), 'NUMERIC_RANGE');
  bad(doc([{ id: 'huge', kind: 'repeat', period: '1 us', count: 1, outer: { period: '1e20 s', count: 2 }, pattern }]), 'NUMERIC_RANGE');
});

test('YAML diagnostics link exact source quantities, stable IDs, paths and UTF-16 ranges', () => {
  const source = '# µ source\r\nschema: wavecraft/1\r\nname: test\r\nsignal: {dimension: current, initial: 0 A}\r\nsegments:\r\n  - {id: bad, kind: ramp, to: 4 V, duration: 1 us}\r\n';
  const result = compileYaml(source);
  assert.equal(result.ok, false);
  const d = result.diagnostics[0];
  assert.equal(d.code, 'DIMENSION'); assert.equal(d.source.id, 'bad');
  assert.deepEqual(d.source.path, ['segments', 0, 'to']);
  assert.equal(source.slice(d.source.range![0], d.source.range![1]), '4 V');
  assert.ok(d.suggestion);
  const invalidSources = [
    ['schema: [', 'YAML_SYNTAX'],
    ['schema: wavecraft/1\nschema: wavecraft/1', 'YAML_SYNTAX'],
    ['schema: &x wavecraft/1\nname: *x', 'YAML_ALIAS'],
    ['schema: !custom wavecraft/1', 'YAML_TAG'],
    ['schema: wavecraft/1\nname: !<tag:yaml.org,2002:evil> test', 'YAML_TAG'],
    ['x: ' + '['.repeat(40) + '0' + ']'.repeat(40), 'RESOURCE_LIMIT'],
    ['#' + 'a'.repeat(SEMANTIC_LIMITS.sourceBytes), 'RESOURCE_LIMIT']
  ];
  for (const [text, code] of invalidSources) { const parsed = compileYaml(text); assert.equal(parsed.ok, false); assert.equal(parsed.diagnostics[0].code, code); }
  const linked = good(compileYaml('schema: wavecraft/1\nname: trace\nsignal: {dimension: current, initial: 0 A}\nsegments:\n - id: trace\n   kind: points\n   points: [{id: p, time: 1 us, value: 2 A}]\n'));
  const leaf = linked.compiled.nodes[0];
  if (leaf.kind !== 'repeat') assert.ok(leaf.pointSources![1].range);
});

test('schema errors stay structured for unknown fields, IDs, counts, nesting, and item limits', () => {
  bad(null, 'SCHEMA'); bad({ ...doc([]) as object, resolution: '1 us' }, 'SCHEMA');
  bad(doc([{ ...rise, extra: 1 }]), 'SCHEMA');
  bad(doc([{ ...rise }, { ...rise }]), 'DUPLICATE_ID');
  bad(doc([{ id: 'r', kind: 'repeat', period: '1 s', frequency: '1 Hz', count: 1, pattern }]), 'SCHEMA');
  for (const count of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) bad(doc([{ id: 'r', kind: 'repeat', period: '1 s', count, pattern }]), 'SCHEMA');
  bad(doc([{ id: 'r', kind: 'repeat', period: '1 s', count: 1, pattern: [{ id: 'nested', kind: 'repeat', pattern: [] }] }]), 'SCHEMA');
  bad(doc(Array.from({ length: SEMANTIC_LIMITS.authoredItems + 1 }, (_, i) => ({ id: `h${i}`, kind: 'hold', duration: '1 us' }))), 'RESOURCE_LIMIT');
});

test('repeat arithmetic stays ordered for full-period corners, prefixed times and exact outer burst fits', () => {
  for (const period of [.1, .3, 1, .000128]) {
    for (const prefix of [0, .123]) {
      const pattern = [{ id: 'up', kind: 'ramp', to: '1 A', duration: `${period / 2} s` }, { id: 'down', kind: 'ramp', to: '0 A', duration: `${period / 2} s` }];
      const result = good(compileDocument(doc([...(prefix ? [{ id: 'pre', kind: 'hold', duration: `${prefix} s` }] : []), { id: 'r', kind: 'repeat', period: `${period} s`, count: 10, outer: { period: `${10 * period} s`, count: 2 }, pattern }])));
      const points = expanded(result.compiled);
      assert.equal(points.filter(p => p[1] === 1).length, 20);
      for (let i = 1; i < points.length; i++) assert.ok(points[i][0] > points[i - 1][0]);
      for (const [t, v] of points) close(evaluate(result.compiled, t), v, 1e-12);
    }
  }
});

test('roundoff-equivalent closure preserves continuous boundaries without suppressing narrow events', () => {
  const source = doc([{ id: 'r', kind: 'repeat', period: '.3 s', count: 10, pattern: [{ id: 'up', kind: 'ramp', to: '1 A', duration: '.1 s' }, { id: 'back', kind: 'ramp', to: '.9 A', duration: '.2 s' }] }], { dimension: 'current', nominal: '3 A', initial: '30%' });
  const result = good(compileDocument(source));
  const points = expanded(result.compiled);
  assert.equal(points.filter(p => p[1] === 1).length, 10);
  const heldClosure = good(compileDocument(doc([{ id: 'r', kind: 'repeat', period: '.4 s', count: 10, pattern: [{ id: 'up', kind: 'ramp', to: '2 A', duration: '.1 s' }, { id: 'back', kind: 'ramp', to: '1 A', duration: '.2 s' }, { id: 'hold', kind: 'hold', duration: '.1 s' }] }], { dimension: 'current', nominal: '3 A', initial: '33.33333333333333%' })));
  const repeat = heldClosure.compiled.nodes[0];
  if (repeat.kind === 'repeat') {
    const hold = repeat.pattern.find(n => n.id === 'hold')!;
    assert.equal(hold.roundoffCanonicalized, true);
    assert.equal(hold.points[0][1], hold.points[1][1]);
  }
  assert.equal(expanded(heldClosure.compiled).filter(p => p[1] === 2).length, 10);
  const narrow = good(compileDocument(doc([{ id: 'up', kind: 'ramp', to: '1 A', duration: '1 ps' }, { id: 'down', kind: 'ramp', to: '0 A', duration: '1 ps' }])));
  assert.equal(expanded(narrow.compiled).length, 3);
  close(evaluate(narrow.compiled, .5e-12), .5);
});
