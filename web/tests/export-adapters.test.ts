import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { compileDocument, evaluate, expandFinite } from '../src/semantic/index.ts';
import type { CompiledWaveform, Point } from '../src/semantic/index.ts';
import { compilePointProject, exportWaveform } from '../src/export/index.ts';
import type { ExportOptions, ExportResult } from '../src/export/index.ts';

function compiled(segments: unknown[], dimension = 'current', initial = '0 A', nominal?: string): CompiledWaveform {
  const result = compileDocument({ schema: 'wavecraft/1', name: 'Independent fixture', signal: { dimension, initial, ...(nominal ? { nominal } : {}) }, segments });
  assert.ok(result.ok, JSON.stringify(result.diagnostics));
  return result.compiled;
}
function exported(c: CompiledWaveform, options: ExportOptions): Extract<ExportResult, { ok: true }> {
  const result = exportWaveform(c, options); assert.ok(result.ok, JSON.stringify(result)); return result;
}
const csvPoints = (content: string): Point[] => content.trim().split('\n').slice(1).map(row => row.split(',').map(Number) as Point);
const close = (a: number, b: number, floor = 1e-14) => assert.ok(Math.abs(a - b) <= Math.max(floor, Math.abs(b) * 1e-11), `${a} != ${b}`);
const load = (target = '175%') => compiled([{ id: 'cycles', kind: 'repeat', period: '3 ms', count: 2, pattern: [{ id: 'rise', kind: 'ramp', to: target, slew: '6 A/us' }, { id: 'top', kind: 'hold', duration: '2 ms' }, { id: 'return', kind: 'ramp', to: '0 A', slew: '6 A/us' }] }], 'current', '0 A', '240 A');
const pointProject = (extra = {}) => ({ version: 1, name: 'Point fixture', units: { time: 'us', current: 'A' }, maxSlew: null, points: [[0, 25], [18, 180], [128, 25]], ...extra });

test('exact CSV retains independently calculated load corners and finite terminal holding', () => {
  const c = load(), r = exported(c, { format: 'csv', horizonS: .007, repeatMode: 'expand' });
  const points = csvPoints(r.artifacts[0].content);
  for (const [t, v] of [[0, 0], [.00007, 420], [.00207, 420], [.00214, 0], [.00307, 420], [.00507, 420], [.00514, 0], [.006, 0], [.007, 0]]) {
    assert.ok(points.some(p => Math.abs(p[0] - t) < 1e-16 && p[1] === v), `Missing corner ${t},${v}`);
  }
  const edited = exported(load('200%'), { format: 'csv', horizonS: .00008 });
  assert.deepEqual(csvPoints(edited.artifacts[0].content).at(-1), [.00008, 480]);
  assert.equal(r.metadata.representation, 'exact-points'); assert.equal(r.metadata.horizonS, .007);
});

test('partial horizons evaluate a ramp and retain signed nonzero endpoints', () => {
  const c = compiled([{ id: 'down', kind: 'ramp', to: '-9 V', duration: '2 s' }], 'voltage', '3 V');
  const clipped = exported(c, { format: 'csv', horizonS: .5 });
  assert.deepEqual(csvPoints(clipped.artifacts[0].content), [[0, 3], [.5, 0]]);
  const full = exported(c, { format: 'csv', horizonS: 3 });
  assert.equal(full.artifacts[0].content.split('\n')[0], 'time_s,voltage_V');
  assert.deepEqual(csvPoints(full.artifacts[0].content), [[0, 3], [2, -9], [3, -9]]);
  assert.match(exported(c, { format: 'pwl' }).artifacts[0].content, /V_SIGNAL 1 0 PWL/);
  const current = compiled([{ id: 'up', kind: 'ramp', to: '-2 A', duration: '1 s' }], 'current', '-8 A');
  assert.match(exported(current, { format: 'pwl' }).artifacts[0].content, /I_LOAD 0 1 PWL/);
  assert.deepEqual(csvPoints(exported(current, { format: 'csv', horizonS: 2 }).artifacts[0].content).at(-1), [2, -2]);
});

test('CSV serializes full double precision and retains adjacent narrow corners', () => {
  const t = 1.2345678901234567e-12, next = 1.234567890123457e-12, level = -2.345678901234567;
  const c = compiled([{ id: 'tiny', kind: 'points', points: [{ id: 'p1', time: `${t} s`, value: `${level} A` }, { id: 'p2', time: `${next} s`, value: '7 A' }] }]);
  const r = exported(c, { format: 'csv' }), points = csvPoints(r.artifacts[0].content);
  assert.deepEqual(points, [[0, 0], [t, level], [next, 7]]);
  assert.ok(points[2][0] > points[1][0]); assert.match(r.artifacts[0].content, /1\.2345678901234567e-12/);
});

test('uniform CSV uses products, strict horizon comparison, and explicit coverage', () => {
  const c = compiled([{ id: 'rise', kind: 'ramp', to: '10 A', duration: '1 s' }]);
  for (const [horizonS, dt, expected] of [[.35, .1, [0, .1, .2, .30000000000000004]], [.3, .1, [0, .1, .2]], [.30000000000000004, .1, [0, .1, .2, .30000000000000004]], [1, .25, [0, .25, .5, .75, 1]], [0, .1, [0]], [3e-7, 1e-7, [0, 1e-7, 2e-7, 3e-7]]] as const) {
    const r = exported(c, { format: 'csv-uniform', horizonS, sampleIntervalS: dt });
    const points = csvPoints(r.artifacts[0].content);
    assert.deepEqual(points.map(p => p[0]), [...expected]);
    assert.equal(r.metadata.lastSampleS, points.at(-1)![0]); assert.equal(r.metadata.horizonS, horizonS);
    assert.ok(points.every((p, k) => p[0] === k * dt && p[0] <= horizonS));
    points.forEach(p => close(p[1], p[0] * 10));
  }
  const below = .5 - Number.EPSILON / 2;
  assert.deepEqual(csvPoints(exported(c, { format: 'csv-uniform', horizonS: below, sampleIntervalS: .25 }).artifacts[0].content).map(p => p[0]), [0, .25]);
});

test('point bridge preserves leading hold, signed values, strict closure, and project immutability', () => {
  const project = pointProject({ points: [[2, -3], [4, 9], [7, -3]], repetition: { mode: 'periodic', periodUs: 10 } });
  const before = JSON.stringify(project), result = compilePointProject(project); assert.ok(result.ok);
  assert.equal(JSON.stringify(project), before); assert.equal(result.compiled.continuous, true);
  close(evaluate(result.compiled, 1e-6), -3); close(evaluate(result.compiled, 3e-6), 3); close(evaluate(result.compiled, 13e-6), 3);
  assert.equal(exportWaveform(result.compiled, { format: 'csv' }).ok, false);
  assert.equal(exportWaveform(result.compiled, { format: 'python' }).ok, false);
  const points = csvPoints(exported(result.compiled, { format: 'csv', horizonS: 21e-6 }).artifacts[0].content);
  assert.deepEqual(points[0], [0, -3]); assert.ok(points.some(p => p[0] === 2e-6 && p[1] === -3));
  assert.equal(compilePointProject(pointProject({ points: [[0, 0], [1, 1e-30]], repetition: { mode: 'periodic', periodUs: 2 } })).ok, false);
});

test('physical point burst retains first peak at 18 us and the next outer peak at 0.100018 s', async () => {
  const project = JSON.parse(await readFile(new URL('../../outputs/burst-fix/user-reported-project.json', import.meta.url), 'utf8'));
  const before = JSON.stringify(project), result = compilePointProject(project); assert.ok(result.ok, JSON.stringify(result));
  const repeat = result.compiled.nodes[0]; assert.equal(repeat.kind, 'repeat');
  if (repeat.kind !== 'repeat') return;
  assert.equal(repeat.count, 10); close(repeat.periodS, .00015); close(repeat.outer!.periodS, .1); assert.equal(repeat.outer!.count, 'continuous');
  const r = exported(result.compiled, { format: 'csv', horizonS: .20005 }), points = csvPoints(r.artifacts[0].content);
  assert.ok(points.some(([t, a]) => t === .000018 && a === 180)); assert.ok(points.some(([t, a]) => t === .100018 && a === 180));
  assert.equal(points.filter(p => p[1] === 180).length, 21); close(evaluate(result.compiled, .05), 25);
  assert.equal(JSON.stringify(project), before);
});

test('all finite formats consume the same exact points and filename input cannot inject source text', () => {
  const c = compiled([{ id: 'rise', kind: 'ramp', to: '7 V', duration: '0.12345678901234567 s' }], 'voltage', '-2 V');
  const before = structuredClone(c), csv = csvPoints(exported(c, { format: 'csv' }).artifacts[0].content);
  for (const format of ['python', 'javascript', 'matlab', 'plecs'] as const) {
    const r = exported(c, { format, name: '../bad\\name\n.inject' });
    assert.ok(r.artifacts.every(a => !/[\\/\r\n]/.test(a.filename))); assert.match(r.artifacts[0].content, /voltage_V/);
    assert.ok(r.artifacts[0].content.includes(csv.at(-1)![0].toString()));
    if (format === 'javascript') {
      const content = r.artifacts[0].content;
      for (const [t, expected] of [[-5, -2], [0, -2], [csv[1][0] / 2, 2.5], [99, 7]]) close(runInNewContext(content + `\nevaluateWaveform(${t})`), expected);
    }
    if (format === 'plecs') { assert.equal(r.artifacts[0].filename.endsWith('.m'), true); assert.match(r.artifacts[1].content, /Saturation/); assert.match(r.artifacts[1].content, /LowerLimit/); assert.doesNotMatch(r.artifacts[0].content, /import numpy/); }
    if (format === 'matlab') assert.match(r.artifacts[0].content, /min\(max\(t_s, time_s\(1\)\), time_s\(end\)\)/);
  }
  const file = exported(c, { format: 'pwl-file', name: 'safe' });
  assert.deepEqual(file.artifacts[0].content.trim().split('\n').map(row => row.split(' ').map(Number)), csv);
  assert.match(file.artifacts[1].content, /V_SIGNAL 1 0 PWL FILE="safe.txt"/); assert.equal(file.artifacts[0].role, 'primary');
  for (const name of ['CON', 'aux', 'COM1', 'lpt9']) {
    const reserved = exported(c, { format: 'pwl-file', name });
    assert.equal(reserved.artifacts[0].filename, `wavecraft-${name}.txt`);
    assert.ok(reserved.artifacts[1].content.includes(`FILE="wavecraft-${name}.txt"`));
  }
  assert.deepEqual(c, before);
});

test('resource limits, zero horizons, invalid options, and invalid models produce structured failures', () => {
  const c = load();
  for (const options of [{ format: 'csv', maxPoints: 0 }, { format: 'csv', maxPoints: 100001 }, { format: 'csv', horizonS: NaN }, { format: 'csv', horizonS: -1 }, { format: 'csv-uniform', sampleIntervalS: 0 }, { format: 'csv-uniform', sampleIntervalS: Infinity }, { format: 'csv-uniform', sampleIntervalS: 1e-20 }, { format: 'csv', maxPoints: 2 }, { format: 'yaml' }, { format: 'csv', repeatMode: 'invented' }] as ExportOptions[]) {
    const result = exportWaveform(c, options); assert.equal(result.ok, false, JSON.stringify(options)); if (!result.ok) assert.ok(result.diagnostics[0].code);
  }
  assert.deepEqual(csvPoints(exported(c, { format: 'csv', horizonS: 0, maxPoints: 1 }).artifacts[0].content), [[0, 0]]);
  const constant = compiled([], 'voltage', '-3 V');
  assert.deepEqual(csvPoints(exported(constant, { format: 'csv' }).artifacts[0].content), [[0, -3]]);
  const constantPlecs = exported(constant, { format: 'plecs' });
  assert.match(constantPlecs.artifacts[1].content, /Constant block with value y\(1\)/); assert.doesNotMatch(constantPlecs.artifacts[1].content, /Clock -> Saturation/);
  for (const bad of [null, {}, { ...c, finalValue: NaN }, { ...c, finalValue: 22 }, { ...c, initialValue: 11 }, { ...c, durationS: -1 }, { ...c, nodes: [{ ...c.nodes[0], activeSpanS: 0 }] }, { ...c, nodes: [{ kind: 'hold', timing: { startS: 0, endS: 1, durationS: 1 }, points: [[0, 1], [0, 2]] }] }]) assert.equal(exportWaveform(bad as CompiledWaveform, { format: 'csv' }).ok, false);
  for (const project of [null, {}, pointProject({ maxSlew: -1 }), pointProject({ maxSlew: 1 }), pointProject({ points: [[0, 0], [0, 1]] }), pointProject({ repetition: { mode: 'burst', periodUs: 150, count: 0, burstPeriodUs: 1000 } }), pointProject({ repetition: { mode: 'burst', periodUs: 150, count: 10, burstPeriodUs: 200 } })]) assert.equal(compilePointProject(project).ok, false);
});

test('continuous semantic burst requires finite horizons for numerical arrays and both clocks survive compilation', () => {
  const c = compiled([{ id: 'b', kind: 'repeat', period: '10 us', count: 3, outer: { period: '100 us', count: 'continuous' }, pattern: [{ id: 'up', kind: 'ramp', to: '8 A', duration: '2 us' }, { id: 'down', kind: 'ramp', to: '0 A', duration: '2 us' }] }]);
  for (const format of ['csv', 'csv-uniform', 'python', 'javascript', 'matlab', 'plecs'] as const) assert.equal(exportWaveform(c, { format, sampleIntervalS: 1e-6 }).ok, false);
  const points = csvPoints(exported(c, { format: 'csv', horizonS: 302e-6 }).artifacts[0].content);
  for (const t of [2e-6, 12e-6, 22e-6, 102e-6, 202e-6, 302e-6]) assert.ok(points.some(([time, v]) => Math.abs(time - t) < 1e-18 && v === 8));
  assert.equal(exportWaveform(c, { format: 'csv', horizonS: 1, maxPoints: 100 }).ok, false);
});

// This parser and interpolator do not call the compiler evaluator.
function inlineCycle(content: string): Point[] {
  const body = content.slice(content.indexOf('(\n') + 2, content.lastIndexOf('+ )'));
  return body.trim().split('\n').map(line => line.replace(/^\+\s*/, '').split(/\s+/).map(Number) as Point);
}
function interpolate(points: Point[], time: number): number {
  if (time <= points[0][0]) return points[0][1];
  if (time >= points.at(-1)![0]) return points.at(-1)![1];
  const i = points.findIndex(p => p[0] >= time), a = points[i - 1], b = points[i];
  return a[1] + (b[1] - a[1]) * (time - a[0]) / (b[0] - a[0]);
}

test('compact LTspice retains complete periods and finite counts without a reset ramp', () => {
  const c = compiled([{ id: 'r', kind: 'repeat', period: '4 ms', count: 3, pattern: [{ id: 'down', kind: 'ramp', to: '-4 V', duration: '1 ms' }, { id: 'bottom', kind: 'hold', duration: '1 ms' }, { id: 'up', kind: 'ramp', to: '2 V', duration: '1 ms' }] }], 'voltage', '2 V');
  const r = exported(c, { format: 'pwl' }), text = r.artifacts[0].content, cycle = inlineCycle(text);
  assert.match(text, /V_SIGNAL 1 0 PWL REPEAT FOR 3/); assert.match(text, /ENDREPEAT/);
  assert.deepEqual(cycle, [[0, 2], [.001, -4], [.002, -4], [.003, 2], [.004, 2]]);
  for (const [time, expected] of [[0, 2], [.0005, -1], [.0015, -4], [.0025, -1], [.0035, 2], [.0045, -1], [.0085, -1], [.0125, 2]]) {
    const local = time >= .012 ? .004 : time % .004;
    close(interpolate(cycle, local), expected);
  }
  assert.equal(r.metadata.representation, 'compact-repeat'); assert.equal(r.metadata.repeat!.innerCount, 3);
  const finite = exported(c, { format: 'pwl', horizonS: .005 }); assert.doesNotMatch(finite.artifacts[0].content, /REPEAT/);
  assert.equal(finite.metadata.representation, 'exact-points');
  const expanded = exported(c, { format: 'pwl', repeatMode: 'expand' }); assert.doesNotMatch(expanded.artifacts[0].content, /REPEAT/);
});

test('finite expansion keeps a terminal repeat corner when modulo evaluation differs by roundoff', () => {
  const c = compiled([{ id: 'r', kind: 'repeat', period: '4 ms', count: 'continuous', pattern: [{ id: 'down', kind: 'ramp', to: '-4 A', duration: '1 ms' }, { id: 'bottom', kind: 'hold', duration: '1 ms' }, { id: 'up', kind: 'ramp', to: '2 A', duration: '1 ms' }] }], 'current', '2 A');
  const exact = expandFinite(c, { horizonS: .015 }); assert.ok(exact.ok); assert.deepEqual(exact.points.at(-1), [.015, 2]);
  const step = 2 ** -59;
  for (const horizonS of [.0145, .015 - step, .015 + step]) {
    const result = expandFinite(c, { horizonS }); assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.points.at(-1)![0], horizonS);
    assert.equal(result.points.at(-1)![1], evaluate(c, horizonS));
    assert.ok(result.points.every((p, i) => i === 0 || p[0] > result.points[i - 1][0]));
  }
  const clipped = exported(c, { format: 'csv', horizonS: .0145 }); close(csvPoints(clipped.artifacts[0].content).at(-1)![1], -1);
  assert.equal(exported(c, { format: 'plecs', horizonS: .015 }).metadata.pointCount, exact.points.length);
});

test('compact continuous burst preserves both clocks and fits an outer period shorter than count times inner period', () => {
  const c = compiled([{ id: 'b', kind: 'repeat', period: '1 us', count: 10, outer: { period: '9.5 us', count: 'continuous' }, pattern: [{ id: 'rise', kind: 'ramp', to: '10 A', duration: '.2 us' }, { id: 'fall', kind: 'ramp', to: '0 A', duration: '.2 us' }] }]);
  const r = exported(c, { format: 'pwl' }), cycle = inlineCycle(r.artifacts[0].content);
  assert.match(r.artifacts[0].content, /REPEAT FOREVER/); close(cycle.at(-1)![0], 9.5e-6);
  assert.equal(cycle.filter(p => p[1] === 10).length, 10); assert.ok(cycle.every(p => p[0] <= 9.5e-6));
  for (const outerStart of [0, 9.5e-6, 19e-6]) {
    for (const [offset, expected] of [[.1e-6, 5], [9.1e-6, 5], [9.45e-6, 0]]) close(interpolate(cycle, outerStart + offset - outerStart), expected, 1e-9);
  }
  assert.equal(r.metadata.repeat!.innerCount, 10); close(r.metadata.repeat!.innerPeriodS, 1e-6); close(r.metadata.repeat!.outerPeriodS!, 9.5e-6); assert.equal(r.metadata.repeat!.outerCount, 'continuous');
  assert.equal(r.metadata.capabilities.twoLevelRepeat, true); assert.ok(r.warnings.some(d => d.code === 'INNER_EXPANSION'));
  const file = exported(c, { format: 'pwl-file', name: 'burst' });
  assert.match(file.artifacts[1].content, /PWL REPEAT FOREVER FILE="burst.txt" ENDREPEAT/);
  assert.deepEqual(file.artifacts[0].content.trim().split('\n').map(p => p.split(' ').map(Number)), cycle);
  assert.equal(exportWaveform(c, { format: 'pwl', repeatMode: 'expand' }).ok, false);
});
