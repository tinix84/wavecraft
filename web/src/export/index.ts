import { compileDocument, evaluate, expandFinite } from '../semantic/index.ts';
import type { CompiledLeaf, CompiledRepeat, CompiledWaveform, Diagnostic, Point } from '../semantic/index.ts';

export type ExportFormat = 'csv' | 'csv-uniform' | 'pwl' | 'pwl-file' | 'plecs' | 'python' | 'javascript' | 'matlab';
export type ExportOptions = { format: ExportFormat; name?: string; horizonS?: number; sampleIntervalS?: number; maxPoints?: number; repeatMode?: 'auto' | 'expand' };
export type ExportArtifact = { filename: string; content: string; mimeType: string; role: 'primary' | 'support' };
export type ExportMetadata = {
  format: ExportFormat; dimension: 'current' | 'voltage'; representation: 'exact-points' | 'uniform-samples' | 'compact-repeat';
  horizonS: number | null; lastSampleS?: number; sampleIntervalS?: number; pointCount: number;
  capabilities: { endpointHold: boolean; compactRepeat: boolean; twoLevelRepeat: boolean };
  repeat?: { innerPeriodS: number; innerCount: number | 'continuous'; outerPeriodS?: number; outerCount?: number | 'continuous' };
};
export type ExportResult = { ok: true; artifacts: ExportArtifact[]; warnings: Diagnostic[]; metadata: ExportMetadata } | { ok: false; diagnostics: Diagnostic[] };
export type PointCompileResult = { ok: true; compiled: CompiledWaveform; diagnostics: Diagnostic[] } | { ok: false; diagnostics: Diagnostic[] };

const LIMIT = 100_000;
const diagnostic = (code: string, message: string, severity: 'error' | 'warning' = 'error'): Diagnostic => ({ code, message, severity, source: { path: [] } });
const failure = (code: string, message: string): { ok: false; diagnostics: Diagnostic[] } => ({ ok: false, diagnostics: [diagnostic(code, message)] });
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const positive = (n: unknown): n is number => finite(n) && n > 0;
const count = (n: unknown) => n === 'continuous' || (Number.isSafeInteger(n) && (n as number) > 0);
const basename = (name = 'waveform') => {
  const stem = name.normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'waveform';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem) ? `wavecraft-${stem}` : stem;
};

// Validate the public compiled boundary before evaluation or expansion.
function validCompiled(c: CompiledWaveform): boolean {
  if (!c || !['current', 'voltage'].includes(c.dimension) || !finite(c.initialValue) || !finite(c.finalValue) || typeof c.continuous !== 'boolean' || !Array.isArray(c.nodes) || c.nodes.length > 10_000) return false;
  if (c.continuous ? c.durationS !== Infinity : !finite(c.durationS) || c.durationS < 0) return false;
  let items = 0;
  const timing = (n: CompiledLeaf | CompiledRepeat, continuous = false) => n.timing && finite(n.timing.startS) && n.timing.startS >= 0 && (continuous ? n.timing.endS === Infinity && n.timing.durationS === Infinity : finite(n.timing.endS) && n.timing.endS >= n.timing.startS && finite(n.timing.durationS) && n.timing.durationS === n.timing.endS - n.timing.startS);
  const leaf = (n: CompiledLeaf) => {
    if (!n || !['hold', 'ramp', 'points', 'idle'].includes(n.kind) || !timing(n) || !Array.isArray(n.points) || !n.points.length) return false;
    let last = -1;
    for (const p of n.points) {
      if (++items > 100_000 || !Array.isArray(p) || p.length !== 2 || !finite(p[0]) || !finite(p[1]) || p[0] < 0 || p[0] <= last) return false;
      last = p[0];
    }
    return n.points[0][0] === n.timing.startS && last === n.timing.endS;
  };
  let previousEnd = 0, level = c.initialValue;
  const fits = (a: number, b: number) => a <= b + 32 * Number.EPSILON * Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE);
  for (let i = 0; i < c.nodes.length; i++) {
    const n = c.nodes[i];
    if (!n || !n.timing || n.timing.startS !== previousEnd) return false;
    if (n.kind !== 'repeat') {
      if (!leaf(n) || n.points[0][1] !== level) return false;
      level = n.points.at(-1)![1];
    }
    else {
      const continuous = n.outer ? n.outer.count === 'continuous' : n.count === 'continuous';
      if (!timing(n, continuous) || !positive(n.periodS) || !positive(n.frequencyHz) || !count(n.count) || !positive(n.patternDurationS) || !Array.isArray(n.pattern) || !n.pattern.length || !n.pattern.every(leaf)) return false;
      if (n.outer && (n.count === 'continuous' || !positive(n.outer.periodS) || !positive(n.outer.frequencyHz) || !count(n.outer.count) || !positive(n.activeSpanS))) return false;
      if (continuous && i !== c.nodes.length - 1) return false;
      let patternEnd = 0, patternLevel = level;
      for (const part of n.pattern) {
        if (part.timing.startS !== patternEnd || part.points[0][1] !== patternLevel) return false;
        patternEnd = part.timing.endS; patternLevel = part.points.at(-1)![1];
      }
      if (patternLevel !== level || !fits(n.patternDurationS, n.periodS) || !fits(patternEnd, n.periodS)) return false;
      const active = n.count === 'continuous' ? Infinity : (n.count - 1) * n.periodS + n.patternDurationS;
      if (n.activeSpanS !== active || (n.outer && !fits(active, n.outer.periodS))) return false;
      const repetitions = n.outer?.count ?? n.count, period = n.outer?.periodS ?? n.periodS;
      const occupied = repetitions === 'continuous' ? Infinity : repetitions * period;
      if (n.timing.endS !== n.timing.startS + occupied) return false;
    }
    previousEnd = n.timing.endS;
  }
  return previousEnd === c.durationS && level === c.finalValue;
}

export function compilePointProject(project: unknown): PointCompileResult {
  if (!project || typeof project !== 'object' || Array.isArray(project)) return failure('POINT_PROJECT', 'Use a version-1 point project.');
  const p = project as any;
  if (p.version !== 1 || typeof p.name !== 'string' || !p.name.trim() || p.units?.time !== 'us' || p.units?.current !== 'A') return failure('POINT_PROJECT', 'Use version 1, a waveform name, and units us and A.');
  if (!Array.isArray(p.points) || p.points.length < 2 || p.points.length > 5000) return failure('RESOURCE_LIMIT', 'Use from 2 through 5000 point-project points.');
  if (p.maxSlew != null && !positive(p.maxSlew)) return failure('SLEW_LIMIT', 'Use a positive maximum slew or null.');
  for (let i = 0; i < p.points.length; i++) {
    const q = p.points[i], previous = p.points[i - 1];
    if (!Array.isArray(q) || q.length !== 2 || !q.every(finite) || q[0] < 0 || (i && q[0] <= previous[0])) return failure('POINT_ORDER', 'Use finite amplitudes and nonnegative, strictly increasing point times.');
    if (i && p.maxSlew && Math.abs(q[1] - previous[1]) / (q[0] - previous[0]) > p.maxSlew * (1 + 1e-10)) return failure('SLEW_LIMIT', 'A point segment exceeds the project maximum slew.');
  }
  const r = p.repetition ?? { mode: 'single' };
  if (!r || !['single', 'periodic', 'burst'].includes(r.mode)) return failure('POINT_PROJECT', 'Select single, periodic, or burst repetition.');
  const last = p.points.at(-1);
  if (r.mode !== 'single') {
    if (!positive(r.periodUs) || !positive(1e6 / r.periodUs) || last[0] > r.periodUs) return failure('REPEAT_FIT', 'Use a positive pattern period that includes every point.');
    if (last[1] !== p.points[0][1]) return failure('REPEAT_CLOSURE', 'Return explicitly to the first point level before repetition.');
    if (r.mode === 'burst' && (!Number.isSafeInteger(r.count) || r.count < 1 || !positive(r.burstPeriodUs) || !positive(1e6 / r.burstPeriodUs) || !finite((r.count - 1) * r.periodUs + last[0]) || (r.count - 1) * r.periodUs + last[0] > r.burstPeriodUs)) return failure('REPEAT_FIT', 'Use a positive inner count and an outer period that includes the complete burst.');
  }
  const segment = { id: 'point-project-pattern', kind: 'points', points: p.points.map(([t, a]: Point, i: number) => ({ id: `point-project-${i}`, time: `${t} us`, value: `${a} A` })) };
  const segments = r.mode === 'single' ? [segment] : [{ id: 'point-project-repeat', kind: 'repeat', period: `${r.periodUs} us`, count: r.mode === 'periodic' ? 'continuous' : r.count, pattern: [segment], ...(r.mode === 'burst' ? { outer: { period: `${r.burstPeriodUs} us`, count: 'continuous' } } : {}) }];
  const result = compileDocument({ schema: 'wavecraft/1', name: p.name, signal: { dimension: 'current', initial: `${p.points[0][1]} A` }, segments });
  return result.ok ? { ok: true, compiled: result.compiled, diagnostics: result.diagnostics } : result;
}

export function exportWaveform(compiled: CompiledWaveform, options: ExportOptions): ExportResult {
  try {
    if (!validCompiled(compiled)) return failure('COMPILED_MODEL', 'Use a valid compiled waveform with finite values and ordered corners.');
    if (!options || !['csv', 'csv-uniform', 'pwl', 'pwl-file', 'plecs', 'python', 'javascript', 'matlab'].includes(options.format)) return failure('EXPORT_FORMAT', 'Select a supported numerical export format.');
    if (options.name !== undefined && typeof options.name !== 'string') return failure('EXPORT_OPTIONS', 'Use a text export name.');
    if (options.repeatMode !== undefined && !['auto', 'expand'].includes(options.repeatMode)) return failure('EXPORT_OPTIONS', 'Select auto or expand repeat mode.');
    if (options.horizonS !== undefined && (!finite(options.horizonS) || options.horizonS < 0)) return failure('HORIZON', 'Use a finite nonnegative export horizon.');
    const max = options.maxPoints ?? LIMIT;
    if (!Number.isSafeInteger(max) || max < 1 || max > LIMIT) return failure('RESOURCE_LIMIT', 'Use a point budget from 1 through 100000.');
    if (options.sampleIntervalS !== undefined && !positive(options.sampleIntervalS)) return failure('SAMPLE_INTERVAL', 'Use a finite positive sample interval.');
    const format = options.format, name = basename(options.name), warnings: Diagnostic[] = [];
    const compact = (format === 'pwl' || format === 'pwl-file') && options.horizonS === undefined && options.repeatMode !== 'expand' && compiled.nodes.length === 1 && compiled.nodes[0].kind === 'repeat';
    // LTspice waveform evidence covers FOR, FOREVER, and source polarity.
    const compactVerified = true;
    if (compact && compactVerified) return compactLtspice(compiled, compiled.nodes[0] as CompiledRepeat, options, name, max);
    if (compiled.continuous && options.horizonS === undefined) return failure(compact ? 'CAPABILITY' : 'HORIZON_REQUIRED', compact ? 'Compact target repetition requires simulator waveform verification. Declare a finite export horizon.' : 'Declare a finite export horizon for continuous repetition.');
    const horizonS = options.horizonS ?? compiled.durationS;
    let points: Point[];
    if (format === 'csv-uniform') {
      const dt = options.sampleIntervalS;
      if (!positive(dt)) return failure('SAMPLE_INTERVAL', 'Declare a finite positive sample interval for uniform CSV.');
      if (max * dt <= horizonS) return failure('RESOURCE_LIMIT', 'The uniform grid exceeds its point budget. Increase the interval or reduce the horizon.');
      let last = Math.floor(horizonS / dt);
      if (!Number.isSafeInteger(last) || last < 0) return failure('NUMERIC_RANGE', 'The uniform grid exceeds numeric precision.');
      while (last > 0 && last * dt > horizonS) last--;
      while ((last + 1) * dt <= horizonS) last++;
      if (last + 1 > max) return failure('RESOURCE_LIMIT', 'The uniform grid exceeds its point budget.');
      points = [];
      for (let k = 0; k <= last; k++) {
        const t = k * dt, value = evaluate(compiled, t);
        if (!finite(t) || !finite(value) || (k > 0 && t <= points[k - 1][0])) return failure('NUMERIC_RANGE', 'The uniform grid cannot retain distinct finite timestamps.');
        points.push([t, value]);
      }
      warnings.push(diagnostic('UNIFORM_SAMPLING', 'Uniform samples can miss corners. The last sample stays on the requested grid and does not exceed the horizon.', 'warning'));
    } else {
      const result = expandFinite(compiled, { horizonS, maxPoints: max });
      if (!result.ok) return result;
      points = result.points;
    }
    if (compiled.continuous || horizonS < compiled.durationS) warnings.push(diagnostic('FINITE_COVERAGE', 'This export covers the declared finite horizon. It does not retain the complete repetition schedule.', 'warning'));
    const metadata: ExportMetadata = { format, dimension: compiled.dimension, representation: format === 'csv-uniform' ? 'uniform-samples' : 'exact-points', horizonS, pointCount: points.length, capabilities: { endpointHold: true, compactRepeat: false, twoLevelRepeat: false }, ...(format === 'csv-uniform' ? { lastSampleS: points.at(-1)![0], sampleIntervalS: options.sampleIntervalS } : {}) };
    return { ok: true, artifacts: finiteArtifacts(points, compiled.dimension, format, name), warnings, metadata };
  } catch {
    return failure('EXPORT_INPUT', 'The export input cannot produce finite numerical artifacts.');
  }
}

const source = (dimension: 'current' | 'voltage') => dimension === 'current' ? 'I_LOAD 0 1' : 'V_SIGNAL 1 0';
const artifact = (filename: string, content: string, role: ExportArtifact['role'] = 'primary', mimeType = 'text/plain'): ExportArtifact => ({ filename, content, role, mimeType });
const pointText = (points: Point[]) => points.map(([t, v]) => `${t} ${v}`).join('\n');

function finiteArtifacts(points: Point[], dimension: 'current' | 'voltage', format: ExportFormat, name: string): ExportArtifact[] {
  const variable = dimension === 'current' ? 'current_A' : 'voltage_V';
  const times = points.map(p => p[0].toString()).join(', '), values = points.map(p => p[1].toString()).join(', ');
  if (format === 'csv' || format === 'csv-uniform') return [artifact(`${name}.csv`, `time_s,${variable}\n${points.map(p => p.join(',')).join('\n')}\n`, 'primary', 'text/csv')];
  if (format === 'pwl') return [artifact(`${name}.cir`, `* Time: seconds. ${dimension === 'current' ? 'Current: amperes, positive from node 0 to node 1.' : 'Voltage: volts, V(1)-V(0).'}\n* The source holds the final value after the final point.\n${source(dimension)} PWL(\n${pointText(points).split('\n').map(p => '+ ' + p).join('\n')}\n+ )\n`)];
  if (format === 'pwl-file') return [artifact(`${name}.txt`, pointText(points) + '\n'), artifact(`${name}.cir`, `* Keep the data file beside this source include. Times are seconds.\n* The source holds both endpoint levels.\n${source(dimension)} PWL FILE="${name}.txt"\n`, 'support'), artifact(`${name}-instructions.txt`, `Keep ${name}.txt and ${name}.cir in the simulation directory.\nInclude ${name}.cir in your circuit.\n${dimension === 'current' ? 'Positive I(I_LOAD) flows from node 0 to node 1.' : 'V_SIGNAL defines V(1)-V(0).'}\nConnect the load between nodes 1 and 0.\nThe data file has plain seconds and ${dimension === 'current' ? 'amperes' : 'volts'}, without a header.\n`, 'support')];
  if (format === 'python') return [artifact(`${name}.py`, `import numpy as np\n\ntime_s = np.array([${times}])\n${variable} = np.array([${values}])\n# np.interp holds the first and last levels outside the data range.\ndef evaluate_waveform(t_s):\n    return np.interp(t_s, time_s, ${variable})\n`)];
  if (format === 'javascript') return [artifact(`${name}.js`, `const time_s = [${times}];\nconst ${variable} = [${values}];\nfunction evaluateWaveform(t_s) {\n  if (!Number.isFinite(t_s)) throw new RangeError('Use a finite query time.');\n  if (t_s <= time_s[0]) return ${variable}[0];\n  const last = time_s.length - 1;\n  if (t_s >= time_s[last]) return ${variable}[last];\n  let lo = 0, hi = last;\n  while (hi - lo > 1) { const mid = (lo + hi) >>> 1; if (time_s[mid] <= t_s) lo = mid; else hi = mid; }\n  const fraction = (t_s - time_s[lo]) / (time_s[hi] - time_s[lo]);\n  return ${variable}[lo] * (1 - fraction) + ${variable}[hi] * fraction;\n}\n`)];
  const vectors = `time_s = [${times}];\n${variable} = [${values}];\n`;
  const lookup = points.length === 1 ? `${variable}(1) + zeros(size(t_s))` : `interp1(time_s, ${variable}, min(max(t_s, time_s(1)), time_s(end)), 'linear')`;
  if (format === 'matlab') return [artifact(`${name}.m`, `${vectors}% Clamp query time before interpolation to hold both endpoint levels.\nwaveform_at = @(t_s) ${lookup};\n`)];
  const integration = points.length === 1 ? 'This export has one point. Use a Constant block with value y(1).\nThe Constant block holds this level for all times.\n' : 'Use Clock -> Saturation -> 1D Look-Up Table.\nSet Saturation Lower limit (LowerLimit) to t(1).\nSet Saturation Upper limit (UpperLimit) to t(end).\nSet table Vector of input values x (x) to t.\nSet table Vector of output values f(x) (f(x)) to y.\nSet Locate discontinuities (ZeroCrossingSignals) to on.\nThe table extrapolates outside its input range. The upstream Saturation block holds both endpoint levels.\n';
  return [artifact(`${name}.m`, `% Paste these vectors into PLECS model Initialization commands.\n${vectors}t = time_s;\ny = ${variable};\n`), artifact(`${name}-instructions.txt`, `PLECS Standalone 4.9 integration\nPaste ${name}.m into the model Initialization commands.\n${integration}The output is ${dimension === 'current' ? 'amperes. Connect it to a Controlled Current Source.' : 'volts. Connect it to a Controlled Voltage Source.'}\nThis finite data does not retain compact repetition.\n`, 'support')];
}

function compactLtspice(compiled: CompiledWaveform, repeat: CompiledRepeat, options: ExportOptions, name: string, max: number): ExportResult {
  const period = repeat.outer?.periodS ?? repeat.periodS;
  const cycle = expandFinite(compiled, { horizonS: period, maxPoints: max });
  if (!cycle.ok) return cycle;
  const repetitions = repeat.outer?.count ?? repeat.count;
  const directive = repetitions === 'continuous' ? 'REPEAT FOREVER' : `REPEAT FOR ${repetitions}`;
  const comment = `* Inner period: ${repeat.periodS} s; inner count: ${repeat.count}.${repeat.outer ? ` Outer period: ${repeat.outer.periodS} s; outer count: ${repeat.outer.count}.` : ''}\n`;
  const data = pointText(cycle.points);
  const artifacts = options.format === 'pwl-file' ? [artifact(`${name}.txt`, data + '\n'), artifact(`${name}.cir`, `${comment}${source(compiled.dimension)} PWL ${directive} FILE="${name}.txt" ENDREPEAT\n`, 'support')] : [artifact(`${name}.cir`, `${comment}${source(compiled.dimension)} PWL ${directive} (\n${data.split('\n').map(p => '+ ' + p).join('\n')}\n+ ) ENDREPEAT\n`)];
  return { ok: true, artifacts, warnings: repeat.outer ? [diagnostic('INNER_EXPANSION', 'The compact outer cycle contains expanded inner patterns. Both periods and counts remain in export metadata.', 'warning')] : [], metadata: { format: options.format, dimension: compiled.dimension, representation: 'compact-repeat', horizonS: compiled.continuous ? null : compiled.durationS, pointCount: cycle.points.length, capabilities: { endpointHold: true, compactRepeat: true, twoLevelRepeat: !!repeat.outer }, repeat: { innerPeriodS: repeat.periodS, innerCount: repeat.count, ...(repeat.outer ? { outerPeriodS: repeat.outer.periodS, outerCount: repeat.outer.count } : {}) } } };
}
