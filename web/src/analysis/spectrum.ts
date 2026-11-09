import { expandFinite } from '../semantic/evaluation.ts';
import type { CompiledRepeat, CompiledWaveform, Point } from '../semantic/types.ts';

export type SpectrumInput = { points: Point[]; durationS: number; periodic: boolean; unit: 'A' | 'V'; basisLabel: string };
export type SpectrumOptions = { harmonicCount?: number; method?: 'auto' | 'fft' | 'pwl'; cutoffHz?: number };
export type SpectrumBin = { index: number; frequencyHz: number; peak: number; rms: number; phaseRad: number };
type Failure = { ok: false; diagnostics: string[] };
export type SpectrumInputResult = { ok: true; input: SpectrumInput } | Failure;
export type FilteredSpectrum = { dc: number; cutoffHz: number; tauS: number; acRmsLower: number; acRmsUpper: number; totalRmsLower: number; totalRmsUpper: number; points: Point[] };
export type SpectrumResult = Failure | {
  ok: true; dc: number; totalRms: number; acRms: number; peakToPeak: number;
  bins: SpectrumBin[]; strongestAC: SpectrumBin | null; method: 'fft' | 'pwl'; sampleCount?: number;
  analyzedMaxHz: number; unresolvedAcRms: number; durationS: number; unit: 'A' | 'V';
  basisLabel: string; warnings: string[]; filtered?: FilteredSpectrum;
};
const MAX_POINTS = 100_000, MAX_WORK = 4_000_000, MAX_SAMPLES = 65_536;
const fail = (message: string): Failure => ({ ok: false, diagnostics: [message] });

function validate(input: SpectrumInput): string | undefined {
  if (!input || !Number.isFinite(input.durationS) || input.durationS <= 0 || !Number.isFinite(1 / input.durationS)) return 'Use a positive finite analysis duration with a finite frequency spacing.';
  if (!['A', 'V'].includes(input.unit) || typeof input.periodic !== 'boolean' || typeof input.basisLabel !== 'string') return 'Use a valid signal unit and analysis basis.';
  if (!Array.isArray(input.points) || input.points.length < 2 || input.points.length > MAX_POINTS) return 'Use 2 through 100000 source points.';
  for (let i = 0; i < input.points.length; i++) {
    const p = input.points[i];
    if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite) || (i > 0 && p[0] <= input.points[i - 1][0])) return 'Use finite points with strictly increasing times.';
  }
  if (input.points[0][0] !== 0 || input.points.at(-1)![0] !== input.durationS) return 'The complete analysis basis must start at zero and end at its declared duration.';
}

// Negative-exponent DFT and single-sided normalization follow NumPy:
// https://numpy.org/doc/stable/reference/routines.fft.html
export function fftSpectrum(samples: readonly number[], durationS: number): SpectrumBin[] {
  const n = samples.length;
  if (n < 2 || n > MAX_SAMPLES || (n & (n - 1)) !== 0 || !samples.every(Number.isFinite) || !Number.isFinite(durationS) || durationS <= 0) throw new RangeError('Use 2 through 65536 finite samples with a power-of-two count and a positive duration.');
  const re = Float64Array.from(samples), im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const value = re[i]; re[i] = re[j]; re[j] = value; }
  }
  for (let size = 2; size <= n; size *= 2) {
    const angle = -2 * Math.PI / size, wr = Math.cos(angle), wi = Math.sin(angle);
    for (let offset = 0; offset < n; offset += size) {
      let r = 1, q = 0;
      for (let j = 0; j < size / 2; j++) {
        const a = offset + j, b = a + size / 2;
        const tr = re[b] * r - im[b] * q, ti = re[b] * q + im[b] * r;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const next = r * wr - q * wi; q = r * wi + q * wr; r = next;
      }
    }
  }
  return Array.from({ length: n / 2 + 1 }, (_, k) => {
    const endpoint = k === 0 || k === n / 2;
    const peak = Math.hypot(re[k], im[k]) / n * (endpoint ? 1 : 2);
    return { index: k, frequencyHz: k / durationS, peak, rms: peak / (endpoint ? 1 : Math.SQRT2), phaseRad: Math.atan2(im[k], re[k]) };
  });
}

function exactBins(points: Point[], durationS: number, count: number, dc: number): SpectrumBin[] {
  const bins: SpectrumBin[] = [{ index: 0, frequencyHz: 0, peak: Math.abs(dc), rms: Math.abs(dc), phaseRad: dc < 0 ? Math.PI : 0 }];
  for (let k = 1; k <= count; k++) {
    let re = 0, im = 0;
    for (let j = 1; j < points.length; j++) {
      const a = points[j - 1], b = points[j], fraction = (b[0] - a[0]) / durationS;
      const z = Math.PI * k * fraction;
      const sinc = Math.abs(z) < 1e-4 ? 1 - z * z / 6 + z ** 4 / 120 : Math.sin(z) / z;
      const g = Math.abs(z) < 1e-3 ? z / 3 - z ** 3 / 30 + z ** 5 / 840 : (Math.sin(z) - z * Math.cos(z)) / (z * z);
      // Integrate a centered linear interval. The series avoids short-interval cancellation.
      const r = ((a[1] - dc) / 2 + (b[1] - dc) / 2) * fraction * sinc;
      const q = -(b[1] / 2 - a[1] / 2) * fraction * g;
      const phase = 2 * Math.PI * k * (a[0] / durationS + fraction / 2);
      re += r * Math.cos(phase) + q * Math.sin(phase);
      im += q * Math.cos(phase) - r * Math.sin(phase);
    }
    const peak = 2 * Math.hypot(re, im);
    bins.push({ index: k, frequencyHz: k / durationS, peak, rms: peak / Math.SQRT2, phaseRad: Math.atan2(im, re) });
  }
  return bins;
}

export function analyzeSpectrum(input: SpectrumInput, options: SpectrumOptions = {}): SpectrumResult {
  const error = validate(input); if (error) return fail(error);
  const count = options.harmonicCount ?? 256, requested = options.method ?? 'auto';
  if (!Number.isSafeInteger(count) || count < 1 || count > 2048) return fail('Use a harmonic count from 1 through 2048.');
  if (!['auto', 'fft', 'pwl'].includes(requested)) return fail('Choose auto, fft, or pwl analysis.');
  if ((input.points.length - 1) * count > MAX_WORK) return fail('The analysis exceeds four million interval-harmonic operations. Reduce the harmonic count or source point count.');
  if (options.cutoffHz !== undefined && (!Number.isFinite(options.cutoffHz) || options.cutoffHz <= 0 || !Number.isFinite((1 / options.cutoffHz) / (2 * Math.PI)) || (1 / options.cutoffHz) / (2 * Math.PI) <= 0)) return fail('Use a positive finite cutoff frequency with a representable time constant.');
  const { points, durationS } = input;
  let scale = 0, lo = Infinity, hi = -Infinity, minSpan = Infinity;
  for (const [, y] of points) { scale = Math.max(scale, Math.abs(y)); lo = Math.min(lo, y); hi = Math.max(hi, y); }
  let mean = 0, square = 0;
  for (let i = 1; i < points.length; i++) {
    const d = (points[i][0] - points[i - 1][0]) / durationS;
    minSpan = Math.min(minSpan, points[i][0] - points[i - 1][0]);
    const a = scale ? points[i - 1][1] / scale : 0, b = scale ? points[i][1] / scale : 0;
    mean += d * (a / 2 + b / 2); square += d * (a * a + a * b + b * b) / 3;
  }
  // An anchor keeps a small ripple separate from a large constant level.
  const anchor = points[0][1]; let deltaScale = 0;
  for (const [, y] of points) deltaScale = Math.max(deltaScale, Math.abs(y - anchor));
  let deltaMean = 0;
  if (Number.isFinite(deltaScale) && deltaScale > 0) for (let i = 1; i < points.length; i++) {
    deltaMean += (points[i][0] - points[i - 1][0]) / durationS * (((points[i - 1][1] - anchor) / deltaScale) / 2 + ((points[i][1] - anchor) / deltaScale) / 2);
  }
  const dc = Number.isFinite(deltaScale) ? anchor + deltaScale * deltaMean : scale * mean;
  const totalRms = scale * Math.sqrt(Math.max(0, square));
  let variance = 0, acScale = 0;
  for (const [, y] of points) acScale = Math.max(acScale, Math.abs(y - dc));
  if (!Number.isFinite(acScale)) return fail('The centered signal exceeds the finite numeric range. Reduce the signal magnitude.');
  for (let i = 1; i < points.length; i++) {
    const a = acScale ? (points[i - 1][1] - dc) / acScale : 0, b = acScale ? (points[i][1] - dc) / acScale : 0;
    variance += (points[i][0] - points[i - 1][0]) / durationS * (a * a + a * b + b * b) / 3;
  }
  const acRms = acScale * Math.sqrt(Math.max(0, variance));
  const warnings: string[] = [];
  // Coherent basis and finite-record interpretation:
  // https://www.analog.com/en/resources/technical-articles/coherent-sampling-vs-window-sampling.html
  if (!input.periodic) warnings.push('Finite record: bins use its periodic extension. They do not prove physical harmonics. Filter output assumes the record repeats, not a zero-state transient.');
  const required = Math.max(1024, 8 * durationS / minSpan, 2 * (count + 1));
  const sampleCount = 2 ** Math.ceil(Math.log2(required));
  let method: 'fft' | 'pwl' = requested === 'pwl' || sampleCount > MAX_SAMPLES || options.cutoffHz !== undefined ? 'pwl' : 'fft';
  if (sampleCount > MAX_SAMPLES && requested !== 'pwl') warnings.push('FFT feature sampling exceeds 65536 samples. Exact PWL Fourier coefficients retain the narrow source intervals.');
  if (options.cutoffHz !== undefined && requested === 'fft') warnings.push('Filter energy bounds require exact PWL Fourier coefficients. The displayed spectrum uses those coefficients.');
  let bins: SpectrumBin[];
  if (method === 'fft') {
    const samples: number[] = []; let j = 1;
    for (let i = 0; i < sampleCount; i++) {
      const t = i / sampleCount * durationS;
      while (j < points.length - 1 && points[j][0] < t) j++;
      const a = points[j - 1], b = points[j], f = (t - a[0]) / (b[0] - a[0]); samples.push((a[1] - dc) * (1 - f) + (b[1] - dc) * f);
    }
    bins = fftSpectrum(samples, durationS).slice(0, count + 1);
    bins[0] = { index: 0, frequencyHz: 0, peak: Math.abs(dc), rms: Math.abs(dc), phaseRad: dc < 0 ? Math.PI : 0 };
    warnings.push('FFT amplitudes are numerical estimates. Eight samples per shortest interval do not prove a band limit. DC and RMS use exact source integrals.');
  } else bins = exactBins(points, durationS, count, dc);
  let retained = 0;
  for (const bin of bins.slice(1)) retained += (acScale ? bin.rms / acScale : 0) ** 2;
  const tolerance = 1e-10 * variance;
  if (method === 'pwl' && retained - variance > tolerance) return fail('The computed harmonic energy exceeds the exact AC energy. Reduce the harmonic count or change the source time scale.');
  const residual = Math.max(0, variance - retained);
  const unresolvedAcRms = acScale * Math.sqrt(residual);
  if (method === 'fft') warnings.push('Unresolved AC RMS is an estimate from sampled coefficients. It is not a strict energy bound.');
  let strongestAC: SpectrumBin | null = null;
  for (const bin of bins.slice(1)) if (bin.peak > Math.max(acRms * 1e-12, Number.MIN_VALUE) && (!strongestAC || bin.peak > strongestAC.peak * (1 + 1e-12))) strongestAC = bin;
  const result: Extract<SpectrumResult, { ok: true }> = { ok: true, dc, totalRms, acRms, peakToPeak: hi - lo, bins, strongestAC, method,
    ...(method === 'fft' ? { sampleCount } : {}), analyzedMaxHz: count / durationS, unresolvedAcRms,
    durationS, unit: input.unit, basisLabel: input.basisLabel, warnings };
  if (options.cutoffHz !== undefined) {
    // Unity-DC first-order response: H(f) = 1 / (1 + j*f/fc).
    // Cutoff relation: https://developerhelp.microchip.com/xwiki/bin/view/products/amplifiers-linear/operational-amplifier-ics/introduction/low-pass-filters/
    const fc = options.cutoffHz, filteredBins = bins.slice(1).map(bin => {
      const ratio = bin.frequencyHz / fc;
      return { ...bin, peak: bin.peak / Math.hypot(1, ratio), phaseRad: bin.phaseRad - Math.atan(ratio) };
    });
    let energy = 0; for (const bin of filteredBins) energy += (acScale ? bin.peak / Math.SQRT2 / acScale : 0) ** 2;
    const lower = acScale * Math.sqrt(energy), upper = acScale * Math.sqrt(energy + residual / (1 + (((count + 1) / durationS) / fc) ** 2));
    const n = Math.min(4096, Math.max(512, 4 * count)), filteredPoints: Point[] = [];
    for (let i = 0; i <= n; i++) {
      let y = dc; for (const bin of filteredBins) y += bin.peak * Math.cos(2 * Math.PI * bin.index * (i === n ? 0 : i / n) + bin.phaseRad);
      filteredPoints.push([i / n * durationS, y]);
    }
    result.filtered = { dc, cutoffHz: fc, tauS: (1 / fc) / (2 * Math.PI), acRmsLower: lower, acRmsUpper: upper, totalRmsLower: Math.hypot(dc, lower), totalRmsUpper: Math.hypot(dc, upper), points: filteredPoints };
    warnings.push('Ideal unity-DC first-order low-pass output uses the signal unit. The plotted cycle is a band-limited periodic prediction. Sampled extrema are not physical ripple bounds.');
  }
  const metrics = [dc, totalRms, acRms, result.peakToPeak, result.analyzedMaxHz, unresolvedAcRms, ...bins.flatMap(b => [b.frequencyHz, b.peak, b.rms, b.phaseRad])];
  if (result.filtered) metrics.push(result.filtered.tauS, result.filtered.acRmsUpper, result.filtered.totalRmsUpper, ...result.filtered.points.map(p => p[1]));
  if (!metrics.every(Number.isFinite)) return fail('The analysis exceeds the finite numeric range. Reduce the signal magnitude or change the source time scale.');
  return result;
}

function completeInput(points: Point[], durationS: number, periodic: boolean, unit: 'A' | 'V', basisLabel: string): SpectrumInputResult {
  const input = { points, durationS, periodic, unit, basisLabel }, error = validate(input);
  return error ? fail(error) : { ok: true, input };
}

export function semanticSpectrumInput(compiled: CompiledWaveform, repeatId?: string, level: 'schedule' | 'pattern' = 'schedule'): SpectrumInputResult {
  const unit = compiled.dimension === 'voltage' ? 'V' : 'A';
  let repeat: CompiledRepeat | undefined;
  if (repeatId !== undefined) {
    repeat = compiled.nodes.find((n): n is CompiledRepeat => n.kind === 'repeat' && n.id === repeatId);
    if (!repeat) return fail('Select a repeat that exists in the compiled source.');
  } else if (compiled.nodes.length === 1 && compiled.nodes[0].kind === 'repeat') repeat = compiled.nodes[0];
  if (repeat) {
    const patternOnly = level === 'pattern', durationS = !patternOnly && repeat.outer ? repeat.outer.periodS : repeat.periodS;
    const count = !patternOnly && repeat.outer ? repeat.count : 1;
    if (count === 'continuous' || !Number.isSafeInteger(count) || count * repeat.pattern.reduce((sum, n) => sum + n.points.length, 0) + 2 > MAX_POINTS) return fail('The selected repeat exceeds 100000 points. Select its pattern basis or reduce the repetition count.');
    const points: Point[] = [], initial = repeat.pattern[0].points[0][1];
    const add = (t: number, y: number) => {
      const last = points.at(-1); if (last && t === last[0] && y === last[1]) return;
      points.push([t, y]);
    };
    add(0, initial);
    for (let i = 0; i < count; i++) for (const leaf of repeat.pattern) for (const [t, y] of leaf.points) {
      if (t > repeat.patternDurationS && leaf.derived) continue;
      let time = t === repeat.periodS ? (i + 1) * repeat.periodS : i * repeat.periodS + t;
      if (i === count - 1 && t === repeat.patternDurationS && repeat.activeSpanS >= durationS && Math.abs(time - durationS) <= 32 * Number.EPSILON * Math.max(time, durationS)) time = durationS;
      add(time, y);
    }
    add(durationS, initial);
    return completeInput(points, durationS, true, unit, `${repeat.id}: complete ${!patternOnly && repeat.outer ? 'outer burst period including idle' : 'pattern period including idle'}`);
  }
  if (compiled.continuous || !Number.isFinite(compiled.durationS)) return fail('Select a repeat explicitly for a mixed continuous source.');
  const expanded = expandFinite(compiled, { maxPoints: MAX_POINTS });
  if (!expanded.ok) return fail(expanded.diagnostics.map(d => d.message).join(' '));
  return completeInput(expanded.points, compiled.durationS, false, unit, 'Complete finite semantic record');
}

export type PointSpectrumProject = { points: Point[]; repetition?: { mode: 'single' | 'periodic' | 'burst'; periodUs?: number; count?: number; burstPeriodUs?: number } };
export function pointSpectrumInput(project: PointSpectrumProject, level: 'schedule' | 'pattern' = 'schedule'): SpectrumInputResult {
  if (!project || !Array.isArray(project.points) || project.points.length < 2 || project.points.length > 5000) return fail('Use a point project with 2 through 5000 points.');
  for (let i = 0; i < project.points.length; i++) {
    const p = project.points[i];
    if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite) || p[0] < 0 || (i > 0 && p[0] <= project.points[i - 1][0])) return fail('Use finite point-project values with nonnegative, increasing times.');
  }
  const source: Point[] = project.points.map(([t, y]) => [t * 1e-6, y]);
  const r = project.repetition ?? { mode: 'single' as const }, initial = source[0][1];
  if (!['single', 'periodic', 'burst'].includes(r.mode)) return fail('Use single, periodic, or burst repetition.');
  if (r.mode === 'single') {
    if (source[0][0] > 0) source.unshift([0, initial]);
    return completeInput(source, source.at(-1)![0], false, 'A', 'Complete finite point record');
  }
  const period = (r.periodUs ?? NaN) * 1e-6, end = source.at(-1)![0];
  if (!Number.isFinite(period) || period <= 0 || end > period || source.at(-1)![1] !== initial) return fail('The complete closed point pattern must fit its positive period.');
  const count = r.mode === 'burst' && level === 'schedule' ? r.count ?? NaN : 1;
  const durationS = r.mode === 'burst' && level === 'schedule' ? (r.burstPeriodUs ?? NaN) * 1e-6 : period;
  const spanUs = (count - 1) * r.periodUs! + project.points.at(-1)![0];
  const durationUs = r.mode === 'burst' && level === 'schedule' ? r.burstPeriodUs! : r.periodUs!;
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isFinite(durationS) || durationS <= 0 || spanUs > durationUs) return fail('Use a positive burst count and an outer period that includes every complete pattern.');
  if (count * (source.length + 1) + 1 > MAX_POINTS) return fail('The complete burst exceeds 100000 points. Select its pattern basis or reduce the repetition count.');
  const points: Point[] = [[0, initial]];
  for (let i = 0; i < count; i++) {
    const start = i * period;
    if (start > points.at(-1)![0]) points.push([start, initial]);
    for (const [t, y] of source) {
      const time = i === count - 1 && t === end && spanUs === durationUs ? durationS : t === period ? (i + 1) * period : start + t;
      if (time === points.at(-1)![0] && y === points.at(-1)![1]) continue;
      points.push([time, y]);
    }
  }
  if (points.at(-1)![0] !== durationS) points.push([durationS, initial]);
  return completeInput(points, durationS, true, 'A', r.mode === 'burst' && level === 'schedule' ? 'Complete point outer burst period including idle' : 'Complete point pattern period including idle');
}
