// Validate the DEFLATE output budget and consumed span before fflate allocates output.
// RFC 1951 defines the bit order, Huffman trees, lengths, and distances.
export const DEFLATE_LIMITS = Object.freeze({ blocks: 4096, work: 32 * 1024 * 1024 });
export function checkDeflate(data: Uint8Array, expected: number): void {
  let bit = 0, output = 0;
  let work = 0;
  const spend = (count = 1) => { work += count; if (work > DEFLATE_LIMITS.work) throw new Error('The ZIP DEFLATE validation exceeds its work limit.'); };
  const invalid = (): never => { throw new Error('The ZIP DEFLATE stream or decoded size is invalid.'); };
  const read = (count: number): number => {
    spend(count + 1);
    if (bit + count > data.length * 8) invalid();
    let value = 0;
    for (let i = 0; i < count; i++, bit++) value |= (data[bit >>> 3] >>> (bit & 7) & 1) << i;
    return value;
  };
  const add = (count: number) => { output += count; if (output > expected) invalid(); };
  const tree = (lengths: number[], kind: 'codes' | 'literals' | 'distances') => {
    spend(lengths.length * 16);
    const counts = new Array(16).fill(0), next = new Array(16).fill(0), tables = Array.from({ length: 16 }, () => new Map<number, number>());
    for (const length of lengths) { if (length < 0 || length > 15) invalid(); if (length) counts[length]++; }
    let code = 0, slots = 1;
    for (let length = 1; length <= 15; length++) {
      slots = slots * 2 - counts[length]; if (slots < 0) invalid();
      code = (code + counts[length - 1]) << 1; next[length] = code;
    }
    const maximum = Math.max(...lengths);
    if (slots > 0 && (kind === 'codes' || maximum !== 1) && !(kind === 'distances' && maximum === 0)) invalid();
    for (let symbol = 0; symbol < lengths.length; symbol++) {
      const length = lengths[symbol]; if (!length) continue;
      let forward = next[length]++, reversed = 0;
      for (let i = 0; i < length; i++) { reversed = reversed << 1 | forward & 1; forward >>>= 1; }
      tables[length].set(reversed, symbol);
    }
    return () => {
      let code = 0;
      for (let length = 1; length <= 15; length++) { code |= read(1) << (length - 1); const value = tables[length].get(code); if (value !== undefined) return value; }
      return invalid();
    };
  };
  const lengthBase = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const lengthExtra = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const distanceBase = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const distanceExtra = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const fixedLiteralLengths = Array.from({ length: 288 }, (_, i) => i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8);
  const fixedLiteral = tree(fixedLiteralLengths, 'literals'), fixedDistance = tree(new Array(32).fill(5), 'distances');
  let final: number, blocks = 0;
  do {
    if (++blocks > DEFLATE_LIMITS.blocks) throw new Error('The ZIP DEFLATE stream exceeds its 4096-block limit.');
    final = read(1); const kind = read(2);
    if (kind === 0) {
      bit = Math.ceil(bit / 8) * 8; const length = read(16), complement = read(16);
      if ((length ^ complement) !== 65535 || bit + length * 8 > data.length * 8) invalid();
      add(length); bit += length * 8; continue;
    }
    if (kind === 3) invalid();
    let literals: number[], distances: number[];
    if (kind === 1) {
      literals = fixedLiteralLengths; distances = [];
    } else {
      const literalCount = read(5) + 257, distanceCount = read(5) + 1, count = read(4) + 4;
      if (literalCount > 286) invalid();
      const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
      const codeLengths = new Array(19).fill(0);
      for (let i = 0; i < count; i++) codeLengths[order[i]] = read(3);
      const decodeLength = tree(codeLengths, 'codes'), lengths: number[] = [];
      while (lengths.length < literalCount + distanceCount) {
        const symbol = decodeLength();
        if (symbol < 16) lengths.push(symbol);
        else {
          if (symbol === 16 && !lengths.length) invalid();
          const repeated = symbol === 16 ? lengths.at(-1)! : 0, repeat = symbol === 16 ? read(2) + 3 : symbol === 17 ? read(3) + 3 : read(7) + 11;
          if (lengths.length + repeat > literalCount + distanceCount) invalid();
          for (let i = 0; i < repeat; i++) lengths.push(repeated);
        }
      }
      literals = lengths.slice(0, literalCount); distances = lengths.slice(literalCount);
    }
    if (!literals[256]) invalid();
    const literal = kind === 1 ? fixedLiteral : tree(literals, 'literals'), distance = kind === 1 ? fixedDistance : tree(distances, 'distances');
    for (;;) {
      const symbol = literal();
      if (symbol < 256) { add(1); continue; }
      if (symbol === 256) break;
      const index = symbol - 257; if (index < 0 || index >= lengthBase.length) invalid();
      const length = lengthBase[index] + read(lengthExtra[index]), distanceSymbol = distance();
      if (distanceSymbol >= distanceBase.length) invalid();
      const offset = distanceBase[distanceSymbol] + read(distanceExtra[distanceSymbol]);
      if (offset > output) invalid();
      add(length);
    }
  } while (!final);
  if (output !== expected || Math.ceil(bit / 8) !== data.length) invalid();
}
