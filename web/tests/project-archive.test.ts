import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, zipSync } from 'fflate';
import { packProject, PROJECT_LIMITS, unpackProject } from '../src/project/index.ts';
import type { ProjectSnapshot } from '../src/project/index.ts';
import { samplePngBase64 } from '../src/proof.ts';

export const project: ProjectSnapshot = {
  revisionId: 'fixture-1', mode: 'points',
  source: '\uFEFF{\r\n "version":1,"name":"Signed waveform","units":{"time":"us","current":"A"},"maxSlew":null,"points":[[0,-2],[10,4],[20,-2]],"repetition":{"mode":"burst","periodUs":30,"count":10,"burstPeriodUs":1000}\r\n}\r\n',
  evidence: {
    image: { name: 'source_µ.png', mime: 'image/png', bytes: Uint8Array.from(Buffer.from(samplePngBase64, 'base64')) },
    rawPoints: [[12.4, 31], [45, 20]], calibration: { low: [10, 40], high: [50, 10], x0: 0, x1: 20, y0: -2, y1: 4 },
    corrections: [{ index: 1, point: [46, 20.5], note: 'Estimated corner.' }], notes: 'Datasheet source.\nAssumption: finite rise.',
    transforms: { originalSize: [4000, 2000], viewSize: [2000, 1000], crop: null, reference: 'image' }
  }
};
const clone = () => structuredClone(project);
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const entries = () => unzipSync(packProject(project));
function mutatedManifest(change: (m: any) => void): Uint8Array { const files = entries(); const m = JSON.parse(new TextDecoder().decode(files['manifest.json'])); change(m); files['manifest.json'] = encode(m); return zipSync(files); }
function central(bytes: Uint8Array): number[] { const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const out: number[] = []; for (let i = 0; i < bytes.length - 4; i++) if (d.getUint32(i, true) === 0x02014b50) out.push(i); return out; }

test('product archive preserves exact point JSON BOM/CRLF, burst clocks, original image, and all evidence', () => {
  const before = clone(); const zip = packProject(project); const restored = unpackProject(zip);
  assert.deepEqual(restored, before); assert.deepEqual(project, before);
  assert.deepEqual(new TextEncoder().encode(restored.source), new TextEncoder().encode(project.source));
  assert.equal(Object.keys(unzipSync(zip)).length, 8);
});
test('semantic archive preserves authoring YAML and voltage dimension without image evidence', () => {
  const source = '\uFEFF# Preserve source_µ and percentages.\r\nschema: wavecraft/1\r\nname: voltage\r\nsignal: {dimension: voltage, nominal: 4 V, initial: -1 V}\r\nsegments:\r\n  - {id: rise, kind: ramp, to: 50%, duration: 10 us}\r\n';
  const p: ProjectSnapshot = { revisionId: 'yaml-1', mode: 'semantic', source, evidence: {} };
  assert.deepEqual(unpackProject(packProject(p)), p);
  const m = JSON.parse(new TextDecoder().decode(unzipSync(packProject(p))['manifest.json'])); assert.equal(m.dimension, 'voltage');
});
test('partial calibration and unavailable legacy evidence remain explicit without invented image bytes', () => {
  const p = clone(); delete p.evidence.image; p.evidence.calibration!.high = null; p.evidence.transforms!.reference = 'unavailable';
  assert.deepEqual(unpackProject(packProject(p)), p);
  p.evidence.transforms!.reference = 'image'; assert.throws(() => packProject(p), /original image bytes/);
  p.evidence.transforms!.reference = 'sample'; assert.throws(() => packProject(p), /generated PNG/);
  const sample = clone(); sample.evidence.transforms!.reference = 'sample'; assert.deepEqual(unpackProject(packProject(sample)), sample);
  sample.evidence.transforms!.viewSize = [2001, 1000]; assert.throws(() => packProject(sample), /2000 pixels/);
});
test('archive rejects unsupported schemas, missing declarations, wrong dimension, and size lies', () => {
  for (const change of [(m: any) => m.version = 2, (m: any) => m.sourceSchema = 'future/1', (m: any) => m.evidenceSchema = 2, (m: any) => m.dimension = 'voltage', (m: any) => delete m.entries['waveform.yaml'], (m: any) => m.entries['waveform.yaml'].bytes++]) assert.throws(() => unpackProject(mutatedManifest(change)), /Project import failed/);
});
test('archive rejects traversal, executable paths, missing source, duplicate entry names, and extra image', () => {
  for (const name of ['../waveform.yaml', '/waveform.yaml', 'evidence\\notes.json', 'evidence/script.js', '__proto__.json']) {
    const f = unzipSync(packProject({ ...project, evidence: {} })); Object.defineProperty(f, name, { value: encode({}), enumerable: true }); assert.throws(() => unpackProject(zipSync(f)), /unexpected|count/);
  }
  const missing = entries(); delete missing['waveform.yaml']; assert.throws(() => unpackProject(zipSync(missing)), /requires/);
  const f = entries(); f['evidence/source-image.jpg'] = f['evidence/source-image.png']; assert.throws(() => unpackProject(zipSync(f)), /count/);
  const duplicate = packProject({ ...project, evidence: {} }); const centers = central(duplicate); const d = new DataView(duplicate.buffer, duplicate.byteOffset, duplicate.byteLength);
  // Rename both 13-byte entries to manifest.json. Keep local names consistent.
  const c = centers.find(i => new TextDecoder().decode(duplicate.subarray(i + 46, i + 59)) === 'waveform.yaml')!;
  duplicate.set(new TextEncoder().encode('manifest.json'), c + 46); duplicate.set(new TextEncoder().encode('manifest.json'), d.getUint32(c + 42, true) + 30);
  assert.throws(() => unpackProject(duplicate), /duplicate/);
});
test('metadata bounds reject excessive declared sizes and malformed/truncated ZIP input before decoding', () => {
  for (const n of [0, 1, 21, 30, 100]) assert.throws(() => unpackProject(packProject(project).slice(0, n)));
  assert.throws(() => unpackProject(new Uint8Array(PROJECT_LIMITS.archive + 1)), /16 MiB/);
  const bytes = packProject(project), d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), c = central(bytes)[0]; d.setUint32(c + 24, PROJECT_LIMITS.source + 1, true);
  assert.throws(() => unpackProject(bytes), /declared decoded/);
});
test('CRC and local header validation reject corruption and central/local disagreements', () => {
  const bytes = packProject(project), d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), c = central(bytes)[0], local = d.getUint32(c + 42, true);
  d.setUint32(local + 14, d.getUint32(local + 14, true) ^ 1, true); assert.throws(() => unpackProject(bytes), /local header/);
  const f = entries(), plain = zipSync(f, { level: 0 }), pd = new DataView(plain.buffer, plain.byteOffset, plain.byteLength), pc = central(plain)[0], pl = pd.getUint32(pc + 42, true), start = pl + 30 + pd.getUint16(pl + 26, true) + pd.getUint16(pl + 28, true);
  plain[start] ^= 1; assert.throws(() => unpackProject(plain), /CRC/);
});
test('bounded DEFLATE validation detects expansion despite matching local and central size claims', () => {
  const p = clone(); p.evidence = { notes: 'A'.repeat(60000) }; const bytes = packProject(p), d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const c = central(bytes).find(i => new TextDecoder().decode(bytes.subarray(i + 46, i + 46 + d.getUint16(i + 28, true))) === 'evidence/source-notes.json')!;
  const local = d.getUint32(c + 42, true); d.setUint32(c + 24, 32, true); d.setUint32(local + 22, 32, true);
  assert.throws(() => unpackProject(bytes), /size or CRC|DEFLATE/);
});
test('evidence data rejects unknown fields, invalid finite values, unsafe images, and correction drift', () => {
  const changes = [(p: any) => p.evidence.notes = 'x'.repeat(65537), (p: any) => p.evidence.calibration.x0 = Infinity, (p: any) => p.evidence.rawPoints = [[NaN, 0]], (p: any) => p.evidence.corrections[0].index = 9, (p: any) => p.evidence.image.name = '../source.png', (p: any) => p.evidence.image.mime = 'image/svg+xml', (p: any) => p.evidence.script = 'alert(1)', (p: any) => p.evidence.transforms.crop = [0, 0, 5000, 5]];
  for (const change of changes) { const p = clone(); change(p); assert.throws(() => packProject(p)); }
  const f = entries(); f['evidence/raw-points.json'] = encode({ version: 1, data: [[0, 1]], executable: 'alert(1)' });
  const m = JSON.parse(new TextDecoder().decode(f['manifest.json'])); m.entries['evidence/raw-points.json'].bytes = f['evidence/raw-points.json'].length; f['manifest.json'] = encode(m); assert.throws(() => unpackProject(zipSync(f)), /fields/);
});
test('invalid source never produces a portable committed revision', () => {
  assert.throws(() => packProject({ ...project, source: '{unfinished' }));
  assert.throws(() => packProject({ ...project, mode: 'semantic', source: 'schema: wavecraft/2' }));
  assert.throws(() => packProject({ ...project, revisionId: '../bad' }));
  for (const count of [1, 5001]) {
    const source = JSON.parse(project.source.replace(/^\uFEFF/, '')); source.points = Array.from({ length: count }, (_, i) => [i, 0]); source.repetition = { mode: 'single' };
    assert.throws(() => packProject({ ...project, source: JSON.stringify(source) }), /point JSON/);
  }
  assert.throws(() => unpackProject(mutatedManifest(m => { m.entries = { toString: { bytes: 0 } }; })), /entry/);
});
