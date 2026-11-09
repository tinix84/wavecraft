import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSpectrum, fftSpectrum, pointSpectrumInput, semanticSpectrumInput } from '../src/analysis/spectrum.ts';
import type { SpectrumInput, SpectrumOptions } from '../src/analysis/spectrum.ts';
import { compileDocument } from '../src/semantic/index.ts';
import type { Point } from '../src/semantic/types.ts';

const close = (a: number, b: number, tolerance = 1e-10) => assert.ok(Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b)), `${a} != ${b}`);
const basis = (points: Point[], periodic = true): SpectrumInput => ({ points, durationS: points.at(-1)![0], periodic, unit: 'V', basisLabel: 'Independent fixture' });
function spectrum(input: SpectrumInput, options: SpectrumOptions = { method: 'pwl' }) {
  const result = analyzeSpectrum(input, options); assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('Analysis failed'); return result;
}
function input(result: ReturnType<typeof pointSpectrumInput>) { assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error('Adapter failed'); return result.input; }

test('constant signed DC retains its sign, zero AC, and unity filter DC without mutation', () => {
  const source = basis([[0, -12], [1, -12]]), before = JSON.stringify(source);
  const result = spectrum(source, { cutoffHz: 2 });
  close(result.dc, -12); close(result.totalRms, 12); close(result.acRms, 0); close(result.peakToPeak, 0);
  assert.equal(result.strongestAC, null); close(result.filtered!.dc, -12);
  close(result.filtered!.acRmsUpper, 0); assert.ok(result.filtered!.points.every(p => p[1] === -12));
  assert.equal(JSON.stringify(source), before);
});

test('radix-2 FFT matches independent sampled cosine and sine normalization and phase', () => {
  const n = 128, amplitude = 3, dc = -2, k = 7;
  const cosine = fftSpectrum(Array.from({ length: n }, (_, j) => dc + amplitude * Math.cos(2 * Math.PI * k * j / n)), 2);
  close(cosine[0].peak, 2); close(cosine[k].peak, amplitude); close(cosine[k].rms, amplitude / Math.SQRT2);
  close(cosine[k].frequencyHz, 3.5); close(cosine[k].phaseRad, 0);
  const sine = fftSpectrum(Array.from({ length: n }, (_, j) => 4 * Math.sin(2 * Math.PI * 5 * j / n)), 1);
  close(sine[5].peak, 4); close(sine[5].phaseRad, -Math.PI / 2);
});

test('FFT DC and Nyquist bins are not doubled', () => {
  const bins = fftSpectrum([5, -1, 5, -1, 5, -1, 5, -1], 1);
  close(bins[0].peak, 2); close(bins[4].peak, 3); close(bins[4].rms, 3);
  assert.throws(() => fftSpectrum([1, 2, 3], 1), /power-of-two/);
});

test('FFT interpolation of uneven constant knots does not create AC components', () => {
  for (const constant of [25, 1e12 + 1, -1e12 - 1]) {
    const result = spectrum(basis([[0, constant], [.13, constant], [.37, constant], [.9, constant], [1, constant]]), { method: 'fft' });
    assert.equal(result.method, 'fft'); assert.equal(result.strongestAC, null); assert.equal(result.acRms, 0);
    assert.ok(result.bins.slice(1).every(b => b.peak === 0));
  }
});

test('triangular PWL exact integrals and odd harmonics match independent Fourier series', () => {
  const result = spectrum(basis([[0, 2], [.5, -2], [1, 2]]), { method: 'pwl', harmonicCount: 31 });
  close(result.dc, 0); close(result.totalRms, 2 / Math.sqrt(3)); close(result.acRms, 2 / Math.sqrt(3)); close(result.peakToPeak, 4);
  for (let k = 1; k <= 31; k++) close(result.bins[k].peak, k % 2 ? 16 / (Math.PI ** 2 * k ** 2) : 0);
  assert.equal(result.strongestAC!.index, 1);
  const retained = result.bins.slice(1).reduce((sum, b) => sum + b.rms ** 2, 0);
  close(retained + result.unresolvedAcRms ** 2, 4 / 3);
});

test('large signed DC does not erase small ripple RMS', () => {
  const result = spectrum(basis([[0, -1e12 - 1], [.5, -1e12 + 1], [1, -1e12 - 1]]));
  close(result.dc, -1e12); close(result.acRms, 1 / Math.sqrt(3)); close(result.bins[1].peak, 8 / Math.PI ** 2);
});

test('trapezoidal pulse mean and RMS come from source integrals', () => {
  const result = spectrum(basis([[0, 0], [.1, 6], [.3, 6], [.4, 0], [1, 0]]));
  close(result.dc, 1.8); close(result.totalRms, Math.sqrt(9.6)); close(result.acRms, Math.sqrt(9.6 - 1.8 ** 2));
});

test('guarded automatic FFT exposes its estimates and keeps exact source metrics', () => {
  const result = spectrum(basis([[0, 1], [.5, -1], [1, 1]]), { harmonicCount: 16 });
  assert.equal(result.method, 'fft'); assert.ok(result.sampleCount! <= 65536); close(result.totalRms, 1 / Math.sqrt(3));
  close(result.bins[1].peak, 8 / Math.PI ** 2, 1e-5); assert.ok(result.warnings.some(w => w.includes('numerical estimates')));
});

test('low-pass fundamental has cutoff gain, lag, and preserved DC', () => {
  // A retained triangle fundamental is exactly A*cos(2*pi*t). This isolates H(f).
  const result = spectrum(basis([[0, 5], [.5, 1], [1, 5]]), { method: 'pwl', harmonicCount: 1, cutoffHz: 1 });
  const filter = result.filtered!, amplitude = 16 / Math.PI ** 2;
  close(filter.dc, 3); close(filter.tauS, 1 / (2 * Math.PI));
  close(filter.acRmsLower, amplitude / 2);
  for (const [t, y] of filter.points) close(y, 3 + amplitude / Math.SQRT2 * Math.cos(2 * Math.PI * t - Math.PI / 4));
});

test('truncated filter energy encloses independently summed triangle response', () => {
  const result = spectrum(basis([[0, 1], [.5, -1], [1, 1]]), { harmonicCount: 3, cutoffHz: 2 });
  let energy = 0;
  for (let k = 1; k < 10000; k += 2) energy += (8 / (Math.PI ** 2 * k ** 2)) ** 2 / (2 * (1 + (k / 2) ** 2));
  const actual = Math.sqrt(energy), filter = result.filtered!;
  assert.ok(filter.acRmsLower <= actual); assert.ok(filter.acRmsUpper >= actual);
  assert.ok(filter.acRmsUpper < result.acRms);
});

test('point burst retains all twenty two-pulse patterns and long outer idle', () => {
  const project = { points: [[0, 0], [.1, 6], [.2, 0], [.3, 6], [.4, 0]] as Point[], repetition: { mode: 'burst' as const, periodUs: 1, count: 20, burstPeriodUs: 1e6 } };
  const before = JSON.stringify(project), source = input(pointSpectrumInput(project));
  assert.equal(source.durationS, 1); assert.equal(source.points.filter(p => p[1] === 6).length, 40);
  const result = spectrum(source, { harmonicCount: 256 });
  close(result.dc, 24e-6); close(result.totalRms, Math.sqrt(96e-6));
  assert.equal(result.method, 'pwl'); assert.ok(result.bins[1].peak > 0); assert.ok(result.unresolvedAcRms > 0);
  assert.equal(result.analyzedMaxHz, 256); assert.equal(JSON.stringify(project), before);
  close(input(pointSpectrumInput(project, 'pattern')).durationS, 1e-6);
});

test('point initial gap and idle use the original baseline', () => {
  const source = input(pointSpectrumInput({ points: [[2, 5], [3, 9], [4, 5]], repetition: { mode: 'periodic', periodUs: 10 } }));
  assert.deepEqual(source.points[0], [0, 5]); close(source.points.at(-1)![0], 1e-5); assert.equal(source.points.at(-1)![1], 5);
  close(spectrum(source).dc, 5.4);
});

test('semantic adapter selects a complete outer period or an explicit pattern period', () => {
  const compiled = compileDocument({ schema: 'wavecraft/1', name: 'burst', signal: { dimension: 'current', initial: '0 A' }, segments: [{ id: 'b', kind: 'repeat', frequency: '1 MHz', count: 10, outer: { period: '1 s', count: 'continuous' }, pattern: [{ id: 'up', kind: 'ramp', to: '6 A', duration: '100 ns' }, { id: 'down', kind: 'ramp', to: '0 A', duration: '100 ns' }] }] });
  assert.equal(compiled.ok, true); if (!compiled.ok) return;
  const source = input(semanticSpectrumInput(compiled.compiled));
  close(source.durationS, 1); assert.equal(source.points.filter(p => p[1] === 6).length, 10);
  close(spectrum(source).dc, 6e-6); close(input(semanticSpectrumInput(compiled.compiled, 'b', 'pattern')).durationS, 1e-6);
});

test('semantic finite records include prefix and suffix instead of silently selecting a repeat', () => {
  const compiled = compileDocument({ schema: 'wavecraft/1', name: 'finite', signal: { dimension: 'voltage', initial: '2 V' }, segments: [{ id: 'a', kind: 'hold', duration: '2 s' }, { id: 'b', kind: 'repeat', period: '1 s', count: 2, pattern: [{ id: 'hold', kind: 'hold', duration: '1 s' }] }, { id: 'c', kind: 'hold', duration: '3 s' }] });
  assert.equal(compiled.ok, true); if (!compiled.ok) return;
  const source = input(semanticSpectrumInput(compiled.compiled)); close(source.durationS, 7); assert.equal(source.periodic, false); assert.equal(source.unit, 'V');
  close(input(semanticSpectrumInput(compiled.compiled, 'b')).durationS, 1);
});

test('finite records expose periodic-extension assumptions', () => {
  const result = spectrum(basis([[0, 0], [1, 1]], false), { cutoffHz: 1 });
  assert.ok(result.warnings.some(w => w.includes('Finite record'))); assert.ok(result.warnings.some(w => w.includes('not a zero-state transient')));
});

test('invalid coverage, finite values, options, and work limits produce diagnostics', () => {
  const valid = basis([[0, 0], [1, 1]]);
  for (const source of [{ ...valid, durationS: 0 }, { ...valid, points: [[.1, 0], [1, 1]] }, { ...valid, points: [[0, NaN], [1, 1]] }, { ...valid, points: [[0, 0], [0, 1], [1, 1]] }]) assert.equal(analyzeSpectrum(source as SpectrumInput).ok, false);
  for (const options of [{ harmonicCount: 0 }, { harmonicCount: 2049 }, { cutoffHz: -1 }, { cutoffHz: Infinity }]) assert.equal(analyzeSpectrum(valid, options).ok, false);
  const huge = basis(Array.from({ length: 2001 }, (_, j) => [j / 2000, j % 2]));
  const limited = analyzeSpectrum(huge, { harmonicCount: 2048 }); assert.equal(limited.ok, false);
  if (!limited.ok) assert.match(limited.diagnostics[0], /four million/);
  assert.equal(pointSpectrumInput({ points: [[0, 0], [1, 0]], repetition: { mode: 'burst', periodUs: 1, count: 100001, burstPeriodUs: 1e6 } }).ok, false);
});
