export type QuantityKind = 'time' | 'current' | 'voltage' | 'frequency' | 'currentSlew' | 'voltageSlew';

const time: Record<string, number> = { s: 1, ms: 1e-3, us: 1e-6, 'µs': 1e-6, 'μs': 1e-6, ns: 1e-9, ps: 1e-12 };
const current: Record<string, number> = { A: 1, kA: 1e3, mA: 1e-3, uA: 1e-6, 'µA': 1e-6, 'μA': 1e-6, nA: 1e-9 };
const voltage: Record<string, number> = { V: 1, kV: 1e3, mV: 1e-3, uV: 1e-6, 'µV': 1e-6, 'μV': 1e-6 };
const frequency: Record<string, number> = { Hz: 1, kHz: 1e3, MHz: 1e6, GHz: 1e9 };
const numberPattern = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const quantityPattern = new RegExp(`^(${numberPattern})\\s*([A-Za-zµμ]+)(?:\\s*\\/\\s*([A-Za-zµμ]+))?$`);
const percentPattern = new RegExp(`^(${numberPattern})\\s*%$`);

export class QuantityError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

function finiteNumber(raw: string, factor = 1): number {
  const literal = Number(raw);
  const result = literal * factor;
  const nonzero = /[1-9]/.test(raw.split(/[eE]/)[0]);
  if (!Number.isFinite(result) || (nonzero && (literal === 0 || (factor !== 0 && result === 0)))) {
    throw new QuantityError('QUANTITY_RANGE', 'The quantity exceeds the finite numeric range.');
  }
  return result;
}

export function parseQuantity(raw: unknown, kind: QuantityKind): number {
  if (typeof raw !== 'string' || raw.length > 128) throw new QuantityError('QUANTITY', 'Use a quantity string with an explicit unit.');
  const match = quantityPattern.exec(raw.trim());
  if (!match) throw new QuantityError('QUANTITY', 'Use a decimal quantity with a supported unit.');
  let factor: number | undefined;
  if (kind === 'currentSlew' || kind === 'voltageSlew') {
    const numerator = (kind === 'currentSlew' ? current : voltage)[match[2]];
    const denominator = time[match[3] ?? ''];
    if (numerator !== undefined && denominator !== undefined) factor = numerator / denominator;
  } else if (!match[3]) {
    factor = ({ time, current, voltage, frequency }[kind])[match[2]];
  }
  if (factor === undefined) throw new QuantityError('DIMENSION', `Use a supported ${kind} unit.`);
  return finiteNumber(match[1], factor);
}

export function resolveLevel(raw: unknown, dimension: 'current' | 'voltage', nominal?: number): number {
  if (typeof raw === 'string' && raw.length > 128) throw new QuantityError('QUANTITY', 'Use a quantity string of at most 128 characters.');
  if (typeof raw === 'string') {
    const percent = percentPattern.exec(raw.trim());
    if (percent) {
      if (nominal === undefined) throw new QuantityError('NOMINAL_REQUIRED', 'Declare a nominal level before you use a percentage.');
      const value = finiteNumber(percent[1]);
      const product = value * nominal;
      const resolved = Number.isFinite(product) ? product / 100 : (value / 100) * nominal;
      if (!Number.isFinite(resolved) || (value !== 0 && nominal !== 0 && resolved === 0)) throw new QuantityError('QUANTITY_RANGE', 'The percentage result exceeds the finite numeric range.');
      return resolved;
    }
  }
  return parseQuantity(raw, dimension);
}
