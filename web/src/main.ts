import { comparePayload, copyPayload, imageMime, inspectYaml, LIMITS, packProof, samplePngBase64, sampleYaml, unpackProof, validateMatrix } from './proof.ts';
import type { ProofPayload } from './proof.ts';
import { readRecovery, writeRecovery } from './storage.ts';

declare const __BUILD_META__: Record<string, unknown>;
declare const __NOTICES__: string;
declare const __CHECKLIST__: string;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const encoder = new TextEncoder();
const report: Record<string, unknown> = {
  scope: 'Phase 1 portability proof only', build: __BUILD_META__,
  origin: { protocol: location.protocol, origin: location.origin, page: location.href, userAgent: navigator.userAgent },
  fileOriginHumanGate: 'PENDING: A person must test the release HTML directly from disk in Chrome and Edge.',
  storage: 'Not tested', zip: 'Not tested', pointer: { inputs: 0 }, nativeTransform: 'Not tested',
  network: 'Artifact CSP blocks connections. An offline human test remains required.'
};
let active: ProofPayload;
let expectedDownload: ProofPayload | undefined;
let imageUrl: string | undefined;
let pointerInputs = 0;

function updateReport() { $('report').textContent = JSON.stringify(report, null, 2); }
function status(id: string, text: string, error = false) {
  const node = $(id); node.textContent = text; node.classList.toggle('error', error); node.classList.toggle('ok', !error);
}
function errorText(error: unknown) { return error instanceof Error ? `${error.name}: ${error.message}` : String(error); }
function denyStorage() { return $<HTMLInputElement>('deny-storage').checked; }

// Native File and Blob APIs: https://w3c.github.io/FileAPI/
// Anchor downloads: https://html.spec.whatwg.org/multipage/links.html#downloading-resources
function download(name: string, bytes: Uint8Array | string, mime: string) {
  const blob = new Blob([typeof bytes === 'string' ? bytes : bytes.slice().buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function payloadDigests(payload: ProofPayload) {
  async function digest(bytes: Uint8Array) {
    if (!globalThis.crypto?.subtle) return 'SHA-256 unavailable in this browser context. Byte equality remains available.';
    // https://www.w3.org/TR/WebCryptoAPI/#SubtleCrypto-method-digest
    const hash = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  return { yamlSha256: await digest(payload.yaml), imageSha256: payload.image ? await digest(payload.image.bytes) : null };
}

function setPayload(payload: ProofPayload, source: string) {
  active = copyPayload(payload);
  const syntax = inspectYaml(active.yaml);
  $<HTMLTextAreaElement>('yaml-preview').value = syntax.text;
  status('source-status', `${source} · YAML ${active.yaml.length} bytes · image ${active.image?.bytes.length ?? 0} bytes. Original bytes remain unchanged.`);
  status('yaml-status', syntax.errors.length ? `YAML syntax invalid. Original bytes remain available. ${syntax.errors.join(' ')}` : `YAML syntax valid. Name: ${syntax.name}. No semantic compilation occurs.`, Boolean(syntax.errors.length));
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  const image = $<SVGImageElement & HTMLElement>('evidence-image');
  if (active.image) {
    imageUrl = URL.createObjectURL(new Blob([active.image.bytes.slice().buffer], { type: active.image.mime }));
    image.setAttribute('href', imageUrl);
    status('image-status', `${active.image.name} · ${active.image.mime} · original ${active.image.bytes.length} bytes. The view scales independently.`);
  } else {
    imageUrl = undefined; image.removeAttribute('href'); status('image-status', 'No image evidence. The coordinate grid still works.');
  }
  report.payload = { source, yamlName: active.yamlName, yamlBytes: active.yaml.length, imageName: active.image?.name ?? null,
    imageBytes: active.image?.bytes.length ?? 0, syntaxErrors: syntax.errors, syntaxWarnings: syntax.warnings };
  const snapshot = active;
  void payloadDigests(snapshot).then(digests => {
    if (active === snapshot) { report.payloadDigests = digests; updateReport(); }
  }).catch(error => { report.payloadDigests = errorText(error); updateReport(); });
  updateReport();
}

function sample() {
  const imageBytes = Uint8Array.from(atob(samplePngBase64), char => char.charCodeAt(0));
  setPayload({ yamlName: 'phase1-sample.yaml', yaml: encoder.encode(sampleYaml), image: { name: 'phase1-pixel.png', mime: 'image/png', bytes: imageBytes } }, 'Sample evidence loaded');
}

function fileInput(id: string, limit: number, action: (file: File) => Promise<void>, statusId: string) {
  $<HTMLInputElement>(id).addEventListener('change', async event => {
    const input = event.currentTarget as HTMLInputElement; const file = input.files?.[0]; if (!file) return;
    try {
      if (file.size > limit) throw new Error(`The file exceeds the ${limit} byte proof limit.`);
      await action(file);
    } catch (error) { status(statusId, errorText(error), true); report.lastError = errorText(error); updateReport(); }
    finally { input.value = ''; }
  });
}

fileInput('yaml-file', LIMITS.yaml, async file => {
  const text = await file.text();
  const raw = new Uint8Array(await file.arrayBuffer());
  const syntax = inspectYaml(raw);
  if (text !== syntax.text) throw new Error('The browser text decoding differs from UTF-8 decoding. The active evidence did not change.');
  setPayload({ ...active, yamlName: file.name, yaml: raw }, `Imported ${file.name} locally`);
  expectedDownload = undefined;
}, 'source-status');

fileInput('image-file', LIMITS.image, async file => {
  const raw = new Uint8Array(await file.arrayBuffer());
  setPayload({ ...active, image: { name: file.name, mime: imageMime(raw), bytes: raw } }, `Imported ${file.name} locally`);
  expectedDownload = undefined;
}, 'image-status');

fileInput('zip-file', LIMITS.archive, async file => {
  const restored = unpackProof(new Uint8Array(await file.arrayBuffer()));
  const baseline = expectedDownload ?? active;
  const comparison = comparePayload(baseline, restored);
  report.zip = { operation: 'Local ZIP file reopened', name: file.name, comparison,
    baseline: expectedDownload ? 'Evidence captured at last download' : 'Evidence active before import',
    matches: Object.values(comparison).every(Boolean) };
  setPayload(restored, `Reopened ${file.name} locally`);
  status('zip-status', `ZIP reopened. YAML bytes: ${comparison.yamlBytes}. Image bytes: ${comparison.imageBytes}. Names and types: ${comparison.namesAndTypes}.`);
}, 'zip-status');

$('sample').onclick = () => { sample(); expectedDownload = undefined; };
$('download-yaml').onclick = () => download(active.yamlName, active.yaml, 'application/yaml');
$('download-image').onclick = () => {
  if (!active.image) return status('image-status', 'Import an image first.', true);
  download(active.image.name, active.image.bytes, active.image.mime);
};
$('evidence-image').addEventListener('error', () => status('image-status', 'The browser could not display the image. Its original bytes remain available for ZIP saving.', true));
$('download-zip').onclick = () => {
  try {
    const zip = packProof(active); expectedDownload = copyPayload(active);
    download('wavecraft-phase1-proof.zip', zip, 'application/zip');
    report.zipDownload = { bytes: zip.length, requested: new Date().toISOString(), storageDenied: denyStorage(), note: 'The download request does not prove that a disk file was saved.' };
    status('zip-status', `ZIP download requested: ${zip.length} bytes. Reopen the disk file to verify its payload.`); updateReport();
  } catch (error) { status('zip-status', errorText(error), true); }
};
$('roundtrip').onclick = () => {
  try {
    const zip = packProof(active); const comparison = comparePayload(active, unpackProof(zip));
    report.zip = { operation: 'In-memory ZIP only. Disk reopen remains separate.', bytes: zip.length, comparison, matches: Object.values(comparison).every(Boolean) };
    status('zip-status', `In-memory round-trip: ${JSON.stringify(comparison)}. This does not verify a disk download.`); updateReport();
  } catch (error) { status('zip-status', errorText(error), true); }
};

function storageFailure(error: unknown) {
  report.storage = { result: 'Unavailable', simulatedDenied: denyStorage(), error: errorText(error) };
  status('storage-status', `Recovery unavailable. ${errorText(error)} Keep an explicit ZIP backup. Import and save remain usable.`, true); updateReport();
}
$('write-recovery').onclick = async () => {
  try {
    // Prepare binary data before the transaction opens.
    const zip = packProof(active);
    const record = await writeRecovery(zip, active, denyStorage());
    report.storage = { result: 'Transaction complete', savedAt: record.savedAt, zipBytes: record.zip.length, readAfterReload: 'Pending' };
    status('storage-status', `Recovery write: transaction complete at ${record.savedAt}. Reload this page, then read the revision.`); updateReport();
  } catch (error) { storageFailure(error); }
};
$('read-recovery').onclick = async () => {
  try {
    const record = await readRecovery(denyStorage());
    if (!record) throw new Error('No recovery revision exists for this browser origin.');
    const restored = unpackProof(record.zip);
    // Compare against the original bytes captured before the write transaction.
    const comparison = comparePayload(record.expectedPayload, restored);
    const currentComparison = comparePayload(active, restored);
    setPayload(restored, 'Recovery revision read'); expectedDownload = undefined;
    report.storage = { result: 'Recovery read transaction complete', savedAt: record.savedAt, zipBytes: record.zip.length,
      comparisonWithSavedOriginalBytes: comparison, comparisonWithPreReadEvidence: currentComparison,
      reloadEvidence: 'A person must confirm that this read follows a page reload. The app does not infer it.' };
    status('storage-status', `Recovery read: transaction complete. Saved ${record.savedAt}. Payload comparison: ${JSON.stringify(comparison)}.`); updateReport();
  } catch (error) { storageFailure(error); }
};
$<HTMLInputElement>('deny-storage').onchange = () => {
  if (denyStorage()) storageFailure(new DOMException('Simulated denied storage is active.', 'SecurityError'));
  else { report.storage = 'Denial simulation disabled. Run a real write and read test.'; status('storage-status', String(report.storage)); updateReport(); }
};

const svg = $<SVGSVGElement & HTMLElement>('proof-svg');
function screenMatrix() {
  // Native screen coordinates include SVG viewBox and CSS sizing.
  // https://svgwg.org/svg2-draft/types.html#__svg__SVGGraphicsElement__getScreenCTM
  const matrix = svg.getScreenCTM(); if (!matrix) throw new Error('The SVG screen transform is unavailable.');
  validateMatrix(matrix); return matrix;
}
function mapPointer(x: number, y: number) {
  const mapped = new DOMPoint(x, y).matrixTransform(screenMatrix().inverse());
  if (![mapped.x, mapped.y].every(Number.isFinite)) throw new Error('The mapped pointer coordinates are not finite.');
  return mapped;
}
function viewState() { return { zoom: $<HTMLSelectElement>('zoom').value, widthPercent: $<HTMLSelectElement>('width').value, renderedWidth: svg.getBoundingClientRect().width }; }
function checkTransform() {
  try {
    const matrix = screenMatrix();
    const checks = [[0, 0], [200, 120], [400, 240]].map(([x, y]) => {
      const screen = new DOMPoint(x, y).matrixTransform(matrix); const back = mapPointer(screen.x, screen.y);
      return { x, y, error: Math.hypot(back.x - x, back.y - y) };
    });
    const maxError = Math.max(...checks.map(check => check.error));
    report.nativeTransform = { ...viewState(), maxError, passesTolerance: maxError < 1e-8, tolerance: 1e-8, checks, note: 'Native matrix round-trip. Actual pointer input is recorded separately.' };
    status('transform-status', `Native transform error: ${maxError.toExponential(2)} SVG units. View: ${JSON.stringify(viewState())}.`); updateReport();
  } catch (error) { status('transform-status', errorText(error), true); report.nativeTransform = errorText(error); updateReport(); }
}
svg.addEventListener('pointerdown', event => {
  try {
    const point = mapPointer(event.clientX, event.clientY); pointerInputs++;
    $('pointer-mark').setAttribute('cx', String(point.x)); $('pointer-mark').setAttribute('cy', String(point.y));
    const pointer = { inputs: pointerInputs, x: point.x, y: point.y, distanceFromCenter: Math.hypot(point.x - 200, point.y - 120), ...viewState() };
    report.pointer = pointer; status('pointer-status', `Pointer ${pointerInputs}: (${point.x.toFixed(3)}, ${point.y.toFixed(3)}). Center distance: ${pointer.distanceFromCenter.toFixed(3)} SVG units.`); updateReport();
  } catch (error) { status('pointer-status', errorText(error), true); }
});
function updateView() {
  const zoom = Number($<HTMLSelectElement>('zoom').value);
  svg.setAttribute('viewBox', `${200 - 200 / zoom} ${120 - 120 / zoom} ${400 / zoom} ${240 / zoom}`);
  svg.style.width = `${$<HTMLSelectElement>('width').value}%`;
  checkTransform();
}
$('zoom').onchange = updateView; $('width').onchange = updateView; $('check-transform').onclick = checkTransform;
new ResizeObserver(checkTransform).observe(svg);
$('download-report').onclick = () => download('wavecraft-phase1-diagnostic.json', JSON.stringify(report, null, 2), 'application/json');
$('download-checklist').onclick = () => download('wavecraft-phase1-human-test.md', __CHECKLIST__, 'text/markdown');
$('build-info').textContent = JSON.stringify(__BUILD_META__, null, 2); $('notices').textContent = __NOTICES__;
sample();
