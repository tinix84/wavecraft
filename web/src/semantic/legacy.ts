import { isAlias, parseDocument, stringify, visit } from 'yaml';
import { compileDocument, evaluate, expandFinite } from './index.ts';
import type { CompileResult, Diagnostic, Point, SourceRef } from './index.ts';

export type LegacyDifference = { code: string; message: string; source?: SourceRef };
export type LegacyResult = {
  ok: boolean; sourceText: string; points: Point[];
  warnings: string[]; diagnostics: Diagnostic[];
  name?: string; differences: LegacyDifference[];
};
export type MigrationPreview = {
  legacy: LegacyResult; candidateSource?: string; candidate?: CompileResult;
  shapeEquivalent: boolean; differences: LegacyDifference[];
};

type Step = { kind: 'hold' | 'absolute'; value: number; t?: number; duration?: number; slew?: number; index: number };
const timeUnits: Record<string, number> = { s: 1, ms: 1e-3, us: 1e-6, 'µs': 1e-6, 'μs': 1e-6, ns: 1e-9, ps: 1e-12 };
const currentUnits: Record<string, number> = { A: 1, mA: 1e-3, uA: 1e-6, 'µA': 1e-6, 'μA': 1e-6, nA: 1e-9, kA: 1e3 };
const numberPattern = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const quantityPattern = new RegExp(`^(${numberPattern})\\s*([A-Za-zµμ]+)(?:/([A-Za-zµμ]+))?$`);

function quantity(raw: unknown, kind: 'time' | 'current' | 'slew'): number {
  const match = String(raw).trim().match(quantityPattern);
  if (!match) throw new Error(`Unsupported legacy ${kind} quantity: ${String(raw)}.`);
  const unit = kind === 'time' ? timeUnits[match[2]] : currentUnits[match[2]];
  const denominator = match[3] ? timeUnits[match[3]] : undefined;
  if (unit === undefined || (kind === 'slew' ? denominator === undefined : match[3] !== undefined)) {
    throw new Error(`Unsupported legacy ${kind} unit: ${String(raw)}.`);
  }
  const value = Number(match[1]) * unit / (denominator ?? 1);
  if (!Number.isFinite(value)) throw new Error('A legacy quantity exceeds the finite numeric range.');
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A legacy mapping is required.');
  return value as Record<string, unknown>;
}

// Match Python's .6g representation in the frozen warning messages.
function sixSignificant(value: number): string {
  if (value === 0) return '0';
  const rounded = Number(value.toPrecision(6));
  const exponent = Math.floor(Math.log10(Math.abs(rounded)));
  if (exponent < -4 || exponent >= 6) {
    const [mantissa, power] = rounded.toExponential(5).split('e');
    const compact = mantissa.replace(/\.?0+$/, '');
    return `${compact}e${Number(power) < 0 ? '-' : '+'}${String(Math.abs(Number(power))).padStart(2, '0')}`;
  }
  return String(rounded);
}

export function readLegacyYaml(text: string): LegacyResult {
  const result: LegacyResult = { ok: false, sourceText: text, points: [], warnings: [], diagnostics: [], differences: [] };
  let activePath: (string | number)[] = [];
  try {
    if (new TextEncoder().encode(text).length > 1024 * 1024) throw new Error('Legacy source exceeds 1 MiB.');
    const doc = parseDocument(text, { strict: true, uniqueKeys: true, keepSourceTokens: true });
    if (doc.errors.length) throw new Error(doc.errors.map(error => error.message).join('\n'));
    let nodes = 0;
    visit(doc, (_key, node, path) => {
      if (++nodes > 60000 || path.length > 32) throw new Error('Legacy source exceeds the node or nesting limit.');
      if (isAlias(node) || (node && 'tag' in node && node.tag)) throw new Error('Legacy aliases and explicit tags are not supported.');
    });
    const raw = object(doc.toJS({ maxAliasCount: 0 }));
    if ('schema' in raw || 'version' in raw) throw new Error('This reader requires versionless legacy YAML.');
    if (!Array.isArray(raw.steps) || raw.steps.length > 10000) throw new Error('Legacy steps must be an array of at most 10,000 entries.');
    for (const key of Object.keys(raw)) if (!['name', 'nominal_current', 'slew_rate', 'resolution', 'steps'].includes(key)) {
      throw new Error(`Unsupported legacy field: ${key}.`);
    }
    result.name = typeof raw.name === 'string' ? raw.name : 'Legacy waveform';
    const nominal = raw.nominal_current === undefined ? undefined : quantity(raw.nominal_current, 'current');
    const globalSlew = raw.slew_rate === undefined ? undefined : quantity(raw.slew_rate, 'slew');
    const resolution = raw.resolution === undefined ? undefined : quantity(raw.resolution, 'time');
    if ((globalSlew !== undefined && globalSlew <= 0) || (resolution !== undefined && resolution <= 0)) throw new Error('Legacy slew and resolution must be positive.');
    const amplitude = (value: unknown): number => {
      const token = String(value).trim();
      if (!token.endsWith('%')) return quantity(value, 'current');
      if (nominal === undefined) throw new Error('nominal_current is required to resolve a percentage value.');
      if (!new RegExp(`^${numberPattern}%$`).test(token)) throw new Error(`Unsupported legacy percentage: ${token}.`);
      const answer = Number(token.slice(0, -1)) / 100 * nominal;
      if (!Number.isFinite(answer)) throw new Error('A legacy percentage exceeds the finite numeric range.');
      return answer;
    };
    let declaredTime = 0;
    const steps: Step[] = raw.steps.map((item, index) => {
      activePath = ['steps', index];
      const rawStep = object(item);
      for (const key of Object.keys(rawStep)) if (!['hold', 'for', 't', 'dt', 'value', 'slew_rate'].includes(key)) throw new Error(`Unsupported legacy step field: ${key}.`);
      if ('t' in rawStep && 'dt' in rawStep) throw new Error(`Step ${index}: cannot specify both 't' and 'dt'.`);
      const slew = rawStep.slew_rate === undefined ? undefined : quantity(rawStep.slew_rate, 'slew');
      if (slew !== undefined && slew <= 0) throw new Error('Legacy slew must be positive.');
      if ('hold' in rawStep) return { kind: 'hold', value: amplitude(rawStep.hold), duration: quantity(rawStep.for, 'time'), slew, index };
      if (!('value' in rawStep) || (!('t' in rawStep) && !('dt' in rawStep))) throw new Error(`Step ${index}: a hold or timed value is required.`);
      const token = String(rawStep.t).trim();
      const relative = 'dt' in rawStep || token.startsWith('+');
      const time = quantity('dt' in rawStep ? rawStep.dt : relative ? token.slice(1) : rawStep.t, 'time');
      if (relative && time < 0) throw new Error('A legacy relative time must be nonnegative.');
      declaredTime = relative ? declaredTime + time : time;
      if (!Number.isFinite(declaredTime)) throw new Error('A legacy declared time exceeds the finite numeric range.');
      return { kind: 'absolute', value: amplitude(rawStep.value), t: declaredTime, slew, index };
    });
    let currentTime = 0, previousAmplitude = 0;
    const append = (time: number, value: number, index: number) => {
      if (!Number.isFinite(time) || !Number.isFinite(value)) throw new Error('Legacy breakpoint calculation exceeds the finite numeric range.');
      const last = result.points.at(-1);
      if (last && (Math.abs(last[0] - time) < 1e-15 || time < last[0] - 1e-15)) {
        result.differences.push({ code: 'LEGACY_POINT_DROPPED', message: `The legacy engine drops a point at ${time} s.`, source: { path: ['steps', index] } });
        return;
      }
      result.points.push([time, value]);
    };
    for (const step of steps) {
      activePath = ['steps', step.index];
      const delta = Math.abs(step.value - previousAmplitude);
      const effectiveSlew = step.slew ?? globalSlew;
      const rampTime = delta < 1e-12 ? 0 : effectiveSlew !== undefined ? delta / effectiveSlew : resolution ?? 0;
      if (!Number.isFinite(rampTime)) throw new Error('Legacy ramp calculation exceeds the finite numeric range.');
      if (step.kind === 'hold') {
        if (rampTime > 0) {
          append(currentTime, previousAmplitude, step.index);
          append(currentTime + rampTime, step.value, step.index);
          currentTime += rampTime;
        }
        append(currentTime + step.duration!, step.value, step.index);
        currentTime += step.duration!;
      } else {
        const declared = step.t!;
        let actual = declared;
        if (rampTime > 0) {
          let start = declared - rampTime;
          if (start < currentTime - 1e-15) {
            actual = currentTime + rampTime;
            result.warnings.push(`Step declared at t=${sixSignificant(declared)}s pushed to t=${sixSignificant(actual)}s (slew constraint: ramp needs ${sixSignificant(rampTime)}s)`);
            start = currentTime;
          }
          if (start > currentTime + 1e-15) append(start, previousAmplitude, step.index);
        } else if (declared < currentTime - 1e-15) {
          actual = currentTime + (resolution ?? 0);
          result.warnings.push(`Step declared at t=${sixSignificant(declared)}s pushed to t=${sixSignificant(actual)}s (timestamp conflict, no slew)`);
        }
        append(actual, step.value, step.index);
        currentTime = actual;
      }
      previousAmplitude = step.value;
    }
    activePath = [];
    result.ok = true;
  } catch (error) {
    result.diagnostics.push({ code: 'LEGACY_INPUT', severity: 'error', message: error instanceof Error ? error.message : String(error), source: { path: activePath } });
    result.points = [];
  }
  return result;
}

export function previewLegacyMigration(text: string): MigrationPreview {
  const legacy = readLegacyYaml(text);
  const differences = [...legacy.differences];
  const preview: MigrationPreview = { legacy, differences, shapeEquivalent: false };
  if (!legacy.ok) return preview;
  differences.push({ code: 'SHAPE_ONLY', message: 'The candidate preserves resolved points. Percentage, hold, ramp, and declared-time intent become explicit point values.' });
  differences.push({ code: 'NO_REPEAT_INFERENCE', message: 'The candidate does not infer repetition or add the schematic helper reset edge.' });
  for (const warning of legacy.warnings) differences.push({ code: 'LEGACY_ARRIVAL_MOVED', message: warning });
  if (legacy.points.length < 2 || legacy.points[0][0] < 0) {
    differences.push({ code: 'MIGRATION_UNSUPPORTED', message: 'Migration requires at least two points with a nonnegative first time.' });
    return preview;
  }
  const first = legacy.points[0];
  const segments: unknown[] = [];
  if (first[0] > 0) {
    segments.push({ id: 'legacy-leading-hold', kind: 'hold', duration: `${first[0]} s` });
    differences.push({ code: 'INITIAL_GAP', message: `The candidate holds the first recorded level from 0 to ${first[0]} s. The legacy point list starts later.` });
  }
  segments.push({ id: 'legacy-shape', kind: 'points', points: legacy.points.map(([time, value], index) => ({ id: `legacy-point-${index + 1}`, time: `${time - first[0]} s`, value: `${value} A` })) });
  const document = { schema: 'wavecraft/1', name: legacy.name ?? 'Legacy waveform', signal: { dimension: 'current', initial: `${first[1]} A` }, segments };
  preview.candidate = compileDocument(document);
  if (!preview.candidate.ok) {
    differences.push({ code: 'MIGRATION_UNSUPPORTED', message: 'The strict compiler rejects the shape candidate. Review the candidate diagnostics.' });
    return preview;
  }
  preview.candidateSource = stringify(document);
  const compiled = preview.candidate.compiled;
  const close = (actual: number, expected: number) => Math.abs(actual - expected) <= Math.max(1e-15, 1e-10 * Math.abs(expected));
  const expectedPoints: Point[] = first[0] > 0 ? [[0, first[1]], ...legacy.points] : legacy.points;
  const expanded = expandFinite(compiled);
  const sameEvents = expanded.ok && expanded.points.length === expectedPoints.length && expanded.points.every(([time, value], index) => {
    const expected = expectedPoints[index];
    const timeTolerance = 32 * Number.EPSILON * Math.max(Math.abs(time), Math.abs(expected[0]), Number.MIN_VALUE);
    return Math.abs(time - expected[0]) <= timeTolerance && close(value, expected[1]);
  });
  preview.shapeEquivalent = sameEvents && legacy.points.every(([time, value], index) => {
    if (!close(evaluate(compiled, time), value)) return false;
    if (!index) return true;
    const previous = legacy.points[index - 1];
    return close(evaluate(compiled, previous[0] + (time - previous[0]) / 2), previous[1] + (value - previous[1]) / 2);
  });
  if (!preview.shapeEquivalent) differences.push({ code: 'MIGRATION_SHAPE_MISMATCH', message: 'The candidate does not preserve the legacy event count, corner times, amplitudes, and interval midpoints.' });
  return preview;
}
