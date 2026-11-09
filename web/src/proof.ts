import { parseDocument } from 'yaml';
import { unzipSync, zipSync } from 'fflate';

// This format is a Phase 1 test container. It is not the version 1 project format.
export const LIMITS = { yaml: 1024 * 1024, image: 4 * 1024 * 1024, archive: 6 * 1024 * 1024, manifest: 4096 };
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const paths = ['manifest.json', 'source.yaml', 'evidence/image.bin'];

export type ImageEvidence = { name: string; mime: string; bytes: Uint8Array };
export type ProofPayload = { yamlName: string; yaml: Uint8Array; image?: ImageEvidence };

export const sampleYaml = '# Phase 1 syntax fixture. No waveform compilation occurs.\r\nname: portability_proof\r\nnominal_current: "240A"\r\nsteps:\r\n  - { hold: "175%", for: "2ms" }\r\n';
export const samplePngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jx1sAAAAASUVORK5CYII=';

export function copyPayload(payload: ProofPayload): ProofPayload {
  return {
    yamlName: payload.yamlName, yaml: payload.yaml.slice(),
    ...(payload.image ? { image: { ...payload.image, bytes: payload.image.bytes.slice() } } : {})
  };
}

export function imageMime(bytes: Uint8Array): string {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  throw new Error('Select a PNG, JPEG, or WebP image. The file signature does not match these formats.');
}

export function validatePayload(payload: ProofPayload): void {
  if (!(payload.yaml instanceof Uint8Array) || payload.yaml.length > LIMITS.yaml) throw new Error('The YAML exceeds the 1 MiB proof limit.');
  if (typeof payload.yamlName !== 'string' || payload.yamlName.length > 255) throw new Error('The YAML filename is invalid.');
  // UTF-8 decoding does not change the stored bytes, including BOM and CRLF bytes.
  decoder.decode(payload.yaml);
  if (payload.image) {
    if (!(payload.image.bytes instanceof Uint8Array) || payload.image.bytes.length > LIMITS.image) throw new Error('The image exceeds the 4 MiB proof limit.');
    if (typeof payload.image.name !== 'string' || payload.image.name.length > 255) throw new Error('The image filename is invalid.');
    if (imageMime(payload.image.bytes) !== payload.image.mime) throw new Error('The image type does not match its bytes.');
  }
}

export function inspectYaml(bytes: Uint8Array) {
  const text = decoder.decode(bytes);
  // yaml v2 document API: https://eemeli.org/yaml/#parsing-documents
  // getIn(path, true): https://eemeli.org/yaml/#document-methods
  const doc = parseDocument(text, { keepSourceTokens: true, uniqueKeys: true });
  const errors = doc.errors.map(error => error.message);
  const warnings = doc.warnings.map(warning => warning.message);
  const name = errors.length ? undefined : doc.getIn(['name'], true);
  return { text, errors, warnings, name: name ? String(name) : '(no name key)' };
}

export function packProof(payload: ProofPayload): Uint8Array {
  validatePayload(payload);
  const manifest = {
    format: 'wavecraft-phase1-proof', version: 1,
    yaml: { name: payload.yamlName, bytes: payload.yaml.length },
    image: payload.image ? { name: payload.image.name, mime: payload.image.mime, bytes: payload.image.bytes.length } : null
  };
  const entries: Record<string, Uint8Array> = {
    'manifest.json': encoder.encode(JSON.stringify(manifest)), 'source.yaml': payload.yaml
  };
  if (payload.image) entries['evidence/image.bin'] = payload.image.bytes;
  // Synchronous ZIP APIs: https://github.com/101arrowz/fflate#usage
  return zipSync(entries, { level: 6 });
}

export function unpackProof(bytes: Uint8Array): ProofPayload {
  if (bytes.length > LIMITS.archive) throw new Error('The ZIP exceeds the 6 MiB proof limit.');
  const seen = new Set<string>();
  const declared = new Map<string, number>();
  // The filter exposes central-directory metadata before extraction.
  // API: https://github.com/101arrowz/fflate/blob/v0.8.3/src/index.ts
  // First collect metadata without inflating. Then extract the allowed entries.
  unzipSync(bytes, { filter(file) {
    if (!paths.includes(file.name)) throw new Error(`The ZIP entry is not allowed: ${file.name}`);
    if (seen.has(file.name)) throw new Error(`The ZIP entry occurs twice: ${file.name}`);
    seen.add(file.name);
    const limit = file.name === 'manifest.json' ? LIMITS.manifest : file.name === 'source.yaml' ? LIMITS.yaml : LIMITS.image;
    if (file.originalSize > limit) throw new Error(`The ZIP entry exceeds its proof limit: ${file.name}`);
    if (file.compression !== 0 && file.compression !== 8) throw new Error('The ZIP compression method is not supported.');
    declared.set(file.name, file.originalSize);
    return false;
  } });
  if (!seen.has('manifest.json') || !seen.has('source.yaml')) throw new Error('The ZIP requires manifest.json and source.yaml.');
  const files = unzipSync(bytes, { filter: file => seen.has(file.name) });
  for (const [name, length] of declared) {
    if (files[name]?.length !== length) throw new Error(`The ZIP entry size does not match: ${name}`);
  }
  const manifest = JSON.parse(decoder.decode(files['manifest.json']));
  if (manifest?.format !== 'wavecraft-phase1-proof' || manifest?.version !== 1) throw new Error('The ZIP proof format or version is not supported.');
  if (!manifest.yaml || manifest.yaml.bytes !== files['source.yaml'].length) throw new Error('The YAML size does not match the manifest.');
  if (Boolean(manifest.image) !== seen.has('evidence/image.bin')) throw new Error('The image entry does not match the manifest.');
  if (manifest.image && manifest.image.bytes !== files['evidence/image.bin'].length) throw new Error('The image size does not match the manifest.');
  const payload: ProofPayload = {
    yamlName: manifest.yaml.name, yaml: files['source.yaml'],
    ...(manifest.image ? { image: { name: manifest.image.name, mime: manifest.image.mime, bytes: files['evidence/image.bin'] } } : {})
  };
  validatePayload(payload);
  return payload;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function comparePayload(a: ProofPayload, b: ProofPayload) {
  return {
    yamlBytes: equalBytes(a.yaml, b.yaml),
    imageBytes: a.image && b.image ? equalBytes(a.image.bytes, b.image.bytes) : !a.image && !b.image,
    namesAndTypes: a.yamlName === b.yamlName && a.image?.name === b.image?.name && a.image?.mime === b.image?.mime
  };
}

export type Matrix2D = { a: number; b: number; c: number; d: number; e: number; f: number };

export function validateMatrix(matrix: Matrix2D): void {
  const values = [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f];
  if (!values.every(Number.isFinite) || !Number.isFinite(matrix.a * matrix.d - matrix.b * matrix.c) || matrix.a * matrix.d - matrix.b * matrix.c === 0) {
    throw new Error('The screen transform is not finite or invertible.');
  }
}

// This pure reference supports tests. The browser uses the native inverse API.
export function invertPoint(matrix: Matrix2D, x: number, y: number) {
  validateMatrix(matrix);
  if (![x, y].every(Number.isFinite)) throw new Error('The pointer coordinates are not finite.');
  const det = matrix.a * matrix.d - matrix.b * matrix.c;
  const result = { x: (matrix.d * (x - matrix.e) - matrix.c * (y - matrix.f)) / det,
    y: (-matrix.b * (x - matrix.e) + matrix.a * (y - matrix.f)) / det };
  if (![result.x, result.y].every(Number.isFinite)) throw new Error('The mapped coordinates are not finite.');
  return result;
}
