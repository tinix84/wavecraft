import { packProject, PROJECT_LIMITS, unpackProject } from './archive.ts';
import type { ProjectRecoveryRecord, ProjectSnapshot, RecoveryDraft, RecoveryOptions } from './types.ts';

export const PROJECT_RECOVERY_DB = 'wavecraft-project-recovery';
type StoredRevision = { version: 1; revisionId: string; savedAt: string; archive: Uint8Array; draft: RecoveryDraft };
const encoder = new TextEncoder();
function validateDraft(draft: RecoveryDraft): void {
  if (!draft || Object.keys(draft).some(k => !['text', 'selection'].includes(k)) || !(draft.text === null || (typeof draft.text === 'string' && encoder.encode(draft.text).length <= PROJECT_LIMITS.source)) || !(draft.selection === null || typeof draft.selection === 'string' && encoder.encode(draft.selection).length <= 1024 || typeof draft.selection === 'number' && Number.isSafeInteger(draft.selection) && draft.selection >= 0)) throw new Error('Use a valid recovery text draft and selection.');
}
function decode(record: StoredRevision): ProjectRecoveryRecord {
  if (!record || record.version !== 1 || typeof record.savedAt !== 'string' || !Number.isFinite(Date.parse(record.savedAt)) || !(record.archive instanceof Uint8Array)) throw new Error('The recovery record is corrupt. Open an explicitly saved project.');
  validateDraft(record.draft);
  const snapshot = unpackProject(record.archive);
  if (record.revisionId !== snapshot.revisionId) throw new Error('The recovery revision identity does not match its archive.');
  return { version: 1, savedAt: record.savedAt, snapshot, draft: structuredClone(record.draft) };
}
function open(options: RecoveryOptions): Promise<IDBDatabase> {
  if (options.denied) return Promise.reject(new DOMException('Recovery storage is denied. Explicit project save and import remain available.', 'SecurityError'));
  const factory = options.factory ?? globalThis.indexedDB;
  if (!factory) return Promise.reject(new Error('Recovery storage is unavailable. Explicit project save and import remain available.'));
  return new Promise((resolve, reject) => {
    let rejected = false;
    const request = factory.open(PROJECT_RECOVERY_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('revisions');
    request.onerror = () => reject(request.error ?? new Error('The project recovery database did not open.'));
    request.onblocked = () => { rejected = true; reject(new Error('Another page blocks project recovery. Close the other project page.')); };
    request.onsuccess = () => { if (rejected) request.result.close(); else resolve(request.result); };
  });
}

export async function writeProjectRecovery(snapshot: ProjectSnapshot, draft: RecoveryDraft = { text: null, selection: null }, options: RecoveryOptions = {}): Promise<ProjectRecoveryRecord> {
  // Prepare and validate the complete archive before opening the transaction.
  validateDraft(draft);
  const record: StoredRevision = { version: 1, revisionId: snapshot.revisionId, savedAt: new Date().toISOString(), archive: packProject(snapshot), draft: structuredClone(draft) };
  const verified = decode(record);
  const db = await open(options);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('revisions', 'readwrite');
      let failure: unknown;
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('The project recovery write aborted.'));
      tx.onerror = event => { failure ??= (event?.target as IDBRequest | null)?.error ?? tx.error ?? undefined; };
      const store = tx.objectStore('revisions');
      const put = () => { try { store.put(record, 'latest'); } catch (error) { failure = error; tx.abort(); } };
      if (options.expectedHead === undefined) put();
      else {
        const request = store.get('latest');
        request.onsuccess = () => {
          try {
            const previous = request.result as StoredRevision | undefined;
            if (previous && (previous.version !== 1 || typeof previous.revisionId !== 'string' || !(previous.archive instanceof Uint8Array) || previous.archive.length > PROJECT_LIMITS.archive)) throw new Error('The recovery record is corrupt. Review an explicit project before replacing recovery.');
            const head = previous?.revisionId ?? null;
            if (head !== options.expectedHead) throw new Error('A newer recovery revision exists. Review it before replacing recovery.');
            put();
          } catch (error) { failure = error; tx.abort(); }
        };
      }
    });
    return verified;
  } finally { db.close(); }
}

export async function readProjectRecovery(options: RecoveryOptions = {}): Promise<ProjectRecoveryRecord | undefined> {
  const db = await open(options);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('revisions', 'readonly');
      let stored: StoredRevision | undefined;
      const request = tx.objectStore('revisions').get('latest');
      request.onsuccess = () => { stored = request.result; };
      tx.oncomplete = () => { try { resolve(stored === undefined ? undefined : decode(stored)); } catch (error) { reject(error); } };
      tx.onabort = () => reject(tx.error ?? new Error('The project recovery read aborted.'));
      tx.onerror = () => reject(tx.error ?? new Error('The project recovery read failed.'));
    });
  } finally { db.close(); }
}
