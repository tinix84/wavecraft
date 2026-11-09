import type { CsvMapping, Pair } from './types.ts';
import { DIGITIZE_LIMITS, factors, fail, keys, finite, text } from './validation.ts';

export function validateMapping(m: CsvMapping): void {
  keys(m, ['dimension', 'timeUnit', 'valueUnit', 'xColumn', 'yColumn', 'delimiter', 'decimal', 'header', 'confirmed']); factors(m);
  if (m.confirmed !== true || typeof m.header !== 'boolean' || ![',', ';', '\t'].includes(m.delimiter) || !['.', ','].includes(m.decimal) || ![m.xColumn, m.yColumn].every(n => Number.isSafeInteger(n) && n >= 0 && n < 256) || m.xColumn === m.yColumn) fail('Confirm distinct CSV columns, delimiter, decimal mark, header, and units.');
}
export function parseCsv(source: string, m: CsvMapping): Pair[] {
  validateMapping(m); if (!text(source, DIGITIZE_LIMITS.csvBytes)) fail('Use valid UTF-8 CSV text with at most 1 MiB.');
  const s = source.replace(/^\uFEFF/, ''), rows: string[][] = []; let row: string[] = [], cell = '', state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  const field = () => { row.push(cell); cell = ''; state = 'start'; if (row.length > 256) fail('The CSV exceeds 256 columns.'); };
  const line = () => { field(); rows.push(row); row = []; if (rows.length > DIGITIZE_LIMITS.rows + (m.header ? 1 : 0)) fail('The CSV exceeds 10000 data rows.'); };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (state === 'quoted') { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else state = 'closed'; } else cell += c; continue; }
    if (c === m.delimiter) { field(); continue; }
    if (c === '\r' || c === '\n') { if (c === '\r' && s[i + 1] === '\n') i++; line(); continue; }
    if (state === 'closed') fail('A quoted CSV cell contains text after its closing quote.');
    if (c === '"') { if (state !== 'start') fail('A CSV quote must start a cell.'); state = 'quoted'; }
    else { cell += c; state = 'plain'; }
  }
  if (state === 'quoted') fail('A quoted CSV cell is incomplete.');
  if (cell || row.length || state !== 'start') line();
  const width = rows[0]?.length ?? 0, data = rows.slice(m.header ? 1 : 0), f = factors(m);
  if (data.length < 2 || width <= Math.max(m.xColumn, m.yColumn) || rows.some(r => r.length !== width)) fail('Use at least two CSV rows with the selected columns and a consistent column count.');
  const number = (value: string, factor: number, rowIndex: number): number => {
    const raw = value.trim(), normalized = m.decimal === ',' ? raw.replace(',', '.') : raw;
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized) || (m.decimal === ',' && raw.includes('.'))) fail(`The selected CSV value is invalid at data row ${rowIndex + 1}.`);
    const n = Number(normalized), result = n * factor;
    if (!finite(result) || (/[1-9]/.test(normalized.split(/[eE]/)[0]) && (n === 0 || result === 0))) fail(`The selected CSV value exceeds the finite range at data row ${rowIndex + 1}.`); return result;
  };
  return data.map((r, i) => [number(r[m.xColumn], f[0], i), number(r[m.yColumn], f[1], i)]);
}
