import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { compileDocument } from '../../web/src/semantic/index.ts';
import { compilePointProject, exportWaveform } from '../../web/src/export/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const run = path.join(root, 'outputs/phase5/simulators', `adapters-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`);
fs.mkdirSync(run, { recursive: true });
const write = (file, value) => fs.writeFileSync(file, value, { flag: 'wx' });
const ramp = (id, to, duration, unit) => ({ id, kind: 'ramp', to: `${to} ${unit}`, duration: `${duration} s` });
const hold = (id, duration) => ({ id, kind: 'hold', duration: `${duration} s` });
const base = (dimension, segments) => ({ schema: 'wavecraft/1', name: 'Simulator fixture', signal: { dimension, initial: `2 ${dimension === 'current' ? 'A' : 'V'}` }, segments });
const pattern = unit => [ramp('down', -4, .001, unit), hold('negative-hold', .001), ramp('return', 2, .001, unit)];
const cases = [];
for (const dimension of ['current', 'voltage']) {
  const unit = dimension === 'current' ? 'A' : 'V';
  cases.push({ name: `${dimension}-signed-endpoints`, source: base(dimension, [...pattern(unit), ramp('terminal', 3, .001, unit)]), expected: { points: [[0, 2], [.001, -4], [.002, -4], [.003, 2], [.004, 3]] }, stop: .006 });
  for (const count of [3, 'continuous']) cases.push({ name: `${dimension}-repeat-${count}`, source: base(dimension, [{ id: 'repeat', kind: 'repeat', period: '.004 s', count, pattern: pattern(unit) }]), expected: { points: [[0, 2], [.001, -4], [.002, -4], [.003, 2], [.004, 2]], period: .004, count }, stop: .015 });
}
const user = JSON.parse(fs.readFileSync(path.join(root, 'outputs/burst-fix/user-reported-project.json'), 'utf8'));
cases.push({ name: 'user-ten-patterns-outer-0p1s', project: user, expected: { points: user.points.map(([t, y]) => [t * 1e-6, y]), period: .00015, count: 10, outer: .1, outerCount: 'continuous' }, stop: .305 });
cases.push({ name: 'tight-outer-active-span', source: { schema: 'wavecraft/1', name: 'Tight outer fixture', signal: { dimension: 'current', initial: '0 A' }, segments: [{ id: 'burst', kind: 'repeat', period: '1 us', count: 10, outer: { period: '9.5 us', count: 'continuous' }, pattern: [ramp('up', 10, 1e-7, 'A'), hold('top', 2e-7), ramp('back', 0, 1e-7, 'A')] }] }, expected: { points: [[0, 0], [1e-7, 10], [3e-7, 10], [4e-7, 0]], period: 1e-6, count: 10, outer: 9.5e-6, outerCount: 'continuous' }, stop: 3.1e-5 });
cases.push({ name: 'single-initial-anchor', source: base('voltage', []), expected: { points: [[0, 2]] }, stop: .001 });

const manifest = { generatedAt: new Date().toISOString(), exportSourceSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'web/src/export/index.ts'))).digest('hex'), cases: [] };
for (const fixture of cases) {
  const result = fixture.project ? compilePointProject(fixture.project) : compileDocument(fixture.source);
  if (!result.ok) throw new Error(`${fixture.name}: ${JSON.stringify(result.diagnostics)}`);
  const directory = path.join(run, fixture.name); fs.mkdirSync(directory);
  write(path.join(directory, 'authoring.json'), JSON.stringify(fixture.source ?? fixture.project, null, 2));
  const exports = [];
  for (const format of ['pwl', 'pwl-file', 'plecs']) {
    const target = path.join(directory, format); fs.mkdirSync(target);
    const options = { format, name: fixture.name, ...(format === 'plecs' && result.compiled.continuous ? { horizonS: fixture.stop } : {}) };
    const exported = exportWaveform(result.compiled, options);
    if (!exported.ok) throw new Error(`${fixture.name}/${format}: ${JSON.stringify(exported.diagnostics)}`);
    for (const artifact of exported.artifacts) write(path.join(target, artifact.filename), artifact.content);
    write(path.join(target, 'metadata.json'), JSON.stringify(exported.metadata, null, 2));
    exports.push({ format, directory: target, artifacts: exported.artifacts.map(({ filename, role }) => ({ filename, role })), metadata: exported.metadata });
  }
  manifest.cases.push({ name: fixture.name, expected: fixture.expected, stop: fixture.stop, dimension: result.compiled.dimension, exports });
}
write(path.join(run, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(run);
