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
    for (const id of ['spectrum-summary','spectrum-basis-info','spectrum-warnings','spectrum-filter-summary']) $(id).textContent='';
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
      const strip = $('wave-measurements');
      strip.replaceChildren(); strip.hidden = true;
      if (!state.dirty) {
        const basis = state.input(undefined,'schedule');
        if (basis.ok) {
          const stats = analyzeSpectrum(basis.input,{harmonicCount:1,method:'pwl'});
          if (stats.ok) {
            strip.title = stats.basisLabel;
            for (const [label,value] of Object.entries({'DC mean':stats.dc,'Total RMS':stats.totalRms,'Ripple RMS':stats.acRms,'Peak-to-peak':stats.peakToPeak})) {
              const cell=document.createElement('span'), reading=document.createElement('strong');
              cell.textContent=label; reading.textContent=Number(value.toPrecision(5))+' '+stats.unit;
              cell.appendChild(reading); strip.appendChild(cell);
            }
            strip.hidden=false;
          }
        }
      }
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
    else if (result) status(state.proposal ? 'Results use the committed source. The semantic edit preview is not applied.' : '');
  }
  function svgNode(svg: any, tag: string, attrs: Record<string, any>, text?: string) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    svg.appendChild(node); return node;
  }
  const orders=[1,2];
  let active=0;
  function spectrumPlot() {
    const svg=$('spectrum-plot'), box=$('fft-delta');
    svg.replaceChildren(); box.replaceChildren();
    svg.setAttribute('viewBox','0 0 760 230');
    const bins=result.bins.filter((bin:any)=>bin.index>0);
    if (!bins.length) return;
    const ceiling=result.analyzedMaxHz, cutoff=result.filtered?.cutoffHz;
    const max=Math.max(...bins.map((bin:any)=>bin.peak),1e-30);
    const logX=$('fft-log-x').checked, logY=$('fft-log-y').checked;
    const low=Math.log10(bins[0].frequencyHz), span=Math.log10(ceiling)-low||1;
    const floor=Math.ceil(Math.log10(max))-8;
    const x=(hz:number)=>70+665*(logX?(Math.log10(hz)-low)/span:hz/ceiling);
    const y=(amp:number)=>185-155*(logY?Math.max(0,(Math.log10(amp)-floor)/8):amp/max);
    const divisor=ceiling>=1e6?1e6:ceiling>=1e3?1e3:1;
    const hzUnit=divisor===1e6?'MHz':divisor===1e3?'kHz':'Hz';
    const short=(n:number)=>Number(n.toPrecision(4)).toString();
    for(let i=0;i<=4;i++){
      const amp=logY?10**(floor+2*i):max*i/4;
      const hz=logX?10**(low+span*i/4):ceiling*i/4;
      svgNode(svg,'line',{x1:70,x2:735,y1:y(amp),y2:y(amp),stroke:'#34485f'});
      svgNode(svg,'text',{x:64,y:y(amp)+4,'text-anchor':'end','font-size':11},short(amp));
      svgNode(svg,'text',{x:x(hz),y:205,'text-anchor':'middle','font-size':11},short(hz/divisor));
    }
    function trace(filtered:boolean){
      const points=bins.map((bin:any)=>x(bin.frequencyHz)+','+y(bin.peak*(filtered?gain(bin.frequencyHz,cutoff):1)));
      svgNode(svg,'polyline',{points:points.join(' '),fill:'none',stroke:filtered?'#ffae4b':'#35dfed','stroke-width':2});
    }
    trace(false); if(cutoff) trace(true);
    svgNode(svg,'text',{x:70,y:15,'font-size':12},'Peak amplitude ('+result.unit+') · DC excluded');
    svgNode(svg,'text',{x:735,y:15,'text-anchor':'end','font-size':12},cutoff?'Source (cyan)   Filtered (amber)':'Source (cyan)');
    svgNode(svg,'text',{x:400,y:227,'text-anchor':'middle','font-size':12},'Frequency ('+hzUnit+')');
    const peak=result.strongestAC;
    if(peak){
      svgNode(svg,'circle',{cx:x(peak.frequencyHz),cy:y(peak.peak),r:4,fill:'#ffcb65'});
      svgNode(svg,'text',{x:Math.min(x(peak.frequencyHz)+14,545),y:Math.max(64,y(peak.peak)-7),'font-size':12},'H'+peak.index+' · '+short(peak.frequencyHz/divisor)+' '+hzUnit+' · '+short(peak.peak)+' '+result.unit);
    }
    const [a,b]=orders.map((order,i)=>{
      orders[i]=Math.min(order,bins.length);
      const bin=bins[orders[i]-1], px=x(bin.frequencyHz), name=i?'B':'A', color=i?'#cca1ff':'#ffc04d';
      const top=i&&Math.abs(px-x(bins[orders[0]-1].frequencyHz))<26?50:26;
      const g=svgNode(svg,'g',{'data-fft-cursor':name,cursor:'ew-resize',tabindex:0,role:'slider','aria-label':'Cursor '+name+' harmonic','aria-valuemin':1,'aria-valuemax':bins.length,'aria-valuenow':orders[i]});
      svgNode(g,'line',{x1:px,x2:px,y1:26,y2:185,stroke:color,'stroke-dasharray':'4 3'});
      svgNode(g,'circle',{cx:px,cy:y(bin.peak),r:5,fill:color});
      svgNode(g,'rect',{x:px-12,y:top,width:24,height:18,rx:4,fill:color});
      svgNode(g,'text',{x:px,y:top+14,'text-anchor':'middle',style:'fill:#0b182d;font-weight:700'},name);
      svgNode(g,'rect',{x:px-12,y:top,width:24,height:18,fill:'transparent','pointer-events':'all'});
      g.onkeydown=(event:KeyboardEvent)=>{
        if(!['ArrowLeft','ArrowRight'].includes(event.key))return;
        event.preventDefault(); active=i;
        orders[i]=Math.max(1,Math.min(bins.length,orders[i]+(event.key==='ArrowLeft'?-1:1)));
        spectrumPlot(); svg.querySelectorAll('[data-fft-cursor]')[i].focus();
      };
      return bin;
    });
    const reading=(bin:any)=>'H'+bin.index+' · '+fmt(bin.frequencyHz)+' Hz · '+fmt(bin.peak)+' '+result.unit;
    for(const label of ['A '+reading(a),'B '+reading(b),'Δf '+fmt(b.frequencyHz-a.frequencyHz)+' Hz','Δpeak '+fmt(b.peak-a.peak)+' '+result.unit]){
      const cell=document.createElement('span'); cell.textContent=label; box.appendChild(cell);
    }
    function place(event:PointerEvent){
      const matrix=svg.getScreenCTM(); if(!matrix)return;
      const px=new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse()).x;
      const bin=bins.reduce((best:any,next:any)=>Math.abs(x(next.frequencyHz)-px)<Math.abs(x(best.frequencyHz)-px)?next:best);
      if(orders[active]!==bin.index){orders[active]=bin.index;spectrumPlot();}
    }
    svg.onpointerdown=(event:PointerEvent)=>{
      if(!event.isPrimary||event.button!==0)return;
      const handle=(event.target as Element).closest('[data-fft-cursor]');
      if(handle)active=Number(handle.getAttribute('data-fft-cursor')==='B');
      svg.setPointerCapture(event.pointerId); if(!handle)place(event);
    };
    svg.onpointermove=(event:PointerEvent)=>{if(svg.hasPointerCapture(event.pointerId))place(event);};
  }
  for(const id of ['fft-log-x','fft-log-y']) $(id).onchange=()=>{if(result)spectrumPlot();};
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
    $('fft-timing').textContent='Δf '+fmt(1/r.durationS)+' Hz · '+(r.method==='fft'?'Δt '+fmt(r.durationS/r.sampleCount)+' s ('+r.sampleCount+' samples)':'Δt — exact PWL integration');
    $('spectrum-summary').textContent = `DC average: ${fmt(r.dc)} ${unit} · Total RMS: ${fmt(r.totalRms)} ${unit} · AC / ripple RMS: ${fmt(r.acRms)} ${unit} · Input peak-to-peak: ${fmt(r.peakToPeak)} ${unit}.`;
    $('spectrum-basis-info').textContent = `${r.basisLabel} · ${fmt(r.durationS)} s · ${r.method === 'fft' ? 'FFT numerical estimate' : 'PWL Fourier coefficients'} · Bin spacing ${fmt(1 / r.durationS)} Hz · Highest analyzed frequency ${fmt(r.analyzedMaxHz)} Hz. ${r.method === 'fft' ? `${r.sampleCount} samples · Sample rate ${fmt(r.sampleCount / r.durationS)} Hz · Nyquist ${fmt(r.sampleCount / (2 * r.durationS))} Hz.` : ''} ${strong ? `Strongest analyzed AC component: order ${strong.index}, ${fmt(strong.frequencyHz)} Hz, ${fmt(strong.peak)} ${unit} peak, ${fmt(strong.rms)} ${unit} RMS.` : 'No nonzero AC component in the analyzed band.'}`;
    $('spectrum-warnings').textContent = [...r.warnings, `Unresolved input AC RMS above the analyzed band: ${fmt(r.unresolvedAcRms)} ${unit}. The analysis ceiling is not the highest harmonic present.`].join('\n');
    $('spectrum-warnings').className = 'notice';
    const f = r.filtered;
    $('spectrum-filter-summary').textContent = f ? `Ideal low-pass: fc ${fmt(f.cutoffHz)} Hz · τ ${fmt(f.tauS)} s · Preserved DC ${fmt(f.dc)} ${unit} · Filtered ripple RMS bounds ${fmt(f.acRmsLower)}–${fmt(f.acRmsUpper)} ${unit} · Total RMS bounds ${fmt(f.totalRmsLower)}–${fmt(f.totalRmsUpper)} ${unit}.` : 'Ideal low-pass filter is off.';
    spectrumPlot(); table(); waveform(); $('spectrum-csv').disabled = false;
    status(read().proposal ? 'Results use the committed source. The semantic edit preview is not applied.' : '');
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
