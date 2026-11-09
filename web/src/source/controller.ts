import { compileYaml } from '../semantic/index.ts';
import type { CompiledLeaf, CompiledRepeat, Diagnostic, Timing } from '../semantic/index.ts';
import { commandSource, EditFailure } from './commands.ts';
import { parseSource, sourceEntries } from './document.ts';
import type { SourceDocument } from './document.ts';
import type { CommandResult, EditCommand, EditProposal, ProposalResult, RecoveryState, SourceEntry, TimingChange, ValidCompile } from './types.ts';
export type * from './types.ts';

type Snapshot = { source: string; result?: ValidCompile; doc?: SourceDocument; entries: Map<string, SourceEntry> };
type History = { before: Snapshot; after: Snapshot; beforeSelection: string | null; afterSelection: string | null };
const failure = (code: string, message: string): { ok: false; diagnostics: Diagnostic[] } => ({ ok: false, diagnostics: [{ code, severity: 'error', message, source: { path: [] } }] });
const clone = <T>(value: T): T => structuredClone(value);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function snapshot(source: string, result: ValidCompile): Snapshot {
  const doc = parseSource(source);
  return { source, result: freeze(result), doc, entries: sourceEntries(doc, result) };
}

function timings(result: ValidCompile): Map<string, Timing> {
  const records = new Map<string, Timing>();
  const add = (node: CompiledLeaf | CompiledRepeat) => {
    records.set(node.id, node.timing);
    if (node.kind === 'repeat') node.pattern.forEach(add);
  };
  result.compiled.nodes.forEach(add);
  return records;
}

function timingChanges(before: ValidCompile, after: ValidCompile): TimingChange[] {
  const old = timings(before), changes: TimingChange[] = [];
  for (const [id, timing] of timings(after)) {
    const previous = old.get(id);
    if (previous && Object.keys({ ...previous, ...timing }).some(key => previous[key as keyof Timing] !== timing[key as keyof Timing])) changes.push({ id, before: clone(previous), after: clone(timing) });
  }
  return changes;
}

export class SemanticController {
  #committed: Snapshot = { source: '', entries: new Map() };
  #draft: string | null = null;
  #diagnostics: Diagnostic[] = [];
  #selection: string | null = null;
  #revision = 0;
  #draftGeneration = 0;
  #undo: History[] = [];
  #redo: History[] = [];
  #proposals = new WeakMap<EditProposal, { revision: number; generation: number; candidate: Snapshot }>();

  constructor(source?: string) {
    if (source !== undefined) {
      const result = compileYaml(source);
      if (result.ok) this.#committed = snapshot(source, result);
      else { this.#draft = source; this.#diagnostics = result.diagnostics; }
    }
  }

  get source(): string { return this.#draft ?? this.#committed.source; }
  get committedSource(): string { return this.#committed.source; }
  get result(): ValidCompile | undefined { return this.#committed.result; }
  get diagnostics(): Diagnostic[] { return clone(this.#diagnostics); }
  get dirty(): boolean { return this.#draft !== null; }
  get selectionId(): string | null { return this.#selection; }
  get revision(): number { return this.#revision; }
  get canUndo(): boolean { return this.#undo.length > 0; }
  get canRedo(): boolean { return this.#redo.length > 0; }
  get sourceMap(): Map<string, SourceEntry> { return clone(this.#committed.entries); }

  setDraft(text: string): void {
    this.#draft = text === this.#committed.source && this.#committed.result ? null : text;
    this.#draftGeneration++;
    this.#diagnostics = this.#draft === null ? clone(this.#committed.result!.diagnostics) : compileYaml(text).diagnostics;
  }

  applyDraft(): CommandResult {
    if (this.#draft === null) return { ok: true };
    const result = compileYaml(this.#draft);
    this.#diagnostics = result.diagnostics;
    if (!result.ok) return { ok: false, diagnostics: clone(result.diagnostics) };
    this.#accept(snapshot(this.#draft, result));
    return { ok: true };
  }

  restoreDraft(): void {
    this.#draft = null;
    this.#draftGeneration++;
    this.#diagnostics = clone(this.#committed.result?.diagnostics ?? []);
  }

  select(id: string | null): void {
    const entry = id === null ? undefined : this.#committed.entries.get(id);
    this.#selection = entry ? entry.ownerId : null;
    if (entry?.kind === 'point') this.#selection = entry.id;
  }

  propose(command: EditCommand): ProposalResult {
    if (this.dirty) return failure('DRAFT_PENDING', 'Apply or restore the source draft before an edit.');
    const before = this.#committed;
    if (!before.result || !before.doc) return failure('SOURCE_REQUIRED', 'Apply a valid semantic source before an edit.');
    try {
      const candidate = commandSource(before.source, before.doc, before.result, before.entries, command);
      const result = compileYaml(candidate.source);
      if (!result.ok) return { ok: false, diagnostics: result.diagnostics };
      const next = snapshot(candidate.source, result);
      const proposal: EditProposal = { baseRevision: this.#revision, source: candidate.source, result: clone(result), changes: timingChanges(before.result, result), warnings: [...candidate.warnings] };
      this.#proposals.set(proposal, { revision: this.#revision, generation: this.#draftGeneration, candidate: next });
      return { ok: true, proposal };
    } catch (error) {
      if (error instanceof EditFailure) return { ok: false, diagnostics: error.diagnostics };
      return failure('EDIT_COMMAND', 'The edit command cannot produce a valid source candidate.');
    }
  }

  commitProposal(proposal: EditProposal): CommandResult {
    if (this.dirty) return failure('DRAFT_PENDING', 'Apply or restore the source draft before an edit.');
    const trusted = this.#proposals.get(proposal);
    if (!trusted || proposal.baseRevision !== trusted.revision || trusted.revision !== this.#revision || trusted.generation !== this.#draftGeneration) return failure('STALE_PROPOSAL', 'Create a new edit proposal for the current source revision.');
    this.#proposals.delete(proposal);
    this.#accept(trusted.candidate);
    return { ok: true };
  }

  undo(): CommandResult { return this.#travel(this.#undo, this.#redo, false); }
  redo(): CommandResult { return this.#travel(this.#redo, this.#undo, true); }

  exportSource(): string {
    if (this.dirty || !this.#committed.result) throw new Error('Apply or restore the source draft before export.');
    return this.#committed.source;
  }

  exportRecovery(): RecoveryState {
    return { version: 1, committedSource: this.#committed.source, draft: this.#draft, selectionId: this.#selection };
  }

  restoreRecovery(state: RecoveryState): CommandResult {
    if (!state || state.version !== 1 || typeof state.committedSource !== 'string' || !(state.draft === null || typeof state.draft === 'string') || !(state.selectionId === null || typeof state.selectionId === 'string')) return failure('RECOVERY', 'Use a valid semantic recovery snapshot.');
    const result = compileYaml(state.committedSource);
    // An empty committed source represents a session with no valid revision yet.
    if (!result.ok && (state.committedSource !== '' || state.draft === null)) return { ok: false, diagnostics: result.diagnostics };
    const next = result.ok ? snapshot(state.committedSource, result) : { source: '', entries: new Map<string, SourceEntry>() };
    this.#committed = next;
    this.#draft = state.draft;
    this.#selection = state.selectionId;
    this.#retainSelection();
    this.#diagnostics = this.#draft === null ? clone(result.diagnostics) : compileYaml(this.#draft).diagnostics;
    this.#undo = []; this.#redo = [];
    this.#revision++; this.#draftGeneration++;
    return { ok: true };
  }

  #accept(next: Snapshot): void {
    const beforeSelection = this.#selection;
    const before = this.#committed;
    this.#committed = next;
    this.#retainSelection();
    if (before.result) this.#undo.push({ before, after: next, beforeSelection, afterSelection: this.#selection });
    this.#redo = [];
    this.#draft = null;
    this.#diagnostics = clone(next.result!.diagnostics);
    this.#revision++; this.#draftGeneration++;
  }

  #travel(from: History[], to: History[], forward: boolean): CommandResult {
    if (this.dirty) return failure('DRAFT_PENDING', 'Apply or restore the source draft before undo or redo.');
    const entry = from.at(-1);
    if (!entry) return failure('HISTORY_EMPTY', 'No source revision is available in this direction.');
    from.pop(); to.push(entry);
    this.#committed = forward ? entry.after : entry.before;
    this.#selection = forward ? entry.afterSelection : entry.beforeSelection;
    this.#retainSelection();
    this.#diagnostics = clone(this.#committed.result?.diagnostics ?? []);
    this.#revision++; this.#draftGeneration++;
    return { ok: true };
  }

  #retainSelection(): void {
    if (this.#selection && !this.#committed.entries.has(this.#selection)) this.#selection = null;
  }
}
