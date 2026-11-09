import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compileYaml } from '../src/semantic/index.ts';
import { previewLegacyMigration, readLegacyYaml } from '../src/semantic/legacy.ts';

const root = new URL('../../', import.meta.url);
const corpusBytes = await readFile(new URL('tests/fixtures/legacy/corpus.json', root));
const corpus = JSON.parse(corpusBytes.toString());
const near = (actual: number, expected: number) => assert.ok(
  Math.abs(actual - expected) <= Math.max(1e-18, Math.abs(expected) * 1e-10), `${actual} differs from ${expected}`,
);

for (const expected of corpus.cases) {
  test(`legacy reader reproduces frozen ${expected.input}`, async () => {
    const text = await readFile(new URL(expected.input, root), 'utf8');
    const actual = readLegacyYaml(text);
    assert.equal(actual.ok, true, JSON.stringify(actual.diagnostics));
    assert.equal(actual.sourceText, text);
    assert.equal(actual.points.length, expected.breakpoints.length);
    actual.points.forEach((point, index) => {
      near(point[0], expected.breakpoints[index][0]);
      near(point[1], expected.breakpoints[index][1]);
    });
    assert.deepEqual(actual.warnings, expected.warnings.map(item => item.message));
  });
}

test('migration previews all frozen shapes without changing the legacy source or oracle', async () => {
  for (const expected of corpus.cases) {
    const source = await readFile(new URL(expected.input, root), 'utf8');
    const preview = previewLegacyMigration(source);
    assert.equal(preview.legacy.sourceText, source);
    assert.equal(preview.candidate?.ok, true, `${expected.input}: ${JSON.stringify(preview)}`);
    assert.equal(preview.shapeEquivalent, true, expected.input);
    assert.ok(preview.candidateSource);
    assert.equal(compileYaml(preview.candidateSource).ok, true);
    assert.ok(preview.differences.some(item => item.code === 'SHAPE_ONLY'));
    assert.ok(preview.differences.some(item => item.code === 'NO_REPEAT_INFERENCE'));
    assert.equal(await readFile(new URL(expected.input, root), 'utf8'), source);
  }
  assert.deepEqual(await readFile(new URL('tests/fixtures/legacy/corpus.json', root)), corpusBytes);
});

test('migration reports legacy dropped points, moved arrivals, and initial gaps', async () => {
  const fixture = async (name: string) => previewLegacyMigration(await readFile(new URL(`tests/fixtures/legacy/inputs/cases/${name}.yaml`, root), 'utf8'));
  assert.ok((await fixture('duplicate_backward_drop')).differences.some(item => item.code === 'LEGACY_POINT_DROPPED'));
  assert.ok((await fixture('slew_conflict_no_cascade')).differences.some(item => item.code === 'LEGACY_ARRIVAL_MOVED'));
  const gap = await fixture('schematic_repeat_reset');
  assert.ok(gap.differences.some(item => item.code === 'INITIAL_GAP'));
  assert.equal(gap.legacy.points.length, 2);
  assert.doesNotMatch(gap.candidateSource!, /kind: repeat|0\.000011/);
});

test('legacy schema identity stays separate from semantic YAML and prototype JSON', () => {
  for (const source of [
    'schema: wavecraft/1\nsteps: []',
    'schema: null\nsteps: []',
    'version: 1\nsteps: []',
    '{"version":1,"points":[[0,0],[1,1]]}',
  ]) assert.equal(readLegacyYaml(source).ok, false);
  const legacy = 'name: legacy\nsteps:\n  - {t: 0s, value: 0A}\n  - {t: 1s, value: 1A}\n';
  assert.equal(readLegacyYaml(legacy).ok, true);
  assert.equal(compileYaml(legacy).ok, false);
});

test('legacy reader rejects unsupported units, unsafe YAML, invalid input, and resource excess', () => {
  for (const source of [
    'steps: [{t: 0s, value: 1ohm}]',
    'steps: [{t: 0s, value: 10%}]',
    'slew_rate: 0A/us\nsteps: []',
    'resolution: -1us\nsteps: []',
    'steps: [{dt: -1s, value: 0A}]',
    'steps: [{t: 1s, dt: 1s, value: 0A}]',
    'steps: [{t: 1s, value: 1e309A}]',
    'steps: [{t: 1s, value: 1A, mystery: true}]',
    'steps: []\nunknown: 1',
    'steps: &anchor []\nname: *anchor',
    'steps: !!seq []',
    'steps: []\nsteps: []',
    'steps: [',
    'steps: []\nname: ' + 'x'.repeat(1024 * 1024),
    'steps:\n' + '  - {hold: 0A, for: 1s}\n'.repeat(10001),
  ]) {
    const result = readLegacyYaml(source);
    assert.equal(result.ok, false, source.slice(0, 150));
    assert.deepEqual(result.points, []);
    assert.equal(result.sourceText, source);
    assert.equal(result.diagnostics[0].severity, 'error');
  }
});

test('migration refuses insufficient or negative-start shapes without inventing transitions', () => {
  for (const text of ['steps: []', 'steps: [{t: 0s, value: 1A}]', 'steps: [{hold: 0A, for: -1s}, {t: 1s, value: 1A}]']) {
    const preview = previewLegacyMigration(text);
    assert.equal(preview.candidateSource, undefined);
    assert.equal(preview.shapeEquivalent, false);
    assert.ok(preview.differences.some(item => item.code === 'MIGRATION_UNSUPPORTED'));
  }
});
