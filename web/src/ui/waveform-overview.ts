type Point = readonly [number, number];
type Frame = {
  points: readonly Point[];
  first: number;
  last: number;
  change: (first: number, last: number) => void;
};

export function mountOverview() {
  const svg = document.querySelector<SVGSVGElement>('#studio-overview')!;
  const panel = document.getElementById('studio-overview-panel')!;
  const firstField = document.getElementById('overview-first') as HTMLInputElement;
  const lastField = document.getElementById('overview-last') as HTMLInputElement;
  const trace = document.getElementById('overview-trace')!;
  const windowBox = document.getElementById('overview-window')!;
  const handles = ['overview-start','overview-end'].map(id => document.getElementById(id)!);
  const rangeLabel = document.getElementById('overview-range')!;
  let frame: Frame | undefined;
  let end = 0;
  let drag: { mode: 'left' | 'right' | 'move'; origin: number; first: number; last: number; id: number } | undefined;
  const clamp = (v: number, a: number, b: number) => Math.max(a,Math.min(b,v));
  const display = (value: number) => Number(value.toPrecision(8)).toString();

  function render(next?: Frame) {
    frame = next;
    end = next?.points.at(-1)?.[0] ?? 0;
    panel.hidden = !next || end <= 0;
    if (panel.hidden || !next) return;
    let low = Infinity, high = -Infinity;
    for (const [,value] of next.points) { low=Math.min(low,value); high=Math.max(high,value); }
    const path = next.points.map(([time,value],i) => {
      const y = high === low ? 40 : 68 - 56*(value-low)/(high-low);
      return (i ? 'L' : 'M') + (time/end*1000).toFixed(3) + ' ' + y.toFixed(3);
    }).join(' ');
    trace.setAttribute('d',path);
    const first = clamp(next.first,0,end), last = clamp(next.last,0,end);
    firstField.value = display(first); lastField.value = display(last);
    rangeLabel.textContent = '0 – '+display(end)+' µs';
    const x1=first/end*1000, x2=last/end*1000;
    windowBox.setAttribute('x',String(x1)); windowBox.setAttribute('width',String(x2-x1));
    handles.forEach((handle,i) => {
      const x = String(i ? x2 : x1);
      handle.setAttribute('x1',x); handle.setAttribute('x2',x);
    });
  }
  function timeAt(event: PointerEvent) {
    const rect = svg.getBoundingClientRect();
    return clamp((event.clientX-rect.left)/rect.width,0,1)*end;
  }
  svg.onpointerdown = event => {
    if (!frame || !event.isPrimary || event.button !== 0) return;
    const time = timeAt(event);
    const first = clamp(frame.first,0,end), last = clamp(frame.last,0,end);
    const tolerance = 12/svg.getBoundingClientRect().width*end;
    const nearest = Math.min(Math.abs(time-first),Math.abs(time-last));
    const mode = !event.shiftKey && nearest <= tolerance ? (Math.abs(time-first)<=Math.abs(time-last) ? 'left':'right') : 'move';
    const outside = time < first || time > last;
    const origin = mode === 'move' && outside ? (first+last)/2 : time;
    drag = {mode,origin,first,last,id:event.pointerId};
    svg.setPointerCapture(event.pointerId);
    event.preventDefault();
    move(event);
  };
  function move(event: PointerEvent) {
    if (!frame || !drag || event.pointerId !== drag.id) return;
    const delta = timeAt(event)-drag.origin;
    const span = drag.last-drag.first, minimum = Math.max(end*1e-9, Number.MIN_VALUE);
    if (drag.mode === 'left') frame.change(clamp(drag.first+delta,0,drag.last-minimum),drag.last);
    else if (drag.mode === 'right') frame.change(drag.first,clamp(drag.last+delta,drag.first+minimum,end));
    else {
      const first=clamp(drag.first+delta,0,end-span);
      frame.change(first,first+span);
    }
  }
  svg.onpointermove = move;
  svg.onlostpointercapture = () => {drag=undefined;};
  document.getElementById('overview-apply')!.onclick = () => {
    const a = firstField.valueAsNumber, b = lastField.valueAsNumber;
    if (frame && a>=0 && b<=end && b>a) frame.change(a,b);
    else rangeLabel.textContent = 'Enter increasing times between 0 and '+display(end)+' µs.';
  };
  function pan(direction: number) {
    if (!frame) return;
    const span = Math.min(end, frame.last-frame.first);
    const first = clamp(frame.first + direction*span/2,0,end-span);
    frame.change(first,first+span);
  }
  document.getElementById('overview-earlier')!.onclick = () => pan(-1);
  document.getElementById('overview-later')!.onclick = () => pan(1);
  document.getElementById('overview-fit')!.onclick = () => frame?.change(0,end);
  return render;
}
