import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml';
import { compileWithSource } from './compiler.ts';
import { SEMANTIC_LIMITS } from './types.ts';
import type { CompileResult, Diagnostic, SourcePath, SourceRef } from './types.ts';

export function compileYaml(text: string): CompileResult {
  const failure = (code: string, message: string, source: SourceRef = { path: [] }): CompileResult => ({ ok: false, diagnostics: [{ code, severity: 'error', message, source }] });
  if (typeof text !== 'string' || text.length > SEMANTIC_LIMITS.sourceBytes || new TextEncoder().encode(text).length > SEMANTIC_LIMITS.sourceBytes) return failure('RESOURCE_LIMIT', 'The YAML source exceeds the 1 MiB limit.');
  try {
    const doc = parseDocument(text, { keepSourceTokens: true, strict: true, uniqueKeys: true });
    if (doc.errors.length) return { ok: false, diagnostics: doc.errors.map(error => ({ code: 'YAML_SYNTAX', severity: 'error', message: error.message, source: { path: [], range: [error.pos[0], error.pos[1], error.pos[1]] } })) };
    const stack: { node: unknown; path: SourcePath; depth: number }[] = [{ node: doc.contents, path: [], depth: 0 }];
    let visited = 0;
    while (stack.length) {
      const { node, path, depth } = stack.pop()!;
      const range = isNode(node) && node.range ? [...node.range] as [number, number, number] : undefined;
      if (depth > SEMANTIC_LIMITS.depth || ++visited > SEMANTIC_LIMITS.authoredItems * 16) return failure('RESOURCE_LIMIT', 'The YAML structure exceeds the depth or node limit.', { path, range });
      if (isAlias(node)) return failure('YAML_ALIAS', 'Replace YAML aliases with explicit source values.', { path, range });
      if (isNode(node) && node.tag && !['str', 'int', 'float', 'bool', 'null', 'map', 'seq'].some(tag => node.tag === `tag:yaml.org,2002:${tag}`)) return failure('YAML_TAG', 'Custom YAML tags are not supported.', { path, range });
      if (isSeq(node)) {
        for (let i = node.items.length - 1; i >= 0; i--) stack.push({ node: node.items[i], path: [...path, i], depth: depth + 1 });
      } else if (isMap(node)) {
        for (const pair of node.items) {
          if (!isScalar(pair.key) || typeof pair.key.value !== 'string') return failure('SCHEMA', 'Use string mapping keys.', { path, range });
          stack.push({ node: pair.key, path: [...path, pair.key.value], depth: depth + 1 });
          stack.push({ node: pair.value, path: [...path, pair.key.value], depth: depth + 1 });
        }
      }
    }
    const link = (path: SourcePath, id?: string): SourceRef => {
      let node = doc.getIn(path, true);
      if (!isNode(node)) node = doc.getIn(path.slice(0, -1), true);
      return { path: [...path], ...(id ? { id } : {}), ...(isNode(node) && node.range ? { range: [...node.range] as [number, number, number] } : {}) };
    };
    const result = compileWithSource(doc.toJS({ maxAliasCount: 0 }), link);
    const warnings: Diagnostic[] = doc.warnings.map(warning => ({ code: 'YAML_WARNING', severity: 'warning', message: warning.message, source: { path: [], range: [warning.pos[0], warning.pos[1], warning.pos[1]] } }));
    return { ...result, diagnostics: [...result.diagnostics, ...warnings] };
  } catch {
    return failure('YAML_SYNTAX', 'The YAML source cannot be read as a bounded document.');
  }
}
