import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync } from 'fflate';
import { candidateSource, rawPointsSI } from '../src/digitize/index.ts';
import type { Digitization } from '../src/digitize/index.ts';
import { packProject, readProjectRecovery, unpackProject, writeProjectRecovery } from '../src/project/index.ts';
import type { ProjectSnapshot } from '../src/project/index.ts';
import { projectRecoveryDatabase } from './support/project-recovery-db.ts';

const d = (): Digitization => ({ extraction: { kind: 'csv', name: 'wpd_µ.csv', text: '\uFEFFtime;current\r\n0,0;-2,5\r\n1,0;4,0\r\n2,0;-2,5\r\n', mapping: { dimension: 'current', timeUnit: 'ms', valueUnit: 'A', xColumn: 0, yColumn: 1, delimiter: ';', decimal: ',', header: true, confirmed: true } }, corrections: [{ index: 1, point: [0.001, 3.9], note: 'Use the identified corner.' }], assumptions: 'Linear interpolation. Calibration metadata is unavailable from CSV.', provenance: { article: 'Explicit local source', page: '2', figure: '3', series: 'load' }, view: { zoom: 2, displaySize: [800, 400] } });
const p = (revisionId = 'phase7-fixture'): ProjectSnapshot => { const digitization = d(); return { revisionId, ...candidateSource(digitization), evidence: { digitization } }; };
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const manifest = (zip: Uint8Array) => JSON.parse(new TextDecoder().decode(unzipSync(zip)['manifest.json']));

test('schema 2 round trip retains exact original CSV bytes, mappings, corrections, and provenance', () => {
  const project = p(), before = structuredClone(project), bytes = packProject(project); assert.deepEqual(unpackProject(bytes), before); assert.deepEqual(project, before);
  assert.equal(manifest(bytes).evidenceSchema, 2); assert.deepEqual(rawPointsSI(unpackProject(bytes).evidence.digitization!.extraction), [[0, -2.5], [0.001, 4], [0.002, -2.5]]);
  assert.ok(Object.hasOwn(unzipSync(bytes), 'evidence/digitization.json'));
});
test('immutable Phase 6 point and signed voltage archives still load and re-save with schema 1', () => {
  for (const name of ['full-evidence-point-burst.wavecraft.zip', 'signed-semantic-bom-crlf.wavecraft.zip']) {
    const bytes = readFileSync(new URL(`../../outputs/phase6/fixtures-1794040256586/${name}`, import.meta.url)), restored = unpackProject(bytes);
    assert.equal(restored.evidence.digitization, undefined); const next = packProject(restored); assert.equal(manifest(next).evidenceSchema, 1); assert.deepEqual(unpackProject(next), restored);
  }
});
test('entry/schema mismatches, unknown versions, invalid mapping, and unknown fields fail', () => {
  for (const mutate of [(m: any) => m.evidenceSchema = 1, (m: any) => m.evidenceSchema = 3]) { const files = unzipSync(packProject(p())), m = manifest(packProject(p())); mutate(m); files['manifest.json'] = encode(m); assert.throws(() => unpackProject(zipSync(files)), /schema version/); }
  for (const mutate of [(v: any) => v.version = 2, (v: any) => v.data.extraction.mapping.confirmed = false, (v: any) => v.data.extraction.mapping.unsafe = true, (v: any) => v.data.corrections[0].index = 10]) {
    const files = unzipSync(packProject(p())), v = JSON.parse(new TextDecoder().decode(files['evidence/digitization.json'])); mutate(v); files['evidence/digitization.json'] = encode(v); const m = manifest(packProject(p())); m.entries['evidence/digitization.json'].bytes = files['evidence/digitization.json'].length; files['manifest.json'] = encode(m); assert.throws(() => unpackProject(zipSync(files)));
  }
});
test('native records require original image evidence and preserve all nine allowed entries', () => {
  const legacy = unpackProject(readFileSync(new URL('../../outputs/phase6/fixtures-1794040256586/full-evidence-point-burst.wavecraft.zip', import.meta.url)));
  legacy.evidence.digitization = { extraction: { kind: 'image', size: [4000, 2000], calibration: { dimension: 'current', timeUnit: 'us', valueUnit: 'A', axes: 'linear', rotation: 'axis-aligned', x: [{ pixel: [0, 100], value: 0 }, { pixel: [100, 100], value: 10 }], y: [{ pixel: [0, 100], value: 0 }, { pixel: [0, 0], value: 1 }], tick: { axis: 'x', pixel: [50, 100], value: 5, tolerance: 0.01 } }, pixels: [[0, 100], [100, 0]] }, corrections: [], assumptions: 'Linear fixture.' };
  const bytes = packProject(legacy); assert.equal(Object.keys(unzipSync(bytes)).length, 9); assert.deepEqual(unpackProject(bytes), legacy);
  const mismatched = structuredClone(legacy); if (mismatched.evidence.digitization!.extraction.kind === 'image') mismatched.evidence.digitization!.extraction.size[0] = 3999; assert.throws(() => packProject(mismatched), /original image dimensions/);
  const missing = structuredClone(legacy); missing.evidence.image = undefined; missing.evidence.transforms = undefined; assert.throws(() => packProject(missing), /original image/);
});
test('recovery commits the expanded evidence and text draft atomically and retains the old revision after abort', async () => {
  const { factory, state } = projectRecoveryDatabase(); const draft = { text: 'invalid draft_µ', selection: 'reconstruction' }; await writeProjectRecovery(p('first'), draft, { factory });
  assert.deepEqual((await readProjectRecovery({ factory }))!.snapshot, p('first'));
  state.abortNext = true; const next = p('second'); next.evidence.digitization!.assumptions = 'New assumptions.';
  await assert.rejects(writeProjectRecovery(next, { text: 'new', selection: null }, { factory, expectedHead: 'first' }), /aborted/);
  const restored = await readProjectRecovery({ factory }); assert.deepEqual(restored!.snapshot, p('first')); assert.deepEqual(restored!.draft, draft);
});
