import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, deflateRawSync } from 'node:zlib';
import { checkDeflate } from '../src/project/deflate.ts';

function bits() {
  const data: number[] = []; let at = 0;
  return { add(value: number, count: number) { for (let i = 0; i < count; i++, at++) { const byte = at >>> 3; data[byte] ??= 0; data[byte] |= (value >>> i & 1) << (at & 7); } }, bytes: () => Uint8Array.from(data) };
}
test('bounded DEFLATE preflight accepts independent Node zlib stored, fixed, and dynamic streams', () => {
  let seed = 1234567;
  const random = (length: number) => Uint8Array.from({ length }, () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed >>> 24; });
  for (let i = 0; i < 300; i++) {
    const size = i < 30 ? i : 100 + (i * 137) % 65000;
    const data = i % 3 === 0 ? random(size) : Buffer.from('abcde12345_'.repeat(Math.ceil(size / 11)).slice(0, size));
    for (const options of [{ level: 0 }, { level: 1 }, { level: 6 }, { level: 9 }, { level: 6, strategy: constants.Z_FIXED }]) checkDeflate(deflateRawSync(data, options), data.length);
  }
});
test('DEFLATE preflight rejects trailing input, truncated blocks, reserved codes, and invalid stored complements', () => {
  const data = Buffer.from('independent-compressor-'.repeat(500)); const encoded = deflateRawSync(data);
  assert.throws(() => checkDeflate(Buffer.concat([encoded, Buffer.from([0])]), data.length), /invalid/);
  assert.throws(() => checkDeflate(encoded.subarray(0, -1), data.length), /invalid/);
  assert.throws(() => checkDeflate(Uint8Array.of(7), 0), /invalid/);
  const stored = deflateRawSync(data, { level: 0 }); stored[3] ^= 1;
  assert.throws(() => checkDeflate(stored, data.length), /invalid/);
  const backreference = bits(); backreference.add(3, 3); backreference.add(64, 7); backreference.add(0, 5);
  assert.throws(() => checkDeflate(backreference.bytes(), 3), /invalid/);
});
test('dynamic DEFLATE rejects a repeat without a previous length and excessive code length repeats', () => {
  const previous = bits(); previous.add(5, 3); previous.add(0, 5); previous.add(0, 5); previous.add(0, 4);
  for (const length of [1, 0, 0, 1]) previous.add(length, 3);
  previous.add(1, 1);
  assert.throws(() => checkDeflate(previous.bytes(), 0), /invalid/);
  const overflow = bits(); overflow.add(5, 3); overflow.add(0, 5); overflow.add(0, 5); overflow.add(0, 4);
  for (const length of [0, 0, 1, 1]) overflow.add(length, 3);
  for (let i = 0; i < 2; i++) { overflow.add(1, 1); overflow.add(127, 7); }
  assert.throws(() => checkDeflate(overflow.bytes(), 0), /invalid/);
});
test('declared output and work budgets reject expansion and repeated empty blocks before actual inflation', () => {
  const large = deflateRawSync(Buffer.alloc(16 * 1024 * 1024, 65));
  assert.throws(() => checkDeflate(large, 1), /decoded size/);
  const empty = bits();
  for (let i = 0; i < 10000; i++) { empty.add(i === 9999 ? 3 : 2, 3); empty.add(0, 7); }
  assert.throws(() => checkDeflate(empty.bytes(), 0), /4096-block limit/);
  const costly = bits(); costly.add(3, 3);
  for (let i = 0; i < 2 * 1024 * 1024; i++) costly.add(0x8e, 8);
  costly.add(0, 7);
  assert.throws(() => checkDeflate(costly.bytes(), 2 * 1024 * 1024), /work limit/);
});
