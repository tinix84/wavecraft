import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { unzipSync, zipSync } from 'fflate';
import { comparePayload, copyPayload, imageMime, inspectYaml, invertPoint, LIMITS, packProof, samplePngBase64, sampleYaml, unpackProof, validateMatrix } from '../src/proof.ts';
import type { ProofPayload } from '../src/proof.ts';

// Node runner: https://nodejs.org/docs/latest-v24.x/api/test.html
const utf8 = new TextEncoder();
const image = { name: 'pixel.png', mime: 'image/png', bytes: new Uint8Array(Buffer.from(samplePngBase64, 'base64')) };
const fixture: ProofPayload = { yamlName: 'BOM_CRLF_µ.yaml', yaml: new Uint8Array(Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(sampleYaml)])), image };

test('ZIP preserves BOM, CRLF, UTF-8 names, and binary image bytes without mutating inputs', () => {
  const before = copyPayload(fixture);
  const zipped = packProof(fixture);
  const restored = unpackProof(zipped);
  assert.deepEqual(comparePayload(before, restored), { yamlBytes: true, imageBytes: true, namesAndTypes: true });
  assert.deepEqual(comparePayload(before, fixture), { yamlBytes: true, imageBytes: true, namesAndTypes: true });
  assert.deepEqual([...restored.yaml.slice(0, 3)], [239, 187, 191]);
  assert.ok(Buffer.from(restored.yaml).includes(Buffer.from('\r\n')));
  assert.equal(imageMime(restored.image!.bytes), 'image/png');
  restored.yaml[0] = 0;
  restored.image!.bytes[0] = 0;
  assert.equal(fixture.yaml[0], 239);
  assert.equal(fixture.image!.bytes[0], 137);
});

test('selected repository YAML fixtures survive ZIP without byte changes', async () => {
  for (const name of ['../examples/nvidia_pulse.yaml', '../examples/relative_pulse.yaml', '../tests/fixture_basic.yaml']) {
    const bytes = new Uint8Array(await readFile(new URL(`../${name}`, import.meta.url)));
    const payload = { yamlName: name.split('/').at(-1)!, yaml: bytes, image };
    assert.deepEqual(comparePayload(payload, unpackProof(packProof(payload))), { yamlBytes: true, imageBytes: true, namesAndTypes: true });
  }
});

test('syntax errors remain errors and invalid source bytes remain portable', () => {
  const bytes = utf8.encode('name: [unfinished\r\n');
  const before = bytes.slice();
  assert.ok(inspectYaml(bytes).errors.length > 0);
  const payload = { yamlName: 'invalid.yaml', yaml: bytes };
  assert.deepEqual(unpackProof(packProof(payload)).yaml, before);
  assert.deepEqual(bytes, before);
  assert.ok(inspectYaml(utf8.encode('name: first\nname: second\n')).errors.length > 0);
  const valid = inspectYaml(fixture.yaml);
  assert.equal(valid.errors.length, 0);
  assert.equal(valid.name, 'portability_proof');
  assert.throws(() => inspectYaml(new Uint8Array([255])), /encoded data|encoding/i);
});

test('ZIP rejects unsupported manifests, missing entries, unexpected paths, and size lies', () => {
  const entries = unzipSync(packProof(fixture));
  const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
  assert.throws(() => unpackProof(new Uint8Array([1, 2, 3])), /zip|invalid/i);
  assert.throws(() => unpackProof(zipSync({ 'source.yaml': fixture.yaml })), /requires/);
  assert.throws(() => unpackProof(zipSync({ ...entries, '../outside.txt': utf8.encode('x') })), /not allowed/);
  assert.throws(() => unpackProof(zipSync({ ...entries, 'manifest.json': utf8.encode(JSON.stringify({ ...manifest, version: 2 })) })), /version/);
  assert.throws(() => unpackProof(zipSync({ ...entries, 'manifest.json': utf8.encode(JSON.stringify({ ...manifest, image: null })) })), /image entry/);
  assert.throws(() => unpackProof(zipSync({ ...entries, 'manifest.json': utf8.encode(JSON.stringify({ ...manifest, yaml: { ...manifest.yaml, bytes: 1 } })) })), /YAML size/);
  assert.throws(() => unpackProof(zipSync({ ...entries, 'manifest.json': utf8.encode('{') })), /JSON|property|position/i);
  assert.throws(() => unpackProof(zipSync({ ...entries, 'source.yaml': new Uint8Array(LIMITS.yaml + 1) })), /exceeds/);
  assert.throws(() => unpackProof(new Uint8Array(LIMITS.archive + 1)), /6 MiB/);
});

test('ZIP metadata first pass rejects duplicate entries before extraction', () => {
  const entries = unzipSync(packProof(fixture));
  const zip = zipSync({ ...entries, 'source.yamx': fixture.yaml }, { level: 0 });
  // Change the equal-length name in both headers to create a duplicate entry.
  const needle = Buffer.from('source.yamx');
  for (let i = 0; i <= zip.length - needle.length; i++) {
    if (needle.every((value, j) => zip[i + j] === value)) zip[i + needle.length - 1] = 'l'.charCodeAt(0);
  }
  assert.throws(() => unpackProof(zip), /occurs twice/);
});

test('evidence validation rejects remote-capable SVG and declared image type mismatches', () => {
  assert.throws(() => imageMime(utf8.encode('<svg><image href="https://invalid.example/image"/></svg>')), /signature/);
  assert.throws(() => packProof({ ...fixture, image: { ...image, mime: 'image/jpeg' } }), /does not match/);
  assert.throws(() => packProof({ ...fixture, yaml: new Uint8Array(LIMITS.yaml + 1) }), /1 MiB/);
});

test('pointer inverse matches independently specified translation, scaling, rotation, and shear cases', () => {
  const cases = [
    { matrix: { a: 2, b: 0, c: 0, d: 3, e: 100, f: -20 }, screen: [500, 340], expected: [200, 120] },
    { matrix: { a: 0, b: 2, c: -2, d: 0, e: 500, f: 10 }, screen: [260, 410], expected: [200, 120] },
    { matrix: { a: 1, b: 0.5, c: 0.25, d: 1, e: 10, f: 20 }, screen: [240, 240], expected: [200, 120] },
    { matrix: { a: 0.5, b: 0, c: 0, d: 0.5, e: 200, f: 100 }, screen: [300, 160], expected: [200, 120] }
  ];
  for (const { matrix, screen, expected } of cases) {
    const actual = invertPoint(matrix, screen[0], screen[1]);
    assert.ok(Math.abs(actual.x - expected[0]) < 1e-10);
    assert.ok(Math.abs(actual.y - expected[1]) < 1e-10);
  }
  assert.throws(() => validateMatrix({ a: 1, b: 2, c: 2, d: 4, e: 0, f: 0 }), /invertible/);
  assert.throws(() => validateMatrix({ a: Infinity, b: 0, c: 0, d: 1, e: 0, f: 0 }), /finite/);
  assert.throws(() => invertPoint(cases[0].matrix, NaN, 1), /not finite/);
});
