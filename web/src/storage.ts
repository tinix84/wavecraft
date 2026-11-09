import { copyPayload, validatePayload } from './proof.ts';
import type { ProofPayload } from './proof.ts';

type RecoveryRecord = { version: 1; savedAt: string; zip: Uint8Array; expectedPayload: ProofPayload };

function openRecovery(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // API: https://www.w3.org/TR/IndexedDB/#dom-idbfactory-open
    const request = indexedDB.open('wavecraft-phase1-proof', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('revisions');
    request.onerror = () => reject(request.error ?? new Error('The recovery database did not open.'));
    request.onblocked = () => reject(new Error('Another page blocks the recovery database. Close the other proof page.'));
    request.onsuccess = () => resolve(request.result);
  });
}

export async function writeRecovery(zip: Uint8Array, payload: ProofPayload, denied = false): Promise<RecoveryRecord> {
  if (denied) throw new DOMException('The test denies recovery storage. Explicit ZIP save and import remain available.', 'SecurityError');
  const record: RecoveryRecord = { version: 1, savedAt: new Date().toISOString(), zip: zip.slice(), expectedPayload: copyPayload(payload) };
  const db = await openRecovery();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('revisions', 'readwrite');
      // Commit boundary: https://www.w3.org/TR/IndexedDB/#transaction-lifecycle
      // A successful put request does not prove that the transaction commits.
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('The recovery transaction aborted.'));
      tx.onerror = () => reject(tx.error ?? new Error('The recovery transaction failed.'));
      tx.objectStore('revisions').put(record, 'latest');
    });
    return record;
  } finally { db.close(); }
}

export async function readRecovery(denied = false): Promise<RecoveryRecord | undefined> {
  if (denied) throw new DOMException('The test denies recovery storage. Explicit ZIP save and import remain available.', 'SecurityError');
  const db = await openRecovery();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('revisions', 'readonly');
      const request = tx.objectStore('revisions').get('latest');
      let record: RecoveryRecord | undefined;
      request.onsuccess = () => { record = request.result; };
      tx.oncomplete = () => {
        if (record && (record.version !== 1 || !(record.zip instanceof Uint8Array) || typeof record.savedAt !== 'string')) {
          reject(new Error('The recovery record is invalid. Import an explicit proof ZIP.'));
        } else {
          try {
            if (record) validatePayload(record.expectedPayload);
            resolve(record);
          } catch { reject(new Error('The recovery comparison payload is invalid. Import an explicit proof ZIP.')); }
        }
      };
      tx.onabort = () => reject(tx.error ?? new Error('The recovery read aborted.'));
      tx.onerror = () => reject(tx.error ?? new Error('The recovery read failed.'));
    });
  } finally { db.close(); }
}
