import type { Digitization } from '../digitize/types.ts';
export type ProjectImage = { name: string; mime: 'image/png' | 'image/jpeg' | 'image/webp'; bytes: Uint8Array };
export type ProjectEvidence = {
  image?: ProjectImage;
  rawPoints?: [number, number][];
  calibration?: { low: [number, number] | null; high: [number, number] | null; x0: number; x1: number; y0: number; y1: number };
  corrections?: { index: number; point: [number, number]; note: string }[];
  notes?: string;
  transforms?: { originalSize: [number, number]; viewSize: [number, number]; crop: [number, number, number, number] | null; reference?: 'sample' | 'image' | 'unavailable' };
  digitization?: Digitization;
};
export type ProjectSnapshot = { revisionId: string; mode: 'semantic' | 'points'; source: string; evidence: ProjectEvidence };
export type RecoveryDraft = { text: string | null; selection: string | number | null };
export type ProjectRecoveryRecord = { version: 1; savedAt: string; snapshot: ProjectSnapshot; draft: RecoveryDraft };
export type RecoveryOptions = { factory?: IDBFactory; expectedHead?: string | null; denied?: boolean };
