import { analyzeSpectrum } from '../analysis/spectrum.ts';
import type { SpectrumInput } from '../analysis/spectrum.ts';

type InputResult = { ok: true; input: SpectrumInput } | { ok: false; diagnostics: string[] };
export type SpectrumSource = {
  key: string;
  dirty: boolean;
  dirtyMessage?: string;
  repeats: string[];
  proposal: boolean;
  input: (repeatId: string | undefined, level: 'schedule' | 'pattern') => InputResult;
};
const fmt = (value: number) => Number(value.toPrecision(7)).toString();
const gain = (frequency: number, cutoff: number) => 1 / Math.hypot(1, frequency / cutoff);

export function mountSpectrumPanel(read: () => SpectrumSource) {
  const $ = (id: string) => document.getElementById(id) as any;
  if (!$('spectrum-panel')) return { refresh() {} };
  for (const [id, value] of Object.entries({ 'spectrum-basis': 'schedule', 'spectrum-method': 'auto', 'spectrum-rows': '10' })) $(id).value ||= value;
  $('spectrum-filter').checked ??= true;
  let sourceKey = '', settingsKey = '', result: any;
  let cutoffAuthority: 'cutoff' | 'tau' = 'cutoff';
  const status = (text: string, error = false) => { $('spectrum-status').textContent = text; $('spectrum-status').className = 'notice ' + (error ? 'error' : ''); };
  function invalidate(text: string) {
    result = undefined;
    $('spectrum-results').hidden = true;
    $('spectrum-plot').replaceChildren(); $('spectrum-wave').replaceChildren(); $('spectrum-table').replaceChildren();
    $('spectrum-csv').disabled = true;
    status(text);
  }
  function settings() {
    return ['spectrum-repeat', 'spectrum-basis', 'spectrum-count', 'spectrum-method', 'spectrum-cutoff', 'spectrum-tau'].map(id => $(id).value).join('|') + '|' + !!$('spectrum-filter').checked;
  }
  function refresh() {
    const state = read();
    const key = `${state.key}|${state.dirty}`;
    if (key !== sourceKey) {
      sourceKey = key;
      const select = $('spectrum-repeat'), previous = select.value;
      select.replaceChildren();
      for (const id of ['', ...state.repeats]) {
        const option = document.createElement('option'); option.value = id; option.textContent = id || 'Automatic / complete record'; select.appendChild(option);
      }
      select.value = state.repeats.includes(previous) ? previous : '';
      invalidate(state.dirty ? state.dirtyMessage || 'Source draft pending. Apply or restore the source before analysis.' : 'Source changed. Select Analyze / update for the committed source.');
    }
    if (settingsKey !== settings()) { settingsKey = settings(); invalidate('Analysis settings changed. Select Analyze / update.'); }
    $('spectrum-analyze').disabled = state.dirty;
    if (state.dirty) status(state.dirtyMessage || 'Source draft pending. Apply or restore the source before analysis.', true);
    else if (result) status(state.proposal ? 'Results use the committed source. The semantic edit preview is not applied.' : 'Results use the committed source. Analysis settings do not change source, history, or waveform exports.');
  }
  function svgNode(svg: any, tag: string, attrs: Record<string, any>, text?: string) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    svg.appendChild(node); return node;
  }
  function spectrumPlot() {
    const svg = $('spectrum-plot'); svg.replaceChildren(); svg.setAttribute('viewBox', '0 0 760 230');
    const bins = result.bins.filter((bin: any) => bin.index > 0);
    const ceiling = result.analyzedMaxHz || 1, max = Math.max(...bins.map((bin: any) => bin.peak), 1e-30);
    const cutoff = result.filtered?.cutoffHz;
    const x = (frequency: number) => 70 + frequency / ceiling * 665, y = (amplitude: number) => 185 - amplitude / max * 155;
    for (let i = 0; i <= 4; i++) {
      const amplitude = max * i / 4, frequency = ceiling * i / 4;
      svgNode(svg, 'line', { x1: 70, x2: 735, y1: y(amplitude), y2: y(amplitude), stroke: '#dce4e7' });
      svgNode(svg, 'text', { x: 65, y: y(amplitude) + 4, 'text-anchor': 'end', 'font-size': 11 }, fmt(amplitude));
      svgNode(svg, 'text', { x: x(frequency), y: 205, 'text-anchor': 'middle', 'font-size': 11 }, fmt(frequency));
    }
    for (const bin of bins) {
      svgNode(svg, 'line', { x1: x(bin.frequencyHz), x2: x(bin.frequencyHz), y1: 185, y2: y(bin.peak), stroke: '#007f79', 'stroke-width': 2 });
      if (cutoff) svgNode(svg, 'line', { x1: x(bin.frequencyHz) + 1, x2: x(bin.frequencyHz) + 1, y1: 185, y2: y(bin.peak * gain(bin.frequencyHz, cutoff)), stroke: '#b86419', 'stroke-width': 2 });
    }
    svgNode(svg, 'text', { x: 74, y: 15, 'font-size': 12 }, `Peak amplitude (${result.unit}) · DC excluded`);
    svgNode(svg, 'text', { x: 400, y: 227, 'text-anchor': 'middle', 'font-size': 12 }, 'Frequency (Hz)');
  }
  function table() {
    const body = $('spectrum-table'); body.replaceChildren();
    if (!result) return;
    const bins = result.bins.filter((bin: any) => bin.index > 0).slice().sort((a: any, b: any) => b.peak - a.peak || a.index - b.index).slice(0, Number($('spectrum-rows').value));
    for (const bin of bins) {
      const attenuation = result.filtered ? gain(bin.frequencyHz, result.filtered.cutoffHz) : undefined;
      const row = document.createElement('tr');
      for (const value of [String(bin.index), fmt(bin.frequencyHz), fmt(bin.peak), fmt(bin.rms), attenuation === undefined ? 'Off' : fmt(attenuation), attenuation === undefined ? '—' : fmt(bin.peak * attenuation)]) {
        const cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell);
      }
      body.appendChild(row);
    }
    $('spectrum-peak-heading').textContent = `Peak (${result.unit})`;
    $('spectrum-rms-heading').textContent = `RMS (${result.unit})`;
    $('spectrum-filter-heading').textContent = `Filtered peak (${result.unit})`;
    $('spectrum-table-caption').textContent = `${bins.length} strongest analyzed AC components · signed DC ${fmt(result.dc)} ${result.unit} is separate`;
  }
  function waveform() {
    const svg = $('spectrum-wave'); svg.replaceChildren(); svg.setAttribute('viewBox', '0 0 760 230');
    const filtered = result.filtered;
    $('spectrum-wave-label').textContent = filtered ? 'Band-limited periodic prediction after settling. The model preserves the mean. The plotted extrema are not exact ripple bounds.' : 'Enable the ideal low-pass filter to show its predicted cycle.';
    if (!filtered) return;
    const points = filtered.points, values = points.map((point: number[]) => point[1]);
    const minimum = Math.min(...values, result.dc), high = Math.max(...values, result.dc), range = high - minimum;
    const span = range > 0 ? range : Math.max(Math.abs(result.dc) * 1e-8, 1e-12);
    const low = range > 0 ? minimum : minimum - span / 2;
    const centered = range > 0 && range < Math.abs(result.dc) * 1e-5;
    const x = (time: number) => 75 + time / result.durationS * 660, y = (value: number) => 180 - (value - low) / span * 145;
    for (let i = 0; i <= 4; i++) {
      const value = low + span * i / 4, time = result.durationS * i / 4;
      svgNode(svg, 'line', { x1: 75, x2: 735, y1: y(value), y2: y(value), stroke: '#dce4e7' });
      svgNode(svg, 'text', { x: 70, y: y(value) + 4, 'text-anchor': 'end', 'font-size': 11 }, fmt(centered ? value - result.dc : value));
      svgNode(svg, 'text', { x: x(time), y: 203, 'text-anchor': 'middle', 'font-size': 11 }, fmt(time));
    }
    svgNode(svg, 'line', { x1: 75, x2: 735, y1: y(result.dc), y2: y(result.dc), stroke: '#536871', 'stroke-dasharray': '4 4' });
    svgNode(svg, 'path', { d: points.map((point: number[], index: number) => `${index ? 'L' : 'M'}${x(point[0])} ${y(point[1])}`).join(' '), fill: 'none', stroke: '#b86419', 'stroke-width': 2 });
    svgNode(svg, 'text', { x: 75, y: 15, 'font-size': 12 }, `${centered ? 'Filtered ripple about mean' : 'Filtered level'} (${result.unit}) · mean ${fmt(result.dc)} ${result.unit}`);
    svgNode(svg, 'text', { x: 400, y: 227, 'text-anchor': 'middle', 'font-size': 12 }, 'Time (s)');
  }
  function render() {
    const r = result, unit = r.unit, strong = r.strongestAC;
    $('spectrum-results').hidden = false;
    $('spectrum-summary').textContent = `DC average: ${fmt(r.dc)} ${unit} · Total RMS: ${fmt(r.totalRms)} ${unit} · AC / ripple RMS: ${fmt(r.acRms)} ${unit} · Input peak-to-peak: ${fmt(r.peakToPeak)} ${unit}.`;
    $('spectrum-basis-info').textContent = `${r.basisLabel} · ${fmt(r.durationS)} s · ${r.method === 'fft' ? 'FFT numerical estimate' : 'PWL Fourier coefficients'} · Bin spacing ${fmt(1 / r.durationS)} Hz · Highest analyzed frequency ${fmt(r.analyzedMaxHz)} Hz. ${r.method === 'fft' ? `${r.sampleCount} samples · Sample rate ${fmt(r.sampleCount / r.durationS)} Hz · Nyquist ${fmt(r.sampleCount / (2 * r.durationS))} Hz.` : ''} ${strong ? `Strongest analyzed AC component: order ${strong.index}, ${fmt(strong.frequencyHz)} Hz, ${fmt(strong.peak)} ${unit} peak, ${fmt(strong.rms)} ${unit} RMS.` : 'No nonzero AC component in the analyzed band.'}`;
    $('spectrum-warnings').textContent = [...r.warnings, `Unresolved input AC RMS above the analyzed band: ${fmt(r.unresolvedAcRms)} ${unit}. The analysis ceiling is not the highest harmonic present.`].join('\n');
    $('spectrum-warnings').className = 'notice';
    const f = r.filtered;
    $('spectrum-filter-summary').textContent = f ? `Ideal low-pass: fc ${fmt(f.cutoffHz)} Hz · τ ${fmt(f.tauS)} s · Preserved DC ${fmt(f.dc)} ${unit} · Filtered ripple RMS bounds ${fmt(f.acRmsLower)}–${fmt(f.acRmsUpper)} ${unit} · Total RMS bounds ${fmt(f.totalRmsLower)}–${fmt(f.totalRmsUpper)} ${unit}.` : 'Ideal low-pass filter is off.';
    spectrumPlot(); table(); waveform(); $('spectrum-csv').disabled = false;
    status(read().proposal ? 'Results use the committed source. The semantic edit preview is not applied.' : 'Results use the committed source. Analysis settings do not change source, history, or waveform exports.');
  }
  function updatePair(authority: 'cutoff' | 'tau') {
    cutoffAuthority = authority;
    const value = Number($(authority === 'cutoff' ? 'spectrum-cutoff' : 'spectrum-tau').value);
    if (Number.isFinite(value) && value > 0) $(authority === 'cutoff' ? 'spectrum-tau' : 'spectrum-cutoff').value = String((1 / value) / (2 * Math.PI));
    else $(authority === 'cutoff' ? 'spectrum-tau' : 'spectrum-cutoff').value = '';
    refresh();
  }
  $('spectrum-cutoff').oninput = () => updatePair('cutoff');
  $('spectrum-tau').oninput = () => updatePair('tau');
  for (const id of ['spectrum-repeat', 'spectrum-basis', 'spectrum-method', 'spectrum-filter']) $(id).onchange = refresh;
  $('spectrum-count').oninput = refresh;
  $('spectrum-rows').onchange = table;
  $('spectrum-analyze').onclick = () => {
    refresh(); const state = read(); if (state.dirty) return;
    try {
      const count = Number($('spectrum-count').value);
      if (!Number.isInteger(count) || count < 1 || count > 2048) throw Error('Enter an integer harmonic count from 1 to 2048.');
      let cutoffHz: number | undefined;
      if ($('spectrum-filter').checked) {
        const field = $(cutoffAuthority === 'cutoff' ? 'spectrum-cutoff' : 'spectrum-tau');
        const value = field.value.trim() === '' ? NaN : Number(field.value);
        if (!Number.isFinite(value) || value <= 0) throw Error('Enter a finite positive cutoff frequency or RC time constant.');
        cutoffHz = cutoffAuthority === 'cutoff' ? value : (1 / value) / (2 * Math.PI);
        if (!Number.isFinite(cutoffHz) || cutoffHz <= 0) throw Error('The linked cutoff frequency must be finite and positive.');
      }
      const adapted = state.input($('spectrum-repeat').value || undefined, $('spectrum-basis').value);
      if (!adapted.ok) throw Error(adapted.diagnostics.join('\n'));
      const analyzed = analyzeSpectrum(adapted.input, { harmonicCount: count, method: $('spectrum-method').value, ...(cutoffHz === undefined ? {} : { cutoffHz }) });
      if (!analyzed.ok) throw Error(analyzed.diagnostics.join('\n'));
      result = analyzed; render();
    } catch (error) { invalidate((error as Error).message); status((error as Error).message, true); }
  };
  $('spectrum-csv').onclick = () => {
    refresh(); if (!result) return;
    const unit = result.unit;
    const header = `# Spectrum analysis only; ${result.basisLabel.replace(/[\r\n]/g, ' ')}; ${result.method}\n# Signed DC ${result.dc} ${unit}; duration ${result.durationS} s; finite analyzed band ${result.analyzedMaxHz} Hz\norder,frequency_Hz,peak_${unit},rms_${unit},phase_rad,filter_gain,filtered_peak_${unit}\n`;
    const csv = header + result.bins.map((bin: any) => {
      const attenuation = result.filtered ? gain(bin.frequencyHz, result.filtered.cutoffHz) : undefined;
      return [bin.index, bin.frequencyHz, bin.peak, bin.rms, bin.phaseRad, attenuation ?? '', attenuation === undefined ? '' : bin.peak * attenuation].join(',');
    }).join('\n') + '\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })), link = document.createElement('a');
    link.href = url; link.download = 'wavecraft-spectrum.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  refresh();
  if (!read().dirty) $('spectrum-analyze').onclick();
  return { refresh };
}
