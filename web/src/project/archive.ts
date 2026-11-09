import { inflateSync, unzipSync, zipSync } from 'fflate';
import type { Zippable } from 'fflate';
import { compileYaml } from '../semantic/index.ts';
import { compilePointProject } from '../export/index.ts';
import { imageMime } from '../proof.ts';
import type { ProjectEvidence, ProjectSnapshot } from './types.ts';
import { checkDeflate, DEFLATE_LIMITS } from './deflate.ts';
import { validateDigitization } from '../digitize/index.ts';

export const PROJECT_LIMITS = Object.freeze({ archive: 16 * 1024 * 1024, decoded: 16 * 1024 * 1024, source: 1024 * 1024, image: 8 * 1024 * 1024, json: 1024 * 1024, manifest: 8192, entries: 8, points: 10_000, notes: 65536, deflateBlocks: DEFLATE_LIMITS.blocks, deflateWork: DEFLATE_LIMITS.work });
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const fields = { rawPoints: 'raw-points', calibration: 'calibration', corrections: 'corrections', notes: 'source-notes', transforms: 'transforms', digitization: 'digitization' } as const;
const images = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;
const paths = new Set(['manifest.json', 'waveform.yaml', ...Object.values(images).map(ext => `evidence/source-image.${ext}`), ...Object.values(fields).map(name => `evidence/${name}.json`)]);
const fail = (message: string): never => { throw new Error(message); };
const object = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
function keys(v: any, allowed: string[], required: string[] = allowed): void {
  if (!object(v) || Object.keys(v).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(v, k))) fail('The project data fields are invalid.');
}
const finite = (v: any): v is number => typeof v === 'number' && Number.isFinite(v);
const pair = (v: any): boolean => Array.isArray(v) && v.length === 2 && v.every(finite);
const text = (v: any, max: number): boolean => typeof v === 'string' && encoder.encode(v).length <= max;
function json(bytes: Uint8Array): any { return JSON.parse(decoder.decode(bytes).replace(/^\uFEFF/, '')); }
function limit(name: string): number { return name === 'manifest.json' ? PROJECT_LIMITS.manifest : name === 'waveform.yaml' ? PROJECT_LIMITS.source : name.endsWith('.json') ? PROJECT_LIMITS.json : PROJECT_LIMITS.image; }

export function validateProject(snapshot: ProjectSnapshot): 'current' | 'voltage' {
  keys(snapshot, ['revisionId', 'mode', 'source', 'evidence']);
  if (!text(snapshot.revisionId, 128) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(snapshot.revisionId)) fail('Use a project revision identity with 1 through 128 ASCII characters.');
  if (!text(snapshot.source, PROJECT_LIMITS.source) || decoder.decode(encoder.encode(snapshot.source)) !== snapshot.source) fail('Use valid UTF-8 project source with at most 1 MiB.');
  let dimension: 'current' | 'voltage';
  if (snapshot.mode === 'semantic') {
    const result = compileYaml(snapshot.source);
    if (!result.ok) fail('The project requires valid committed semantic YAML.');
    dimension = result.compiled.dimension;
  } else if (snapshot.mode === 'points') {
    const result = compilePointProject(JSON.parse(snapshot.source.replace(/^\uFEFF/, '')));
    if (!result.ok) fail('The project requires valid committed point JSON.');
    dimension = 'current';
  } else fail('The project source mode is not supported.');
  const e = snapshot.evidence;
  keys(e, ['image', ...Object.keys(fields)], []);
  if (e.digitization !== undefined) {
    validateDigitization(e.digitization);
    if (e.digitization.extraction.kind === 'image' && !e.image) fail('Native extraction requires the original image bytes.');
  }
  if (e.image !== undefined) {
    keys(e.image, ['name', 'mime', 'bytes']);
    if (!text(e.image.name, 255) || !e.image.name || /[/\\\x00-\x1f]/.test(e.image.name) || !(e.image.bytes instanceof Uint8Array) || e.image.bytes.length > PROJECT_LIMITS.image || imageMime(e.image.bytes) !== e.image.mime) fail('Use original PNG, JPEG, or WebP bytes with a local image basename.');
  }
  if (e.rawPoints !== undefined && (!Array.isArray(e.rawPoints) || e.rawPoints.length > PROJECT_LIMITS.points || !e.rawPoints.every(pair))) fail('Use at most 10000 finite raw image points.');
  if (e.calibration !== undefined) {
    const c = e.calibration; keys(c, ['low', 'high', 'x0', 'x1', 'y0', 'y1']);
    if (![c.x0, c.x1, c.y0, c.y1].every(finite) || !(c.low === null || pair(c.low)) || !(c.high === null || pair(c.high))) fail('Use finite calibration values and image anchors.');
  }
  if (e.corrections !== undefined) {
    if (!Array.isArray(e.corrections) || e.corrections.length > PROJECT_LIMITS.points) fail('Use at most 10000 point corrections.');
    const seen = new Set<number>();
    for (const c of e.corrections) {
      keys(c, ['index', 'point', 'note']);
      if (!Number.isSafeInteger(c.index) || c.index < 0 || c.index >= (e.rawPoints?.length ?? 0) || seen.has(c.index) || !pair(c.point) || !text(c.note, PROJECT_LIMITS.notes)) fail('Use one finite correction for each existing raw point index.');
      seen.add(c.index);
    }
  }
  if (e.notes !== undefined && !text(e.notes, PROJECT_LIMITS.notes)) fail('The source notes exceed 64 KiB.');
  if (e.transforms !== undefined) {
    const t = e.transforms; keys(t, ['originalSize', 'viewSize', 'crop', 'reference'], ['originalSize', 'viewSize', 'crop']);
    if (![t.originalSize, t.viewSize].every(v => pair(v) && v.every(n => Number.isSafeInteger(n) && n > 0)) || !(t.crop === null || (Array.isArray(t.crop) && t.crop.length === 4 && t.crop.every(finite) && t.crop[0] >= 0 && t.crop[1] >= 0 && t.crop[2] > 0 && t.crop[3] > 0 && t.crop[0] + t.crop[2] <= t.originalSize[0] && t.crop[1] + t.crop[3] <= t.originalSize[1])) || (t.reference !== undefined && !['sample', 'image', 'unavailable'].includes(t.reference))) fail('Use positive integral image dimensions and a crop inside the original image.');
    if (t.reference === 'image' && !e.image) fail('The original image bytes are missing.');
    if (t.reference === 'sample' && e.image?.mime !== 'image/png') fail('A sample reference requires its generated PNG bytes.');
    if (t.reference === 'unavailable' && e.image) fail('Unavailable image evidence cannot contain an image.');
    if (t.viewSize.some(n => n > 2000)) fail('The image view must use 1 through 2000 pixels on each axis.');
    if (e.digitization?.extraction.kind === 'image' && e.digitization.extraction.size.some((n, i) => n !== t.originalSize[i])) fail('The native extraction size must match the original image dimensions.');
  }
  return dimension!;
}

export function packProject(snapshot: ProjectSnapshot): Uint8Array {
  const dimension = validateProject(snapshot), e = snapshot.evidence;
  const files: Record<string, Uint8Array> = { 'waveform.yaml': encoder.encode(snapshot.source) };
  if (e.image) files[`evidence/source-image.${images[e.image.mime]}`] = e.image.bytes.slice();
  for (const [field, file] of Object.entries(fields)) if (e[field as keyof typeof fields] !== undefined) files[`evidence/${file}.json`] = encoder.encode(JSON.stringify({ version: 1, data: e[field as keyof typeof fields] }));
  const manifest = { format: 'wavecraft-project', version: 1, revisionId: snapshot.revisionId, mode: snapshot.mode, sourceSchema: snapshot.mode === 'semantic' ? 'wavecraft/1' : 'wavecraft-points/1', evidenceSchema: e.digitization === undefined ? 1 : 2, dimension, image: e.image ? { name: e.image.name, mime: e.image.mime } : null, entries: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, { bytes: bytes.length }])) };
  files['manifest.json'] = encoder.encode(JSON.stringify(manifest));
  checkSizes(files);
  const zipFiles: Zippable = {};
  // Store original bitmaps directly. Recompression can exceed validation work limits.
  for (const [name, bytes] of Object.entries(files)) zipFiles[name] = name.startsWith('evidence/source-image.') ? [bytes, { level: 0 }] : bytes;
  const zip = zipSync(zipFiles, { level: 6 });
  if (zip.length > PROJECT_LIMITS.archive) fail('The project archive exceeds 16 MiB.');
  return zip;
}
function checkSizes(files: Record<string, Uint8Array>): void {
  if (Object.keys(files).length > PROJECT_LIMITS.entries + (Object.hasOwn(files, 'evidence/digitization.json') ? 1 : 0)) fail('The project ZIP entry count exceeds its schema limit.');
  let total = 0;
  for (const [name, bytes] of Object.entries(files)) {
    if (!paths.has(name) || bytes.length > limit(name)) fail(`The project entry exceeds its size limit: ${name}`);
    total += bytes.length;
  }
  if (total > PROJECT_LIMITS.decoded) fail('The decoded project exceeds 16 MiB.');
}

type ZipEntry = { name: string; size: number; compressed: number; crc: number; method: number; local: number; start: number; end: number };
// fflate 0.8.3 does not check CRC or local-header agreement. Check both before extraction.
function directory(bytes: Uint8Array): ZipEntry[] {
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (p: number) => d.getUint16(p, true), u32 = (p: number) => d.getUint32(p, true);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && u32(end) !== 0x06054b50) end--;
  if (end < 0 || end + 22 + u16(end + 20) !== bytes.length || u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10)) fail('The ZIP directory is invalid.');
  const count = u16(end + 10), offset = u32(end + 16), length = u32(end + 12);
  if (count < 2 || count > PROJECT_LIMITS.entries + 1 || offset + length !== end) fail('The ZIP entry count or directory bounds are invalid.');
  const entries: ZipEntry[] = []; let at = offset, total = 0;
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || u32(at) !== 0x02014b50) fail('The ZIP central entry is invalid.');
    const flags = u16(at + 8), method = u16(at + 10), crc = u32(at + 16), compressed = u32(at + 20), size = u32(at + 24), nameLength = u16(at + 28), next = at + 46 + nameLength + u16(at + 30) + u16(at + 32), local = u32(at + 42);
    if (next > end || flags & ~0x800 || ![0, 8].includes(method) || u16(at + 34) || u16(at + 30)) fail('The ZIP flags, method, extra fields, or entry bounds are not supported.');
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (!paths.has(name) || seen.has(name)) fail('The ZIP contains an unexpected or duplicate entry.');
    if (size > limit(name) || (total += size) > PROJECT_LIMITS.decoded) fail('The ZIP declared decoded size exceeds its limit.');
    if (local + 30 > offset || u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method || u32(local + 14) !== crc || u32(local + 18) !== compressed || u32(local + 22) !== size || u16(local + 26) !== nameLength || u16(local + 28)) fail('The ZIP local header does not match its directory or contains unsupported extra fields.');
    const start = local + 30 + nameLength + u16(local + 28), stop = start + compressed;
    if (start > offset || stop > offset || decoder.decode(bytes.subarray(local + 30, local + 30 + nameLength)) !== name || entries.some(e => local < e.end && stop > e.local)) fail('The ZIP data bounds or local name are invalid.');
    seen.add(name); entries.push({ name, size, compressed, crc, method, local, start, end: stop }); at = next;
  }
  if (at !== end || !seen.has('manifest.json') || !seen.has('waveform.yaml')) fail('The ZIP requires manifest.json and waveform.yaml.');
  if (count > PROJECT_LIMITS.entries && !seen.has('evidence/digitization.json')) fail('The ZIP entry count exceeds the evidence schema limit.');
  let localEnd = 0;
  for (const entry of [...entries].sort((a, b) => a.local - b.local)) {
    if (entry.local !== localEnd) fail('The ZIP contains an unindexed local entry or an unexplained data gap.');
    localEnd = entry.end;
  }
  if (localEnd !== offset) fail('The ZIP contains unexplained data before its directory.');
  return entries;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function crc32(bytes: Uint8Array): number { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export function unpackProject(bytes: Uint8Array): ProjectSnapshot {
  if (!(bytes instanceof Uint8Array) || bytes.length < 22 || bytes.length > PROJECT_LIMITS.archive) fail('Use a project ZIP with at most 16 MiB.');
  try {
    const entries = directory(bytes);
    // Metadata-only pass. No entry inflates before the complete allowlist and budgets pass.
    const seen = new Set<string>();
    unzipSync(bytes, { filter(file) {
      const entry = entries.find(e => e.name === file.name);
      if (!entry || seen.has(file.name) || file.originalSize !== entry.size || file.size !== entry.compressed || file.compression !== entry.method) fail('The ZIP metadata does not match its validated directory.');
      seen.add(file.name); return false;
    } });
    if (seen.size !== entries.length) fail('The ZIP metadata is incomplete.');
    for (const entry of entries) {
      const compressed = bytes.subarray(entry.start, entry.end);
      if (entry.method === 8) checkDeflate(compressed, entry.size);
      // One extra output byte detects underdeclared DEFLATE data without an unbounded allocation.
      const actual = entry.method === 8 ? inflateSync(compressed, { out: new Uint8Array(entry.size + 1) }) : compressed;
      if (actual.length !== entry.size || crc32(actual) !== entry.crc) fail(`The ZIP entry size or CRC does not match: ${entry.name}`);
    }
    const files = unzipSync(bytes, { filter: file => seen.has(file.name) }); checkSizes(files);
    const m = json(files['manifest.json']);
    keys(m, ['format', 'version', 'revisionId', 'mode', 'sourceSchema', 'evidenceSchema', 'dimension', 'image', 'entries']);
    const extended = Object.hasOwn(files, 'evidence/digitization.json');
    if (m.format !== 'wavecraft-project' || m.version !== 1 || m.evidenceSchema !== (extended ? 2 : 1) || m.sourceSchema !== (m.mode === 'semantic' ? 'wavecraft/1' : 'wavecraft-points/1')) fail('The project format or schema version is not supported.');
    if (!object(m.entries) || Object.keys(m.entries).length !== entries.length - 1) fail('The manifest entry list does not match the ZIP.');
    for (const [name, declaration] of Object.entries(m.entries)) {
      keys(declaration, ['bytes']);
      if (name === 'manifest.json' || !Object.hasOwn(files, name) || (declaration as any).bytes !== files[name].length) fail('The manifest entry size does not match the ZIP.');
    }
    const evidence: ProjectEvidence = {};
    if (m.image !== null) {
      keys(m.image, ['name', 'mime']);
      const ext = images[m.image.mime as keyof typeof images], image = files[`evidence/source-image.${ext}`];
      if (!ext || !image) fail('The manifest image does not match the ZIP.');
      evidence.image = { name: m.image.name, mime: m.image.mime, bytes: image };
    }
    const imageNames = entries.filter(e => e.name.startsWith('evidence/source-image.'));
    if (imageNames.length !== (evidence.image ? 1 : 0)) fail('The ZIP image entries do not match the manifest.');
    for (const [field, file] of Object.entries(fields)) {
      const entry = files[`evidence/${file}.json`];
      if (entry) { const value = json(entry); keys(value, ['version', 'data']); if (value.version !== 1) fail('The evidence schema version is not supported.'); (evidence as any)[field] = value.data; }
    }
    const snapshot: ProjectSnapshot = { revisionId: m.revisionId, mode: m.mode, source: decoder.decode(files['waveform.yaml']), evidence };
    if (validateProject(snapshot) !== m.dimension) fail('The signal dimension does not match the manifest.');
    return snapshot;
  } catch (error) {
    if (error instanceof Error) throw new Error(`Project import failed. ${error.message}`);
    fail('Project import failed. The ZIP is invalid.');
  }
}
