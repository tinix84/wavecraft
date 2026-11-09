import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { candidateSource, checkCalibration, correctedPointsSI, originalToView, parseCsv, pixelToSI, rawPointsSI, screenToOriginal, sealExtraction, siToPixel, viewToOriginal } from '../src/digitize/index.ts';
import type { Calibration, CsvMapping, Digitization, Extraction } from '../src/digitize/index.ts';
import { compileYaml, evaluate } from '../src/semantic/index.ts';

const calibration = (): Calibration => ({ axes: 'linear', rotation: 'axis-aligned', dimension: 'voltage', timeUnit: 'ms', valueUnit: 'V', x: [{ pixel: [100, 300], value: 0 }, { pixel: [500, 300], value: 4 }], y: [{ pixel: [100, 300], value: -2 }, { pixel: [100, 100], value: 6 }], tick: { axis: 'x', pixel: [200, 300], value: 1, tolerance: 0.01 } });
const mapping = (): CsvMapping => ({ dimension: 'current', timeUnit: 'us', valueUnit: 'mA', xColumn: 0, yColumn: 1, delimiter: ',', decimal: '.', header: true, confirmed: true });
const image = (): Extraction => ({ kind: 'image', size: [600, 400], calibration: calibration(), pixels: [[100, 300], [200, 100], [500, 300]] });
const digitization = (): Digitization => ({ extraction: image(), corrections: [], assumptions: 'Use linear interpolation between the measured pixels.' });
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-14, `${a} differs from ${b}`);

test('four landmarks reproduce independent signed voltage coordinates and an unused tick', () => {
  const c = calibration(); assert.deepEqual(checkCalibration(c), { predicted: 1, error: 0, passed: true });
  assert.deepEqual(pixelToSI([300, 200], c), [0.002, 2]); assert.deepEqual(siToPixel([0.002, 2], c), [300, 200]);
  c.tick = { axis: 'y', pixel: [100, 200], value: 2, tolerance: 0.01 }; assert.equal(checkCalibration(c).passed, true);
});
test('a wrong scale fails the independent tick and blocks acceptance without changing raw evidence', () => {
  const d = digitization(); if (d.extraction.kind !== 'image') throw Error(); d.extraction.calibration.x[1].value = 8;
  assert.deepEqual(checkCalibration(d.extraction.calibration), { predicted: 2, error: 1, passed: false });
  const before = structuredClone(d); assert.throws(() => candidateSource(d), /unused tick/); assert.deepEqual(d, before);
});
test('coincident, inverted, rotated, logarithmic, nonfinite, and reused tick calibrations fail', () => {
  const changes = [(c: any) => c.x[1].pixel[0] = 100, (c: any) => c.y[1].pixel[1] = 350, (c: any) => c.x[1].value = 0, (c: any) => c.x[1].pixel[1] += 2, (c: any) => c.axes = 'log', (c: any) => c.rotation = 'rotated', (c: any) => c.x[1].value = Infinity, (c: any) => c.tick.pixel = [100, 99], (c: any) => c.tick.value = 4, (c: any) => c.tick.tolerance = -1];
  for (const change of changes) { const c = calibration(); change(c); assert.throws(() => checkCalibration(c)); }
});
test('inverse screen, zoom, resize, and crop transforms preserve intrinsic pixels', () => {
  const view = { originalSize: [1200, 800] as [number, number], viewSize: [300, 200] as [number, number], crop: null };
  assert.deepEqual(screenToOriginal([90, 70], { a: 0.5, b: 0, c: 0, d: 0.5, e: -20, f: -10 }, view), [100, 100]);
  view.viewSize = [600, 400]; assert.deepEqual(viewToOriginal([50, 50], view), [100, 100]);
  const crop = { ...view, crop: [100, 50, 600, 400] as [number, number, number, number] };
  assert.deepEqual(viewToOriginal([100, 50], crop), [200, 100]); assert.deepEqual(originalToView([200, 100], crop), [100, 50]);
  assert.throws(() => viewToOriginal([-1, 0], view), /inside/); assert.throws(() => screenToOriginal([1, 1], { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 }, view), /singular/);
  assert.throws(() => screenToOriginal([1, 1], { a: Infinity, b: 0, c: 0, d: 1, e: 0, f: 0 }, view), /nonfinite/);
});
test('raw records are copied and deeply frozen while corrections remain a separate SI overlay', () => {
  const source = image(), sealed = sealExtraction(source), d: Digitization = { extraction: sealed, corrections: [{ index: 1, point: [0.001, 5], note: 'Use the identified knee.' }], assumptions: 'Linear interpolation.' };
  const before = JSON.stringify(sealed); assert.ok(Object.isFrozen(sealed)); if (source.kind === 'image') source.pixels[1][1] = 250;
  const raw = rawPointsSI(sealed); raw[1][1] = 99; assert.equal(JSON.stringify(sealed), before); assert.equal(correctedPointsSI(d)[1][1], 5); assert.equal(rawPointsSI(sealed)[1][1], 6);
});
test('quoted CSV supports BOM, CRLF, escaped quotes, explicit units, and decimal commas', () => {
  const m = mapping(); const points = parseCsv('\uFEFF"time","current","note"\r\n"0","-2000","a, b"\r\n"1","4000","a ""quote"""\r\n', m);
  assert.deepEqual(points, [[0, -2], [1e-6, 4]]);
  const euro = { ...m, delimiter: ';' as const, decimal: ',' as const, timeUnit: 'ms', valueUnit: 'A' };
  assert.deepEqual(parseCsv('t;y\n0,0;-2,5\n1,5;4,25\n', euro), [[0, -2.5], [0.0015, 4.25]]);
});
test('CSV confirmation, dimensions, malformed quoting, ragged rows, and nonfinite values fail visibly', () => {
  const m = mapping(); for (const change of [(m: any) => m.confirmed = false, (m: any) => m.timeUnit = '', (m: any) => m.valueUnit = 'V', (m: any) => m.xColumn = m.yColumn]) { const bad = mapping(); change(bad); assert.throws(() => parseCsv('t,y\n0,1\n1,2', bad)); }
  for (const s of ['t,y\n0,NaN\n1,2', 't,y\n0,Infinity\n1,2', 't,y\n0,1e999\n1,2', 't,y\n0,1e-999\n1,2', 't,y\n0,"1\n1,2', 't,y\n0,"1"x\n1,2', 't,y\n0,1,2\n1,2', 't,y\n0,1\n\n1,2']) assert.throws(() => parseCsv(s, m));
});
test('CSV input and row bounds reject before reconstruction with no automatic sorting', () => {
  assert.throws(() => parseCsv('x'.repeat(1024 * 1024 + 1), mapping()), /1 MiB/);
  assert.throws(() => parseCsv('t,y\n' + '0,1\n'.repeat(10001), mapping()), /10000/);
  assert.deepEqual(parseCsv('t,y\n2,1\n1,2', mapping()), [[2e-6, 0.001], [1e-6, 0.002]]);
});
test('duplicate and backward timestamps require explicit corrections and a finite edge assumption', () => {
  const d: Digitization = { extraction: { kind: 'csv', name: 'edge.csv', text: 't,y\n0,0\n0,1000\n2,1000', mapping: mapping() }, corrections: [], assumptions: 'Linear trace.' };
  const before = JSON.stringify(d.extraction); assert.throws(() => candidateSource(d), /duplicate/);
  d.corrections = [{ index: 1, point: [1e-6, 1], note: 'Assume a finite rise duration.' }]; assert.throws(() => candidateSource(d), /finite edge durations/);
  d.assumptions = 'Assume a finite rise duration of 1 us.'; d.finiteEdgesConfirmed = true; assert.equal(candidateSource(d).mode, 'semantic'); assert.equal(JSON.stringify(d.extraction), before);
  d.corrections[0].point[0] = 3e-6; assert.throws(() => candidateSource(d), /backward/);
});
test('accepted current and signed voltage use the unchanged semantic compiler', () => {
  for (const d of [digitization(), { extraction: { kind: 'csv', name: 'current.csv', text: 't,y\n0,-2000\n10,4000\n20,-2000', mapping: mapping() }, corrections: [], assumptions: 'Piecewise linear trace.' } as Digitization]) {
    const before = JSON.stringify(d), { source } = candidateSource(d), result = compileYaml(source); assert.equal(result.ok, true); if (!result.ok) throw Error();
    const points = correctedPointsSI(d); close(evaluate(result.compiled, points[1][0]), points[1][1]); assert.equal(JSON.stringify(d), before);
  }
});
test('acceptance requires assumptions and an explicit initial hold when the first time is positive', () => {
  const d = digitization(); d.assumptions = ''; assert.throws(() => candidateSource(d), /engineering assumptions/);
  d.assumptions = 'Linear interpolation.'; if (d.extraction.kind !== 'image') throw Error(); d.extraction.pixels[0][0] = 150;
  assert.throws(() => candidateSource(d), /initial hold/); d.assumptions = 'Assume an initial hold until 0.5 ms.'; d.initialHoldConfirmed = true; assert.equal(candidateSource(d).mode, 'semantic');
});
test('original bounds and correction identities prevent silent evidence drift', () => {
  const d = digitization(); if (d.extraction.kind !== 'image') throw Error(); d.extraction.pixels[0] = [-1, 100]; assert.throws(() => rawPointsSI(d.extraction), /inside/);
  const good = digitization(); for (const corrections of [[{ index: 9, point: [0, 1], note: 'Outside.' }], [{ index: 1, point: [0, NaN], note: 'Nonfinite.' }], [{ index: 1, point: [0, 1], note: '' }]]) { good.corrections = corrections as Digitization['corrections']; assert.throws(() => correctedPointsSI(good)); }
  const sparse = image(); if (sparse.kind !== 'image') throw Error(); sparse.pixels = new Array(2); assert.throws(() => rawPointsSI(sparse), /inside/); sparse.pixels = [new Array(2) as [number, number]]; assert.throws(() => rawPointsSI(sparse), /inside/);
});
test('foreign browser realm records survive validation while custom prototypes remain rejected', () => {
  const foreign = vm.runInNewContext(`(${JSON.stringify(image())})`);
  assert.deepEqual(rawPointsSI(sealExtraction(foreign)), [[0, -2], [0.001, 6], [0.004, -2]]);
  const custom = Object.assign(Object.create({ custom: true }), image()); assert.throws(() => rawPointsSI(custom), /fields/);
});
test('native unit conversion rejects silent numeric underflow', () => {
  const c = calibration(); c.timeUnit = 'ps'; c.x[1].value = 1e-320;
  assert.throws(() => pixelToSI([500, 100], c), /finite numeric range/);
});
test('the rectangular shortcut retains the two actual clicks and rejects fabricated derived landmarks', () => {
  const e = image(); if (e.kind !== 'image') throw Error(); e.calibration.method = 'two-corners'; e.calibration.originalCorners = [[100, 300], [500, 100]];
  assert.equal(checkCalibration(e.calibration).passed, true); assert.deepEqual(rawPointsSI(e), [[0, -2], [0.001, 6], [0.004, -2]]);
  e.calibration.originalCorners[1][0] = 501; assert.throws(() => rawPointsSI(e), /original corner/);
  e.calibration.originalCorners[1][0] = 500; e.calibration.method = 'four-landmarks'; assert.throws(() => rawPointsSI(e), /two-corner/);
});
