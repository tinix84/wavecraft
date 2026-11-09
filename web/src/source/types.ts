import type { Clock, CompileResult, Count, Diagnostic, LeafSegment, Repeat, SourcePath, Timing } from '../semantic/index.ts';

export type ValidCompile = Extract<CompileResult, { ok: true }>;
export type EditCommand =
  | { type: 'batch'; commands: Exclude<EditCommand, { type: 'batch' }>[] }
  | { type: 'target'; id: string; value: string }
  | { type: 'nominal'; value: string }
  | { type: 'initial'; value: string }
  | { type: 'max-slew'; id: string; value: string | null }
  | { type: 'insert-point'; id: string; point: { id: string; time: string; value: string }; beforeId?: string }
  | { type: 'remove-point'; id: string }
  | { type: 'wrap-repeat'; ids: string[]; repeat: { id: string; count: Count; period?: string; frequency?: string; outer?: Clock & { count: Count } } }
  | { type: 'ramp-control'; id: string; control: 'duration' | 'slew'; value: string }
  | { type: 'timing'; id: string; arriveAt: string | null }
  | { type: 'hold-duration'; id: string; value: string }
  | { type: 'point'; id: string; time?: string; value?: string }
  | { type: 'repeat-clock'; id: string; level: 'inner' | 'outer'; control: 'period' | 'frequency'; value: string }
  | { type: 'repeat-count'; id: string; level: 'inner' | 'outer'; count: Count }
  | { type: 'flatten'; id: string; scope?: 'segment' | 'pattern' }
  | { type: 'insert-segment'; segment: LeafSegment | Repeat; beforeId?: string; parentId?: string }
  | { type: 'remove-segment'; id: string };
export type SourceEntry = { id: string; path: SourcePath; range?: [number, number, number]; ownerId: string; kind: string };
export type TimingChange = { id: string; before: Timing; after: Timing };
export type EditProposal = { baseRevision: number; source: string; result: ValidCompile; changes: TimingChange[]; warnings: string[] };
export type ProposalResult = { ok: true; proposal: EditProposal } | { ok: false; diagnostics: Diagnostic[] };
export type CommandResult = { ok: true } | { ok: false; diagnostics: Diagnostic[] };
export type RecoveryState = { version: 1; committedSource: string; draft: string | null; selectionId: string | null };
