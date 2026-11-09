export type Pair = [number, number];
export type Units = { dimension: 'current' | 'voltage'; timeUnit: string; valueUnit: string };
export type Landmark = { pixel: Pair; value: number };
export type Calibration = Units & {
  axes: 'linear'; rotation: 'axis-aligned'; x: [Landmark, Landmark]; y: [Landmark, Landmark];
  method?: 'four-landmarks' | 'two-corners'; originalCorners?: [Pair, Pair];
  tick: { axis: 'x' | 'y'; pixel: Pair; value: number; tolerance: number };
};
export type CsvMapping = Units & { xColumn: number; yColumn: number; delimiter: ',' | ';' | '\t'; decimal: '.' | ','; header: boolean; confirmed: true };
export type Extraction = { kind: 'image'; size: Pair; calibration: Calibration; pixels: Pair[] } | { kind: 'csv'; name: string; text: string; mapping: CsvMapping };
export type Digitization = {
  extraction: Extraction; corrections: { index: number; point: Pair; note: string }[]; assumptions: string;
  initialHoldConfirmed?: boolean; finiteEdgesConfirmed?: boolean;
  provenance?: { article?: string; page?: string; figure?: string; series?: string; notes?: string };
  view?: { zoom: number; displaySize: Pair };
};
export type ImageView = { originalSize: Pair; viewSize: Pair; crop: [number, number, number, number] | null };
export type Matrix = { a: number; b: number; c: number; d: number; e: number; f: number };
