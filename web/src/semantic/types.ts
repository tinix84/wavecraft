export type Quantity = string;
export type Count = number | 'continuous';
export type Clock = { period: Quantity; frequency?: never } | { frequency: Quantity; period?: never };
export type Signal = { dimension: 'current' | 'voltage'; nominal?: Quantity; initial: Quantity };
export type Hold = { id: string; kind: 'hold'; duration: Quantity };
export type Ramp = { id: string; kind: 'ramp'; to: Quantity; duration?: Quantity; slew?: Quantity; maxSlew?: Quantity; arriveAt?: Quantity };
export type Points = { id: string; kind: 'points'; points: { id: string; time: Quantity; value: Quantity }[] };
export type LeafSegment = Hold | Ramp | Points;
export type Repeat = { id: string; kind: 'repeat'; pattern: LeafSegment[]; count: Count; outer?: Clock & { count: Count } } & Clock;
export type AuthoringDocument = { schema: 'wavecraft/1'; name: string; signal: Signal; segments: (LeafSegment | Repeat)[] };
export type SourcePath = (string | number)[];
export type SourceRef = { id?: string; path: SourcePath; range?: [number, number, number] };
export type Diagnostic = { code: string; severity: 'error' | 'warning'; message: string; source: SourceRef; values?: Record<string, string | number>; suggestion?: string };
export type Point = [timeS: number, value: number];
export type Timing = { startS: number; endS: number; durationS: number; requestedArrivalS?: number; previousId?: string };
export type CompiledLeaf = {
  kind: 'hold' | 'ramp' | 'points' | 'idle'; id: string; source: SourceRef; timing: Timing;
  points: Point[]; derived?: boolean; resolvedSlew?: number; pointSources?: SourceRef[]; roundoffCanonicalized?: boolean;
};
export type CompiledRepeat = {
  kind: 'repeat'; id: string; source: SourceRef; timing: Timing; pattern: CompiledLeaf[];
  patternDurationS: number; periodS: number; frequencyHz: number; count: Count; activeSpanS: number;
  outer?: { periodS: number; frequencyHz: number; count: Count };
};
export type CompiledWaveform = { dimension: 'current' | 'voltage'; initialValue: number; finalValue: number; durationS: number; continuous: boolean; nodes: (CompiledLeaf | CompiledRepeat)[] };
export type CompileResult = { ok: true; document: AuthoringDocument; compiled: CompiledWaveform; diagnostics: Diagnostic[] } | { ok: false; diagnostics: Diagnostic[] };
export type ExpansionResult = { ok: true; points: Point[]; horizonS: number; diagnostics: Diagnostic[] } | { ok: false; diagnostics: Diagnostic[] };
export const SEMANTIC_LIMITS = { sourceBytes: 1024 * 1024, authoredItems: 10_000, expandedPoints: 100_000, depth: 32 };
