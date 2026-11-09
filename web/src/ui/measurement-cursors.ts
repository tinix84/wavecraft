type Point = readonly [number, number];

export interface MeasurementFrame {
  points: readonly Point[];
  unit: string;
  firstUs: number;
  lastUs: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  y: (value: number) => number;
}

/** Evaluate the plotted piecewise-linear signal. Time is in microseconds. */
export function measureAt(points: readonly Point[], time: number): number | undefined {
  if (!points.length || !Number.isFinite(time) || time < points[0][0] || time > points[points.length - 1][0]) return;
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (points[middle][0] <= time) low = middle;
    else high = middle - 1;
  }
  const [start, value] = points[low];
  if (time === start) return value;
  const [end, next] = points[low + 1];
  return value + (next - value) * ((time - start) / (end - start));
}

export function mountMeasurements() {
  const plot = document.querySelector<SVGSVGElement>('#plot')!;
  const tool = document.querySelector<HTMLSelectElement>('#studio-cursor')!;
  const times = ['studio-time-a', 'studio-time-b'].map(id => document.getElementById(id) as HTMLInputElement);
  const result = document.getElementById('studio-deltas')!;
  const controls = document.getElementById('studio-measure-controls')!;
  let frame: MeasurementFrame | undefined;
  let dragging: number | undefined;
  const format = (value: number) => Number(value.toPrecision(7)).toString();

  const notes: {time: number; text: string; unit: string; source: string}[] = [];
  const noteText = document.getElementById('studio-note-text') as HTMLInputElement;
  const noteTime = document.getElementById('studio-note-time') as HTMLInputElement;
  const noteStatus = document.getElementById('studio-note-status')!;
  const activeSource = () => (document.getElementById('source') as HTMLTextAreaElement).value;

  function paintNotes() {
    plot.querySelectorAll('#annotation-layer').forEach(layer => layer.remove());
    document.getElementById('studio-note-controls')!.hidden = tool.value !== 'note';
    if (!frame || !notes.length) return;
    const group = document.createElementNS('http://www.w3.org/2000/svg','g');
    group.id = 'annotation-layer';
    group.setAttribute('pointer-events','none');
    const source = activeSource();
    for (const note of notes) {
      if (note.unit !== frame.unit || note.source !== source || note.time < frame.firstUs || note.time > frame.lastUs) continue;
      const value = measureAt(frame.points,note.time);
      if (value === undefined) continue;
      const x = frame.left + (note.time-frame.firstUs)/(frame.lastUs-frame.firstUs)*(frame.right-frame.left);
      const y = frame.y(value);
      if (y < frame.top || y > frame.bottom) continue;
      const dot = document.createElementNS(group.namespaceURI,'circle');
      dot.setAttribute('cx',String(x)); dot.setAttribute('cy',String(y)); dot.setAttribute('r','4'); dot.setAttribute('fill','#ffc04d');
      const label = document.createElementNS(group.namespaceURI,'text');
      const alignRight = x > (frame.left + frame.right)/2;
      label.setAttribute('text-anchor',alignRight ? 'end' : 'start');
      label.setAttribute('x',String(x + (alignRight ? -7 : 7)));
      label.setAttribute('y',String(y < frame.top+18 ? y+16 : y-8));
      label.textContent = note.text;
      group.append(dot,label);
    }
    plot.append(group);
  }

  document.getElementById('studio-note-pin')!.onclick = () => {
    const time = noteTime.valueAsNumber, text = noteText.value.trim();
    if (!frame || !text || measureAt(frame.points,time) === undefined) {
      noteStatus.textContent = 'Enter a note and a time within the waveform.';
      return;
    }
    notes.push({time,text,unit:frame.unit,source:activeSource()});
    noteStatus.textContent = 'Note pinned.';
    paintNotes();
  };
  document.getElementById('studio-note-undo')!.onclick = () => {
    const source = activeSource();
    for (let index=notes.length-1; index>=0; index--) {
      if (notes[index].source !== source) continue;
      notes.splice(index,1);
      noteStatus.textContent = 'Last note removed.';
      paintNotes();
      return;
    }
  };

  function paint() {
    paintNotes();
    plot.querySelectorAll('#measurement-layer').forEach(layer => layer.remove());
    controls.hidden = tool.value !== 'a' && tool.value !== 'b';
    if (controls.hidden || !frame) {
      result.textContent = '';
      return;
    }
    const {points, unit, firstUs, lastUs, left, right, top, bottom, y} = frame;
    const group = document.createElementNS(plot.namespaceURI!, 'g');
    group.id = 'measurement-layer';
    group.setAttribute('pointer-events', 'none');
    plot.append(group);
    const readings = times.map((input, index) => {
      const time = input.valueAsNumber;
      const value = measureAt(points, time);
      if (value === undefined || time < firstUs || time > lastUs) return value;
      const x = left + (time - firstUs) * (right - left) / (lastUs - firstUs);
      const color = index ? '#cca1ff' : '#ffc04d';
      function mark(tag: string, attrs: Record<string, number | string>, label = '') {
        const el = document.createElementNS(plot.namespaceURI!, tag);
        for (const [key, attr] of Object.entries(attrs)) el.setAttribute(key, String(attr));
        el.textContent = label;
        group.append(el);
      }
      mark('line', {x1:x, x2:x, y1:top, y2:bottom, stroke:color, 'stroke-dasharray':'4 3'});
      if (y(value) >= top && y(value) <= bottom) mark('circle', {cx:x, cy:y(value), r:5, fill:color});
      mark('text', {x:x+3, y:top-3}, index ? 'B' : 'A');
      return value;
    });
    const [a,b] = readings;
    if (a === undefined || b === undefined) {
      result.textContent = 'Place both cursors within the waveform.';
      return;
    }
    const dt = times[1].valueAsNumber - times[0].valueAsNumber;
    const delta = b - a;
    result.textContent = `A ${format(a)} ${unit} · B ${format(b)} ${unit} · Δt ${format(dt)} µs · Δ${unit === 'A' ? 'I' : 'V'} ${format(delta)} ${unit} · Mean slope ${dt ? format(delta/dt)+' '+unit+'/µs' : 'undefined (same time)'}`;
  }
  function place(event: PointerEvent) {
    if (!frame) return;
    const matrix = plot.getScreenCTM();
    if (!matrix) return;
    const position = new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());
    const fraction = Math.max(0, Math.min(1,(position.x-frame.left)/(frame.right-frame.left)));
    const time = frame.firstUs + fraction * (frame.lastUs-frame.firstUs);
    const points = frame.points;
    if (!points.length) return;
    const input = tool.value === 'note' ? noteTime : times[tool.value === 'b' ? 1 : 0];
    input.value = String(Math.max(points[0][0],Math.min(points[points.length-1][0],time)));
    paint();
  }
  tool.onchange = paint;
  times.forEach(input => input.oninput = paint);
  plot.addEventListener('pointerdown', event => {
    if (tool.value === 'off' || !frame || !event.isPrimary) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    dragging = event.pointerId;
    plot.setPointerCapture(dragging);
    place(event);
  }, true);
  plot.addEventListener('pointermove', event => {
    if (event.pointerId !== dragging) return;
    event.stopImmediatePropagation();
    place(event);
  }, true);
  for (const name of ['pointerup','pointercancel','lostpointercapture']) {
    plot.addEventListener(name, event => {
      if ((event as PointerEvent).pointerId !== dragging) return;
      event.stopImmediatePropagation();
      dragging = undefined;
    }, true);
  }
  plot.addEventListener('click', event => {
    if (tool.value !== 'off') event.stopImmediatePropagation();
  }, true);
  return (next?: MeasurementFrame) => {frame = next; paint();};
}
