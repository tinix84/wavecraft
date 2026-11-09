import test from 'node:test';
import assert from 'node:assert/strict';
import { packProject, PROJECT_RECOVERY_DB, readProjectRecovery, unpackProject, writeProjectRecovery } from '../src/project/index.ts';
import type { ProjectSnapshot } from '../src/project/index.ts';

const snapshot = (revisionId: string): ProjectSnapshot => ({ revisionId, mode: 'points', source: '{"version":1,"name":"Recovery","units":{"time":"us","current":"A"},"points":[[0,0],[1,1]]}', evidence: {} });
const draft = { text: '{ invalid draft_µ\r\n', selection: 1 };
const tick = () => new Promise(resolve => setImmediate(resolve));

import { projectRecoveryDatabase as database } from './support/project-recovery-db.ts';

test('recovery stores complete archive and invalid draft atomically in the separate product database', async () => {
  const { state, factory } = database();
  const result = await writeProjectRecovery(snapshot('one'), draft, { factory, expectedHead: null });
  assert.deepEqual(result.snapshot, snapshot('one')); assert.deepEqual(result.draft, draft);
  assert.deepEqual(await readProjectRecovery({ factory }), result);
  assert.deepEqual(state.opened, [[PROJECT_RECOVERY_DB, 1], [PROJECT_RECOVERY_DB, 1]]);
  assert.notEqual(PROJECT_RECOVERY_DB, 'wavecraft-phase1-proof'); assert.equal(state.closed, 2);
});
test('put request success does not resolve the save or publish a partial revision', async () => {
  const { state, factory } = database(); state.paused = true;
  let resolved = false;
  const pending = writeProjectRecovery(snapshot('one'), draft, { factory }).then(v => { resolved = true; return v; });
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(state.requestSuccess, 1); assert.equal(resolved, false); assert.equal(state.stored, undefined);
  state.complete(); await pending; assert.equal(resolved, true);
});
test('an abort after request success preserves the earlier complete source, evidence, and draft', async () => {
  const { state, factory } = database(); await writeProjectRecovery(snapshot('one'), draft, { factory });
  state.abortNext = true;
  await assert.rejects(writeProjectRecovery({ ...snapshot('two'), evidence: { notes: 'new notes' } }, { text: 'new draft', selection: null }, { factory, expectedHead: 'one' }), /aborted/);
  const restored = await readProjectRecovery({ factory }); assert.equal(restored!.snapshot.revisionId, 'one'); assert.deepEqual(restored!.draft, draft); assert.deepEqual(restored!.snapshot.evidence, {});
});
test('simultaneous tabs compare and replace the recovery head in one serialized transaction', async () => {
  const { state, factory } = database(); await writeProjectRecovery(snapshot('one'), draft, { factory });
  const writes = await Promise.allSettled([
    writeProjectRecovery(snapshot('two'), draft, { factory, expectedHead: 'one' }),
    writeProjectRecovery(snapshot('three'), { text: 'other tab', selection: null }, { factory, expectedHead: 'one' })
  ]);
  assert.equal(writes[0].status, 'fulfilled'); assert.equal(writes[1].status, 'rejected');
  assert.match((writes[1] as PromiseRejectedResult).reason.message, /newer recovery/);
  assert.equal(unpackProject(state.stored.archive).revisionId, 'two');
});
test('quota, denied storage, and corrupt records surface errors while explicit archives remain usable', async () => {
  const { state, factory } = database(); state.errorNext = new DOMException('Quota is full.', 'QuotaExceededError');
  await assert.rejects(writeProjectRecovery(snapshot('one'), draft, { factory }), { name: 'QuotaExceededError' });
  await assert.rejects(readProjectRecovery({ factory, denied: true }), { name: 'SecurityError' });
  await assert.rejects(writeProjectRecovery(snapshot('one'), draft, { factory, denied: true }), { name: 'SecurityError' });
  state.stored = { version: 1, savedAt: new Date().toISOString(), archive: new Uint8Array([0]), draft };
  await assert.rejects(readProjectRecovery({ factory }), /project ZIP/);
  state.stored = { version: 1, savedAt: 'bad', archive: packProject(snapshot('one')), draft };
  await assert.rejects(readProjectRecovery({ factory }), /corrupt/);
  assert.deepEqual(unpackProject(packProject(snapshot('explicit'))), snapshot('explicit'));
});
test('invalid drafts and source fail before any storage transaction opens', async () => {
  const { state, factory } = database();
  await assert.rejects(writeProjectRecovery(snapshot('one'), { text: null, selection: -1 }, { factory }), /draft/);
  await assert.rejects(writeProjectRecovery({ ...snapshot('one'), source: '{}' }, draft, { factory }));
  assert.equal(state.opened.length, 0);
});
