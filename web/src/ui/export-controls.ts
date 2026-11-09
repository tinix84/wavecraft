import { zipSync, strToU8 } from 'fflate';
import type { ExportResult } from '../export/index.ts';

export function exportPreview(result: Extract<ExportResult, {ok:true}>) {
  return result.artifacts.map(file => result.artifacts.length === 1 ? file.content : `===== ${file.filename} =====\n${file.content}`).join('\n');
}

export function exportDownload(result: Extract<ExportResult, {ok:true}>, name: string) {
  if (result.artifacts.length === 1) {
    const file = result.artifacts[0];
    return {filename:file.filename, blob:new Blob([file.content], {type:file.mimeType})};
  }
  const files = Object.fromEntries(result.artifacts.map(file => [file.filename, strToU8(file.content)]));
  return {filename:`${name.replace(/[^a-zA-Z0-9_-]/g,'_') || 'waveform'}-export.zip`, blob:new Blob([zipSync(files, {level:6})], {type:'application/zip'})};
}

export function exportSummary(result: Extract<ExportResult, {ok:true}>) {
  const m = result.metadata, unit = m.dimension === 'voltage' ? 'V' : 'A';
  const description = m.representation === 'uniform-samples'
    ? `Uniform grid: 0, Δt, 2Δt…; Δt ${m.sampleIntervalS} s. Last sample: ${m.lastSampleS} s. The terminal time appears only on the grid.`
    : m.representation === 'compact-repeat' ? 'Compact target repetition retains the declared clocks.' : 'Exact breakpoints retain the terminal point.';
  return `${m.dimension === 'voltage' ? 'Voltage' : 'Current'} (${unit}). ${description} ${m.pointCount} points; horizon ${m.horizonS ?? 'unbounded'} s. ${result.artifacts.length > 1 ? 'Download includes all files in a ZIP. ' : ''}${result.warnings.map(w => `${w.code}: ${w.message}`).join(' ')}`;
}
