import type { Calibration, ImageView, Matrix, Pair } from './types.ts';
import { boundedPixel, DIGITIZE_LIMITS, factors, fail, finite, keys, pair } from './validation.ts';
import { parseQuantity } from '../semantic/units.ts';

export function validateCalibration(c: Calibration): void {
  keys(c, ['dimension', 'timeUnit', 'valueUnit', 'axes', 'rotation', 'x', 'y', 'tick', 'method', 'originalCorners'], ['dimension', 'timeUnit', 'valueUnit', 'axes', 'rotation', 'x', 'y', 'tick']); factors(c);
  if (c.axes !== 'linear' || c.rotation !== 'axis-aligned') fail('Native tracing requires linear, axis-aligned axes.');
  for (const axis of ['x', 'y'] as const) {
    const a = c[axis];
    if (!Array.isArray(a) || a.length !== 2) fail('Select four axis landmarks.');
    for (const p of a) { keys(p, ['pixel', 'value']); if (!pair(p.pixel) || !finite(p.value)) fail('Use finite landmark coordinates and values.'); }
    const index = axis === 'x' ? 0 : 1, cross = 1 - index;
    if (Math.abs(a[1].pixel[cross] - a[0].pixel[cross]) > DIGITIZE_LIMITS.alignmentPixels) fail('The axis landmarks show a rotated plot.');
    const span = a[1].pixel[index] - a[0].pixel[index], values = a[1].value - a[0].value;
    if (!(values > 0) || !(axis === 'x' ? span > 0 : span < 0) || !finite(values) || !finite(span)) fail('Use distinct, increasing values on noninverted axes.');
  }
  if (c.method !== undefined && !['four-landmarks', 'two-corners'].includes(c.method)) fail('Select the four-landmark or rectangular two-corner method.');
  if (c.method === 'two-corners') {
    if (!Array.isArray(c.originalCorners) || c.originalCorners.length !== 2 || !c.originalCorners.every(pair)) fail('Retain both original image corner clicks.');
    const [low, high] = c.originalCorners, expected: Pair[] = [low, [high[0], low[1]], low, [low[0], high[1]]], actual = [...c.x, ...c.y].map(a => a.pixel);
    if (actual.some((p, i) => p.some((n, j) => n !== expected[i][j]))) fail('The rectangular landmarks must match the original corner clicks.');
  } else if (c.originalCorners !== undefined) fail('Original corners require the rectangular two-corner method.');
  keys(c.tick, ['axis', 'pixel', 'value', 'tolerance']);
  if (!['x', 'y'].includes(c.tick.axis) || !pair(c.tick.pixel) || !finite(c.tick.value) || !finite(c.tick.tolerance) || c.tick.tolerance < 0) fail('Set a finite unused tick and an absolute tolerance in its axis units.');
  const index = c.tick.axis === 'x' ? 0 : 1;
  if (c[c.tick.axis].some(a => Math.abs(a.pixel[index] - c.tick.pixel[index]) <= DIGITIZE_LIMITS.alignmentPixels || a.value === c.tick.value)) fail('Check a labeled tick that is separate from the calibration endpoints.');
}
function mapped(n: number, c: Calibration, axis: 'x' | 'y', inverse = false): number {
  const [a, b] = c[axis], index = axis === 'x' ? 0 : 1;
  const result = inverse ? a.pixel[index] + (n - a.value) / (b.value - a.value) * (b.pixel[index] - a.pixel[index]) : a.value + (n - a.pixel[index]) / (b.pixel[index] - a.pixel[index]) * (b.value - a.value);
  if (!finite(result)) fail('The calibrated point exceeds the finite numeric range.'); return result;
}
export function checkCalibration(c: Calibration): { predicted: number; error: number; passed: boolean } {
  validateCalibration(c); const predicted = mapped(c.tick.pixel[c.tick.axis === 'x' ? 0 : 1], c, c.tick.axis), error = Math.abs(predicted - c.tick.value);
  return { predicted, error, passed: finite(error) && error <= c.tick.tolerance };
}
export function pixelToSI(pixel: Pair, c: Calibration): Pair {
  validateCalibration(c); if (!pair(pixel)) fail('Use finite image coordinates.');
  const result: Pair = [parseQuantity(`${mapped(pixel[0], c, 'x')} ${c.timeUnit}`, 'time'), parseQuantity(`${mapped(pixel[1], c, 'y')} ${c.valueUnit}`, c.dimension)];
  if (!result.every(finite)) fail('The calibrated point exceeds the finite numeric range.'); return result;
}
export function siToPixel(point: Pair, c: Calibration): Pair {
  validateCalibration(c); if (!pair(point)) fail('Use finite waveform points.'); const f = factors(c);
  return [mapped(point[0] / f[0], c, 'x', true), mapped(point[1] / f[1], c, 'y', true)];
}
function crop(view: ImageView): [number, number, number, number] {
  if (!pair(view.originalSize) || !pair(view.viewSize) || [...view.originalSize, ...view.viewSize].some(n => n <= 0)) fail('Use positive original and view dimensions.');
  const r = view.crop ?? [0, 0, ...view.originalSize];
  if (!Array.isArray(r) || r.length !== 4 || !r.every(finite) || r[0] < 0 || r[1] < 0 || r[2] <= 0 || r[3] <= 0 || r[0] + r[2] > view.originalSize[0] || r[1] + r[3] > view.originalSize[1]) fail('Use a crop inside the original image.'); return r as [number, number, number, number];
}
export function viewToOriginal(point: Pair, view: ImageView): Pair { const r = crop(view); boundedPixel(point, view.viewSize); return [r[0] + point[0] / view.viewSize[0] * r[2], r[1] + point[1] / view.viewSize[1] * r[3]]; }
export function originalToView(point: Pair, view: ImageView): Pair { const r = crop(view); boundedPixel(point, view.originalSize); const p: Pair = [(point[0] - r[0]) / r[2] * view.viewSize[0], (point[1] - r[1]) / r[3] * view.viewSize[1]]; boundedPixel(p, view.viewSize); return p; }
export function screenToOriginal(client: Pair, inverseCTM: Matrix, view: ImageView): Pair {
  if (!pair(client) || !inverseCTM || !['a', 'b', 'c', 'd', 'e', 'f'].every(k => finite(inverseCTM[k as keyof Matrix])) || !finite(inverseCTM.a * inverseCTM.d - inverseCTM.b * inverseCTM.c) || inverseCTM.a * inverseCTM.d === inverseCTM.b * inverseCTM.c) fail('The screen transform is missing, nonfinite, or singular.');
  return viewToOriginal([inverseCTM.a * client[0] + inverseCTM.c * client[1] + inverseCTM.e, inverseCTM.b * client[0] + inverseCTM.d * client[1] + inverseCTM.f], view);
}
