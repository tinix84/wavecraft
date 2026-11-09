import { isNode, isScalar, parseDocument, Scalar } from 'yaml';
import type { SourcePath } from '../semantic/index.ts';
import type { SourceEntry, ValidCompile } from './types.ts';

export const parseSource = (text: string) => parseDocument(text, { keepSourceTokens: true, strict: true, uniqueKeys: true });
export type SourceDocument = ReturnType<typeof parseSource>;

export function sourceEntries(doc: SourceDocument, result: ValidCompile): Map<string, SourceEntry> {
  const entries = new Map<string, SourceEntry>();
  const add = (id: string, path: SourcePath, ownerId: string, kind: string) => {
    const node = doc.getIn(path, true);
    entries.set(id, { id, path, ownerId, kind, ...(isNode(node) && node.range ? { range: [...node.range] as [number, number, number] } : {}) });
  };
  const leaves = (segments: typeof result.document.segments, path: SourcePath) => segments.forEach((segment, index) => {
    const p = [...path, index];
    add(segment.id, p, segment.id, segment.kind);
    if (segment.kind === 'points') segment.points.forEach((point, i) => add(point.id, [...p, 'points', i], segment.id, 'point'));
    if (segment.kind === 'repeat') leaves(segment.pattern, [...p, 'pattern']);
  });
  leaves(result.document.segments, ['segments']);
  for (const node of result.compiled.nodes) {
    for (const leaf of node.kind === 'repeat' ? node.pattern : [node]) {
      if (leaf.derived && !entries.has(leaf.id)) add(leaf.id, [...leaf.source.path], leaf.source.id ?? node.id, leaf.kind);
    }
  }
  return entries;
}

// Each replacement uses the current parsed range, including its original quote style.
export function replaceScalars(source: string, doc: SourceDocument, edits: { path: SourcePath; value: string | number }[]): string | undefined {
  const replacements: { start: number; end: number; token: string }[] = [];
  for (const { path, value } of edits) {
    const node = doc.getIn(path, true);
    if (!isScalar(node) || !node.range || ![Scalar.PLAIN, Scalar.QUOTE_SINGLE, Scalar.QUOTE_DOUBLE].includes(node.type!)) return undefined;
    let token: string;
    if (node.type === Scalar.QUOTE_SINGLE && typeof value === 'string') token = `'${value.replaceAll("'", "''")}'`;
    else if (node.type === Scalar.QUOTE_DOUBLE && typeof value === 'string') token = JSON.stringify(value);
    else {
      token = String(value);
      const parsed = parseSource(token);
      if (parsed.errors.length || !isScalar(parsed.contents) || parsed.contents.value !== value) token = JSON.stringify(value);
    }
    const check = parseSource(token);
    if (check.errors.length || !isScalar(check.contents) || check.contents.value !== value) return undefined;
    const [start, end] = node.range;
    if (start < 0 || end < start || end > source.length) return undefined;
    replacements.push({ start, end, token });
  }
  let candidate = source;
  for (const { start, end, token } of replacements.sort((a, b) => b.start - a.start)) candidate = candidate.slice(0, start) + token + candidate.slice(end);
  return candidate;
}

export function serializeSource(doc: SourceDocument, original: string): string {
  let text = doc.toString({ lineWidth: 0 });
  if (original.includes('\r\n')) text = text.replace(/\r?\n/g, '\r\n');
  if (original.startsWith('\uFEFF') && !text.startsWith('\uFEFF')) text = '\uFEFF' + text;
  return text;
}
