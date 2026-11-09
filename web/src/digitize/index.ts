import { stringify } from 'yaml';
import { compileYaml } from '../semantic/index.ts';
import type { Digitization, Extraction, Pair } from './types.ts';
import { checkCalibration, pixelToSI, validateCalibration } from './calibration.ts';
import { parseCsv } from './csv.ts';
import { boundedPixel, DIGITIZE_LIMITS, fail, finite, keys, pair, text } from './validation.ts';
export * from './types.ts';
export { checkCalibration, pixelToSI, siToPixel, originalToView, viewToOriginal, screenToOriginal } from './calibration.ts';
export { parseCsv } from './csv.ts';
export { DIGITIZE_LIMITS } from './validation.ts';

export function rawPointsSI(e: Extraction): Pair[] {
  if (e?.kind === 'csv') { keys(e, ['kind', 'name', 'text', 'mapping']); if (!text(e.name, 255) || !e.name || /[/\\\x00-\x1f]/.test(e.name)) fail('Use a local CSV basename.'); return parseCsv(e.text, e.mapping); }
  keys(e, ['kind', 'size', 'calibration', 'pixels']);
  if (e.kind !== 'image' || !pair(e.size) || e.size.some(n => !Number.isSafeInteger(n) || n <= 0) || !Array.isArray(e.pixels) || e.pixels.length > DIGITIZE_LIMITS.rows) fail('Use an image size and at most 10000 raw image points.');
  validateCalibration(e.calibration);
  for (const axis of ['x', 'y'] as const) for (const a of e.calibration[axis]) boundedPixel(a.pixel, e.size);
  for (const p of e.calibration.originalCorners ?? []) boundedPixel(p, e.size);
  boundedPixel(e.calibration.tick.pixel, e.size);
  for (const p of e.pixels) boundedPixel(p, e.size);
  return e.pixels.map(p => pixelToSI(p, e.calibration));
}
export function validateDigitization(d: Digitization): void {
  keys(d, ['extraction', 'corrections', 'assumptions', 'provenance', 'view', 'initialHoldConfirmed', 'finiteEdgesConfirmed'], ['extraction', 'corrections', 'assumptions']);
  const raw = rawPointsSI(d.extraction);
  if (!text(d.assumptions) || !Array.isArray(d.corrections) || d.corrections.length > DIGITIZE_LIMITS.rows) fail('Use bounded assumption text and point corrections.');
  if ([d.initialHoldConfirmed, d.finiteEdgesConfirmed].some(v => v !== undefined && typeof v !== 'boolean')) fail('Use explicit boolean assumption confirmations.');
  const seen = new Set<number>();
  for (const c of d.corrections) {
    keys(c, ['index', 'point', 'note']);
    if (!Number.isSafeInteger(c.index) || c.index < 0 || c.index >= raw.length || seen.has(c.index) || !pair(c.point) || !text(c.note) || !c.note.trim()) fail('Give each correction an existing point index, a finite SI point, and a reason.'); seen.add(c.index);
  }
  if (d.provenance !== undefined) { keys(d.provenance, ['article', 'page', 'figure', 'series', 'notes'], []); if (!Object.values(d.provenance).every(v => text(v))) fail('Use bounded provenance text.'); }
  if (d.view !== undefined) { keys(d.view, ['zoom', 'displaySize']); if (!finite(d.view.zoom) || d.view.zoom <= 0 || !pair(d.view.displaySize) || d.view.displaySize.some(n => n <= 0)) fail('Use finite positive view dimensions and zoom.'); }
}
export function correctedPointsSI(d: Digitization): Pair[] {
  validateDigitization(d); const points = rawPointsSI(d.extraction); for (const c of d.corrections) points[c.index] = [...c.point]; return points;
}
export function sealExtraction(e: Extraction): Extraction {
  rawPointsSI(e); const copy = structuredClone(e);
  const freeze = (o: any): any => { if (o && typeof o === 'object') { Object.values(o).forEach(freeze); Object.freeze(o); } return o; };
  return freeze(copy);
}
export function candidateSource(d: Digitization): { mode: 'semantic'; source: string } {
  const points = correctedPointsSI(d);
  if (!d.assumptions.trim()) fail('Record the engineering assumptions before you accept the reconstruction.');
  if (d.extraction.kind === 'image' && !checkCalibration(d.extraction.calibration).passed) fail('The unused tick check fails. Correct the calibration before acceptance.');
  if (points.length < 2) fail('Use at least two points for a reconstruction.');
  for (let i = 0; i < points.length; i++) if (points[i][0] < 0 || (i > 0 && points[i][0] <= points[i - 1][0])) fail(`Point ${i + 1} has a duplicate or backward time. Add an explicit correction and finite edge assumption.`);
  const raw = rawPointsSI(d.extraction);
  if (raw.some((p, i) => i > 0 && p[0] <= raw[i - 1][0] && p[1] !== raw[i - 1][1]) && d.finiteEdgesConfirmed !== true) fail('Review and confirm the finite edge durations from the corrected points.');
  if (points[0][0] > 0 && d.initialHoldConfirmed !== true) fail('Move the first point to zero, or confirm the initial hold assumption.');
  const dimension = d.extraction.kind === 'image' ? d.extraction.calibration.dimension : d.extraction.mapping.dimension, unit = dimension === 'current' ? 'A' : 'V';
  const source = stringify({ schema: 'wavecraft/1', name: 'Reconstructed waveform', signal: { dimension, initial: `${points[0][1]} ${unit}` }, segments: [{ id: 'reconstruction', kind: 'points', points: points.map((p, i) => ({ id: `extracted-${i + 1}`, time: `${p[0]} s`, value: `${p[1]} ${unit}` })) }] });
  const compiled = compileYaml(source); if (!compiled.ok) fail(`The reconstruction is invalid. ${compiled.diagnostics.map(d => d.message).join(' ')}`);
  return { mode: 'semantic', source };
}
