import { SEMANTIC_LIMITS } from './types.ts';
import type { CompiledLeaf, CompiledRepeat, CompiledWaveform, Diagnostic, ExpansionResult, Point } from './types.ts';

function leafValue(leaf: CompiledLeaf, t: number): number {
  const points = leaf.points;
  if (t <= points[0][0]) return points[0][1];
  if (t >= points.at(-1)![0]) return points.at(-1)![1];
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >>> 1; if (points[mid][0] <= t) lo = mid; else hi = mid; }
  const a = points[lo], b = points[hi];
  const f = (t - a[0]) / (b[0] - a[0]);
  return a[1] * (1 - f) + b[1] * f;
}

function repeatValue(node: CompiledRepeat, t: number): number {
  let local = t - node.timing.startS;
  const initial = node.pattern[0].points[0][1];
  if (node.outer) {
    const burst = Math.floor(local / node.outer.periodS);
    if (node.outer.count !== 'continuous' && burst >= node.outer.count) return initial;
    local %= node.outer.periodS;
    if (local >= node.activeSpanS) return initial;
  }
  const iteration = Math.floor(local / node.periodS);
  if (node.count !== 'continuous' && iteration >= node.count) return initial;
  local %= node.periodS;
  if (local >= node.patternDurationS) return initial;
  for (const leaf of node.pattern) if (local <= leaf.timing.endS) return leafValue(leaf, local);
  return initial;
}

export function evaluate(compiled: CompiledWaveform, timeS: number): number {
  if (!Number.isFinite(timeS)) throw new RangeError('Use a finite evaluation time.');
  if (timeS <= 0) return compiled.initialValue;
  if (timeS >= compiled.durationS) return compiled.finalValue;
  for (const node of compiled.nodes) if (timeS <= node.timing.endS) return node.kind === 'repeat' ? repeatValue(node, timeS) : leafValue(node, timeS);
  return compiled.finalValue;
}

export function expandFinite(compiled: CompiledWaveform, options: { horizonS?: number; maxPoints?: number } = {}): ExpansionResult {
  const diagnostics: Diagnostic[] = [];
  const fail = (code: string, message: string): ExpansionResult => ({ ok: false, diagnostics: [{ code, severity: 'error', message, source: { path: [] } }] });
  if (compiled.continuous && options.horizonS === undefined) return fail('HORIZON_REQUIRED', 'Declare a finite horizon to expand continuous repetition.');
  const horizon = options.horizonS ?? compiled.durationS;
  const max = options.maxPoints ?? SEMANTIC_LIMITS.expandedPoints;
  if (!Number.isFinite(horizon) || horizon < 0) return fail('QUANTITY', 'Use a finite nonnegative expansion horizon.');
  if (!Number.isSafeInteger(max) || max < 1 || max > SEMANTIC_LIMITS.expandedPoints) return fail('RESOURCE_LIMIT', 'Use an expansion limit from 1 through 100000 points.');
  const points: Point[] = [];
  let visits = 0;
  const append = (t: number, value: number) => {
    if (++visits > SEMANTIC_LIMITS.expandedPoints * 8) throw new RangeError('RESOURCE_LIMIT');
    if (t > horizon) return;
    if (!Number.isFinite(t) || !Number.isFinite(value)) throw new RangeError('NUMERIC_RANGE');
    const last = points.at(-1);
    if (last && t === last[0]) { if (value !== last[1]) throw new RangeError('NUMERIC_RANGE'); return; }
    if (last && t < last[0]) throw new RangeError('NUMERIC_RANGE');
    if (points.length >= max) throw new RangeError('RESOURCE_LIMIT');
    points.push([t, value]);
  };
  const emitLeaf = (leaf: CompiledLeaf, mapTime: (local: number) => number) => {
    let previous: number | undefined;
    for (const [t, value] of leaf.points) {
      const absolute = mapTime(t);
      if (previous !== undefined && t > leaf.points[0][0] && absolute <= previous) throw new RangeError('NUMERIC_RANGE');
      append(absolute, value); previous = absolute;
    }
  };
  try {
    append(0, compiled.initialValue);
    for (const node of compiled.nodes) {
      if (node.timing.startS > horizon) break;
      if (node.kind !== 'repeat') { emitLeaf(node, t => t); continue; }
      const outerPeriod = node.outer?.periodS;
      const burstCount = node.outer?.count ?? 1;
      for (let burst = 0; burstCount === 'continuous' || burst < burstCount; burst++) {
        const burstOffset = node.timing.startS + (outerPeriod === undefined ? 0 : burst * outerPeriod);
        if (burstOffset > horizon || burstOffset >= node.timing.endS) break;
        for (let iteration = 0; node.count === 'continuous' || iteration < node.count; iteration++) {
          const offset = burstOffset + iteration * node.periodS;
          if (offset > horizon) break;
          if (outerPeriod !== undefined && offset >= burstOffset + outerPeriod) break;
          const mapTime = (local: number) => {
            const tolerance = 32 * Number.EPSILON * Math.max(Math.abs(local), node.periodS, Number.MIN_VALUE);
            const terminal = local >= node.periodS && local - node.periodS <= tolerance;
            const relative = terminal ? (iteration + 1) * node.periodS : iteration * node.periodS + local;
            if (outerPeriod !== undefined && relative >= outerPeriod && relative - outerPeriod <= 32 * Number.EPSILON * Math.max(relative, outerPeriod, Number.MIN_VALUE)) return node.timing.startS + (burst + 1) * outerPeriod;
            return node.timing.startS + (outerPeriod === undefined ? 0 : burst * outerPeriod) + relative;
          };
          for (const leaf of node.pattern) {
            if (leaf.derived && leaf.id === `${node.id}:idle`) continue;
            emitLeaf(leaf, mapTime);
          }
        }
        if (!node.outer) break;
      }
      if (Number.isFinite(node.timing.endS)) append(node.timing.endS, node.pattern[0].points[0][1]);
    }
    // An emitted corner is authoritative. Modulo evaluation can differ by roundoff.
    if (points.at(-1)?.[0] !== horizon) append(horizon, evaluate(compiled, horizon));
    return { ok: true, points, horizonS: horizon, diagnostics };
  } catch (error) {
    const code = error instanceof RangeError ? error.message : 'NUMERIC_RANGE';
    return fail(code, code === 'RESOURCE_LIMIT' ? 'The expansion exceeds its point budget. Reduce the horizon or repetition count.' : 'The expanded events exceed numeric precision.');
  }
}
