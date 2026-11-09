import { parseQuantity, QuantityError, resolveLevel } from './units.ts';
import { SEMANTIC_LIMITS } from './types.ts';
import type { AuthoringDocument, CompileResult, CompiledLeaf, CompiledRepeat, CompiledWaveform, Count, Diagnostic, SourcePath, SourceRef } from './types.ts';

type RecordValue = Record<string, unknown>;
type Link = (path: SourcePath, id?: string) => SourceRef;
class CompileFailure extends Error {
  diagnostic: Diagnostic;
  constructor(diagnostic: Diagnostic) { super(diagnostic.message); this.diagnostic = diagnostic; }
}
const roundoff = (a: number, b: number) => 32 * Number.EPSILON * Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE);
export const sameLevel = (a: number, b: number) => Math.abs(a - b) <= roundoff(a, b);

export function compileDocument(input: unknown): CompileResult { return compileWithSource(input); }

export function compileWithSource(input: unknown, link: Link = (path, id) => ({ path: [...path], ...(id ? { id } : {}) })): CompileResult {
  let budget = 0;
  const ids = new Set<string>();
  const fail = (code: string, message: string, path: SourcePath, id?: string, values?: Diagnostic['values']): never => {
    throw new CompileFailure({ code, severity: 'error', message, source: link(path, id), ...(values ? { values } : {}), suggestion: 'Correct the indicated source field and apply the document again.' });
  };
  const record = (raw: unknown, keys: string[], path: SourcePath, id?: string): RecordValue => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) fail('SCHEMA', 'Use a mapping for this field.', path, id);
    for (const key of Object.keys(raw)) if (!keys.includes(key)) fail('SCHEMA', `The field "${key}" is not supported.`, [...path, key], id);
    return raw as RecordValue;
  };
  const list = (raw: unknown, path: SourcePath, id?: string): unknown[] => {
    if (!Array.isArray(raw)) fail('SCHEMA', 'Use a sequence for this field.', path, id);
    if (raw.length > SEMANTIC_LIMITS.authoredItems) fail('RESOURCE_LIMIT', 'The sequence exceeds the authored item limit.', path, id);
    return raw;
  };
  const identity = (raw: unknown, path: SourcePath): string => {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 256) fail('SCHEMA', 'Use a nonempty ID of at most 256 characters.', path);
    if (ids.has(raw)) fail('DUPLICATE_ID', 'Each segment and point must have a unique ID.', path, raw);
    ids.add(raw);
    if (++budget > SEMANTIC_LIMITS.authoredItems) fail('RESOURCE_LIMIT', 'The document exceeds 10000 authored items.', path, raw);
    return raw;
  };
  const quantity = (raw: unknown, kind: Parameters<typeof parseQuantity>[1], path: SourcePath, id?: string, positive = false): number => {
    try {
      const n = parseQuantity(raw, kind);
      if (positive && n <= 0) fail('QUANTITY', 'Use a finite positive quantity.', path, id);
      return n;
    } catch (error) {
      if (error instanceof QuantityError) fail(error.code, error.message, path, id);
      throw error;
    }
  };
  const sumTime = (start: number, delta: number, path: SourcePath, id: string): number => {
    const end = start + delta;
    if (!Number.isFinite(end) || (delta > 0 && end <= start)) fail('NUMERIC_RANGE', 'The time increment exceeds numeric precision or range.', path, id);
    return end;
  };
  const count = (raw: unknown, path: SourcePath, id: string): Count => {
    if (raw === 'continuous') return raw;
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) fail('SCHEMA', 'Use a positive safe integer count or continuous.', path, id);
    return raw;
  };
  const clock = (raw: RecordValue, path: SourcePath, id: string) => {
    if ((raw.period !== undefined) === (raw.frequency !== undefined)) fail('SCHEMA', 'Declare exactly one period or frequency.', path, id);
    const hasPeriod = raw.period !== undefined;
    const n = quantity(hasPeriod ? raw.period : raw.frequency, hasPeriod ? 'time' : 'frequency', [...path, hasPeriod ? 'period' : 'frequency'], id, true);
    const reciprocal = 1 / n;
    if (!Number.isFinite(reciprocal) || reciprocal <= 0) fail('NUMERIC_RANGE', 'The reciprocal clock value exceeds the numeric range.', path, id);
    return { periodS: hasPeriod ? n : reciprocal, frequencyHz: hasPeriod ? reciprocal : n };
  };
  try {
    const doc = record(input, ['schema', 'name', 'signal', 'segments'], []);
    if (doc.schema !== 'wavecraft/1') fail('SCHEMA', 'Declare schema: wavecraft/1. Use the separate reader for legacy input.', ['schema']);
    if (typeof doc.name !== 'string' || !doc.name.trim() || doc.name.length > 1024) fail('SCHEMA', 'Use a nonempty waveform name of at most 1024 characters.', ['name']);
    const signal = record(doc.signal, ['dimension', 'nominal', 'initial'], ['signal']);
    if (signal.dimension !== 'current' && signal.dimension !== 'voltage') fail('SCHEMA', 'Select the current or voltage dimension.', ['signal', 'dimension']);
    const dimension = signal.dimension as 'current' | 'voltage';
    const nominal = signal.nominal === undefined ? undefined : quantity(signal.nominal, dimension, ['signal', 'nominal']);
    const level = (raw: unknown, path: SourcePath, id?: string): number => {
      try { return resolveLevel(raw, dimension, nominal); }
      catch (error) { if (error instanceof QuantityError) fail(error.code, error.message, path, id); throw error; }
    };
    const initialValue = level(signal.initial, ['signal', 'initial']);
    const leaves = (raws: unknown[], start: number, incoming: number, path: SourcePath, allowRepeat: boolean): { nodes: (CompiledLeaf | CompiledRepeat)[]; end: number; value: number } => {
      const nodes: (CompiledLeaf | CompiledRepeat)[] = [];
      let t = start, value = incoming, previousId: string | undefined;
      for (let i = 0; i < raws.length; i++) {
        const p = [...path, i];
        const candidate = raws[i] as { id?: unknown } | null;
        const candidateId = candidate && typeof candidate.id === 'string' ? candidate.id : undefined;
        const untyped = record(raws[i], ['id', 'kind', 'duration', 'to', 'slew', 'maxSlew', 'arriveAt', 'points', 'pattern', 'count', 'period', 'frequency', 'outer'], p, candidateId);
        const id = identity(untyped.id, [...p, 'id']);
        if (!Number.isFinite(t)) fail('SCHEMA', 'A continuous repeat must be the final segment.', p, id);
        const kind = untyped.kind;
        const keys = kind === 'hold' ? ['id', 'kind', 'duration'] : kind === 'ramp' ? ['id', 'kind', 'to', 'duration', 'slew', 'maxSlew', 'arriveAt'] : kind === 'points' ? ['id', 'kind', 'points'] : kind === 'repeat' ? ['id', 'kind', 'pattern', 'count', 'period', 'frequency', 'outer'] : [];
        if (!keys.length || (kind === 'repeat' && !allowRepeat)) fail('SCHEMA', 'Use a supported segment kind. Nested repeats are not supported.', [...p, 'kind'], id);
        const s = record(raws[i], keys, p, id);
        const source = link(p, id);
        const timing = (a: number, b: number) => ({ startS: a, endS: b, durationS: b - a, ...(previousId ? { previousId } : {}) });
        if (kind === 'repeat') {
          const c = count(s.count, [...p, 'count'], id);
          const clk = clock(s, p, id);
          const patternRaw = list(s.pattern, [...p, 'pattern'], id);
          if (!patternRaw.length) fail('SCHEMA', 'Declare at least one pattern segment.', [...p, 'pattern'], id);
          const patternResult = leaves(patternRaw, 0, value, [...p, 'pattern'], false);
          const pattern = patternResult.nodes as CompiledLeaf[];
          const duration = patternResult.end;
          if (!sameLevel(patternResult.value, value)) fail('REPEAT_CLOSURE', 'Add an explicit return to the pattern initial level.', [...p, 'pattern'], id, { initial: value, final: patternResult.value });
          if (patternResult.value !== value) {
            let finished = false;
            for (let k = pattern.length - 1; k >= 0 && !finished; k--) {
              const leaf = pattern[k];
              for (let j = leaf.points.length - 1; j >= 0; j--) {
                if (leaf.points[j][1] !== patternResult.value) { finished = true; break; }
                leaf.points[j][1] = value;
                leaf.roundoffCanonicalized = true;
              }
            }
          }
          if (duration > clk.periodS + roundoff(duration, clk.periodS)) fail('REPEAT_FIT', 'The pattern exceeds the inner period.', p, id, { patternDurationS: duration, periodS: clk.periodS });
          if (duration < clk.periodS) pattern.push({ kind: 'idle', id: `${id}:idle`, source, derived: true, timing: { startS: duration, endS: clk.periodS, durationS: clk.periodS - duration }, points: [[duration, value], [clk.periodS, value]] });
          const lastInnerStart = c === 'continuous' ? 0 : (c - 1) * clk.periodS;
          const activeSpanS = c === 'continuous' ? Infinity : sumTime(lastInnerStart, duration, p, id);
          let occupied = c === 'continuous' ? Infinity : c * clk.periodS;
          if (c !== 'continuous' && !Number.isFinite(occupied)) fail('NUMERIC_RANGE', 'The finite repeat span exceeds the numeric range.', p, id);
          let outer: CompiledRepeat['outer'];
          let lastOuterStart = 0;
          if (s.outer !== undefined) {
            if (c === 'continuous') fail('SCHEMA', 'Use a finite inner count for an outer repetition clock.', [...p, 'count'], id);
            const o = record(s.outer, ['period', 'frequency', 'count'], [...p, 'outer'], id);
            const oc = count(o.count, [...p, 'outer', 'count'], id);
            const oclk = clock(o, [...p, 'outer'], id);
            if (activeSpanS > oclk.periodS + roundoff(activeSpanS, oclk.periodS)) fail('REPEAT_FIT', 'The complete burst exceeds the outer period.', [...p, 'outer'], id, { activeSpanS, periodS: oclk.periodS });
            outer = { ...oclk, count: oc };
            lastOuterStart = oc === 'continuous' ? 0 : (oc - 1) * oclk.periodS;
            sumTime(lastOuterStart, activeSpanS, [...p, 'outer'], id);
            occupied = oc === 'continuous' ? Infinity : oc * oclk.periodS;
            if (oc !== 'continuous' && !Number.isFinite(occupied)) fail('NUMERIC_RANGE', 'The finite outer span exceeds the numeric range.', [...p, 'outer'], id);
          }
          if ((c !== 'continuous' && !Number.isFinite(activeSpanS)) || (occupied !== Infinity && (!Number.isFinite(occupied) || occupied <= 0))) fail('NUMERIC_RANGE', 'The repeat span exceeds the finite numeric range.', p, id);
          const lastBurstStart = sumTime(t, lastOuterStart, p, id);
          const lastPatternStart = sumTime(lastBurstStart, lastInnerStart, p, id);
          let lastLocal = -1, lastAbsolute = -1;
          for (const leaf of pattern) for (const point of leaf.points) {
            if (leaf.derived && leaf.id === `${id}:idle`) continue;
            const absolute = sumTime(lastPatternStart, point[0], p, id);
            if (point[0] > lastLocal && absolute <= lastAbsolute) fail('NUMERIC_RANGE', 'A repeated event exceeds numeric time precision.', p, id);
            lastLocal = point[0]; lastAbsolute = absolute;
          }
          const end = occupied === Infinity ? Infinity : sumTime(t, occupied, p, id);
          nodes.push({ kind: 'repeat', id, source, timing: timing(t, end), pattern, patternDurationS: duration, ...clk, count: c, activeSpanS, ...(outer ? { outer } : {}) });
          t = end;
        } else if (kind === 'points') {
          const rawPoints = list(s.points, [...p, 'points'], id);
          if (rawPoints.length < 1) fail('SCHEMA', 'Declare at least one point after time zero.', [...p, 'points'], id);
          const points: [number, number][] = [];
          const pointSources: SourceRef[] = [];
          let lastOffset = -1;
          for (let j = 0; j < rawPoints.length; j++) {
            const pp = [...p, 'points', j];
            const point = record(rawPoints[j], ['id', 'time', 'value'], pp, id);
            const pid = identity(point.id, [...pp, 'id']);
            const offset = quantity(point.time, 'time', [...pp, 'time'], pid);
            const v = level(point.value, [...pp, 'value'], pid);
            if (offset < 0 || (j > 0 && offset <= lastOffset)) fail('POINT_ORDER', 'Use nonnegative point times in strictly increasing order.', [...pp, 'time'], pid);
            if (j === 0 && offset === 0 && !sameLevel(v, value)) fail('POINT_INITIAL', 'A point at time zero must equal the incoming level.', [...pp, 'value'], pid);
            if (j === 0 && offset > 0) { points.push([t, value]); pointSources.push(source); }
            const absolute = offset === 0 ? t : sumTime(t, offset, [...pp, 'time'], pid);
            if (points.length > 0 && absolute <= points.at(-1)![0]) fail('NUMERIC_RANGE', 'The point time increment exceeds numeric precision.', [...pp, 'time'], pid);
            points.push([absolute, j === 0 && offset === 0 ? value : v]); pointSources.push(link(pp, pid)); lastOffset = offset;
          }
          const end = points.at(-1)![0];
          if (end <= t) fail('POINT_ORDER', 'Declare at least one point after time zero.', [...p, 'points'], id);
          nodes.push({ kind: 'points', id, source, timing: timing(t, end), points, pointSources });
          t = end; value = points.at(-1)![1];
        } else {
          let duration: number;
          let target = value;
          let slew: number | undefined;
          if (kind === 'hold') duration = quantity(s.duration, 'time', [...p, 'duration'], id, true);
          else {
            if ((s.duration !== undefined) === (s.slew !== undefined)) fail('SCHEMA', 'Declare exactly one ramp duration or slew.', p, id);
            target = level(s.to, [...p, 'to'], id);
            const delta = Math.abs(target - value);
            if (!Number.isFinite(delta)) fail('NUMERIC_RANGE', 'The amplitude change exceeds the numeric range.', [...p, 'to'], id);
            if (s.duration !== undefined) { duration = quantity(s.duration, 'time', [...p, 'duration'], id, true); slew = delta / duration; }
            else { slew = quantity(s.slew, `${dimension}Slew`, [...p, 'slew'], id, true); duration = delta / slew; }
            if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(slew) || (delta > 0 && slew === 0)) fail('NUMERIC_RANGE', 'Use a finite positive ramp duration and representable slew. Use a hold for zero slew changes.', p, id);
            if (s.maxSlew !== undefined) {
              const limit = quantity(s.maxSlew, `${dimension}Slew`, [...p, 'maxSlew'], id, true);
              if (slew > limit + roundoff(slew, limit)) fail('SLEW_LIMIT', 'The ramp exceeds its declared slew limit.', [...p, 'maxSlew'], id, { resolvedSlew: slew, maxSlew: limit });
            }
          }
          let rampStart = t;
          let arrival: number | undefined;
          if (s.arriveAt !== undefined) {
            arrival = quantity(s.arriveAt, 'time', [...p, 'arriveAt'], id);
            if (arrival < 0) fail('QUANTITY', 'Use a nonnegative absolute arrival time.', [...p, 'arriveAt'], id);
            rampStart = arrival - duration;
            if (rampStart < t) fail('ANCHOR_CONFLICT', 'The anchored ramp starts before the previous segment ends.', [...p, 'arriveAt'], id, { requestedArrivalS: arrival, previousEndS: t, rampDurationS: duration });
            if (rampStart > t) nodes.push({ kind: 'idle', id: `${id}:idle`, source, derived: true, timing: timing(t, rampStart), points: [[t, value], [rampStart, value]] });
          }
          const end = arrival ?? sumTime(rampStart, duration, p, id);
          if (end <= rampStart || !Number.isFinite(end)) fail('NUMERIC_RANGE', 'The ramp duration exceeds numeric precision.', p, id);
          nodes.push({ kind: kind as 'hold' | 'ramp', id, source, timing: { ...timing(rampStart, end), ...(arrival !== undefined ? { requestedArrivalS: arrival } : {}) }, points: [[rampStart, value], [end, target]], ...(slew !== undefined ? { resolvedSlew: slew } : {}) });
          t = end; value = target;
        }
        previousId = id;
      }
      return { nodes, end: t, value };
    };
    const result = leaves(list(doc.segments, ['segments']), 0, initialValue, ['segments'], true);
    const compiled: CompiledWaveform = { dimension, initialValue, finalValue: result.value, durationS: result.end, continuous: result.end === Infinity, nodes: result.nodes };
    return { ok: true, document: JSON.parse(JSON.stringify(input)) as AuthoringDocument, compiled, diagnostics: [] };
  } catch (error) {
    if (error instanceof CompileFailure) return { ok: false, diagnostics: [error.diagnostic] };
    return { ok: false, diagnostics: [{ code: 'SCHEMA', severity: 'error', message: 'The document cannot be read as a finite authoring mapping.', source: link([]) }] };
  }
}
