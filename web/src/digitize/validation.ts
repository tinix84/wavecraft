import { parseQuantity } from '../semantic/units.ts';
import type { Pair, Units } from './types.ts';

export const DIGITIZE_LIMITS = Object.freeze({ csvBytes: 1024 * 1024, rows: 10_000, textBytes: 65536, alignmentPixels: 1 });
export const fail = (message: string): never => { throw new Error(message); };
export const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
export const pair = (p: unknown): p is Pair => Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1]);
export function keys(o: any, allowed: string[], required = allowed): void {
  const p = o && typeof o === 'object' ? Object.getPrototypeOf(o) : null;
  const plain = p === Object.prototype || p && Object.getPrototypeOf(p) === null && Object.hasOwn(p, 'constructor') && typeof p.constructor === 'function' && p.constructor.prototype === p && Function.prototype.toString.call(p.constructor) === Function.prototype.toString.call(Object);
  if (!plain || Object.keys(o).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(o, k))) fail('The extraction record fields are invalid.');
}
export function text(s: unknown, max = DIGITIZE_LIMITS.textBytes): s is string { return typeof s === 'string' && new TextEncoder().encode(s).length <= max && new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(s)) === s; }
export function factors(u: Units): Pair {
  if (!['current', 'voltage'].includes(u.dimension) || typeof u.timeUnit !== 'string' || typeof u.valueUnit !== 'string') fail('Confirm the time unit and signal unit.');
  return [parseQuantity(`1 ${u.timeUnit}`, 'time'), parseQuantity(`1 ${u.valueUnit}`, u.dimension)];
}
export function boundedPixel(p: Pair, size: Pair): void {
  if (!pair(p) || p.some((n, i) => n < 0 || n > size[i])) fail('Select a point inside the original image.');
}
