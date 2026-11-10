import { parseQuantity, resolveLevel } from '../semantic/units.ts';

export type DataPoint = { timeS: number; value: number };
export type Viewport = { timeMinS: number; timeMaxS: number; valueMin: number; valueMax: number };
export type PlotRect = { left: number; right: number; top: number; bottom: number };
export type Affine = { a: number; b: number; c: number; d: number; e: number; f: number };
const LIMIT = 1e150;
const finite = (n: number) => Number.isFinite(n) && Math.abs(n) <= LIMIT;
const spanValid = (a: number, b: number) => finite(a) && finite(b) && b - a >= Math.max(1e-18, Math.max(Math.abs(a), Math.abs(b)) * Number.EPSILON * 32);
export const validViewport = (v: Viewport) => spanValid(v.timeMinS, v.timeMaxS) && spanValid(v.valueMin, v.valueMax);
const validRect = (r: PlotRect) => spanValid(r.left, r.right) && spanValid(r.top, r.bottom);
const validAffine = (m: Affine) => [m.a,m.b,m.c,m.d,m.e,m.f].every(finite) && Number.isFinite(m.a*m.d-m.b*m.c) && m.a*m.d-m.b*m.c !== 0;

/** Apply an inverse affine transform without browser state. */
export function inverseAffinePoint(x: number, y: number, matrix: Affine): {x:number;y:number} | null {
  if (!finite(x) || !finite(y) || !validAffine(matrix)) return null;
  const {a,b,c,d,e,f} = matrix, det = a*d-b*c;
  const result = {x:(d*(x-e)-c*(y-f))/det, y:(a*(y-f)-b*(x-e))/det};
  return finite(result.x) && finite(result.y) ? result : null;
}

export function clientToData(svg: SVGSVGElement, clientX: number, clientY: number, rect: PlotRect, view: Viewport): DataPoint | null {
  if (!finite(clientX) || !finite(clientY) || !validRect(rect) || !validViewport(view)) return null;
  try {
    const ctm = svg.getScreenCTM();
    if (!ctm || !validAffine(ctm)) return null;
    const inverse = ctm.inverse();
    if (!validAffine(inverse)) return null;
    const local = new DOMPoint(clientX,clientY).matrixTransform(inverse);
    if (!finite(local.x) || !finite(local.y)) return null;
    const point = {
      timeS: view.timeMinS + (local.x-rect.left)/(rect.right-rect.left)*(view.timeMaxS-view.timeMinS),
      value: view.valueMax - (local.y-rect.top)/(rect.bottom-rect.top)*(view.valueMax-view.valueMin)
    };
    return finite(point.timeS) && finite(point.value) ? point : null;
  } catch { return null; }
}

export function dataToSvg(point: DataPoint, rect: PlotRect, view: Viewport): {x:number;y:number} {
  if (!finite(point.timeS) || !finite(point.value) || !validRect(rect) || !validViewport(view)) throw Error('Use finite plot coordinates and nonzero axis spans.');
  const result = {
    x:rect.left+(point.timeS-view.timeMinS)/(view.timeMaxS-view.timeMinS)*(rect.right-rect.left),
    y:rect.bottom-(point.value-view.valueMin)/(view.valueMax-view.valueMin)*(rect.bottom-rect.top)
  };
  if (!finite(result.x) || !finite(result.y)) throw Error('The SVG coordinate exceeds the finite plot range.');
  return result;
}

export function fitViewport(points: readonly (readonly [number,number])[]): Viewport {
  let timeMinS = 0, timeMaxS = 0, valueMin = 0, valueMax = 0;
  for (const [t,v] of points) {
    if (!finite(t) || !finite(v)) throw Error('Use finite waveform coordinates within the plot range.');
    timeMinS = Math.min(timeMinS,t); timeMaxS = Math.max(timeMaxS,t);
    valueMin = Math.min(valueMin,v); valueMax = Math.max(valueMax,v);
  }
  if (!spanValid(timeMinS,timeMaxS)) timeMaxS = timeMinS + Math.max(1e-6, Math.abs(timeMinS)*.1);
  if (!spanValid(valueMin,valueMax)) { valueMin -= .5; valueMax += .5; }
  const margin = (valueMax-valueMin)*.08;
  const view = {timeMinS,timeMaxS,valueMin:Math.max(-LIMIT,valueMin-margin),valueMax:Math.min(LIMIT,valueMax+margin)};
  if (!validViewport(view)) throw Error('The waveform exceeds the finite plot range.');
  return view;
}

export function panViewport(view: Viewport, deltaTimeS: number, deltaValue: number): Viewport {
  if (!validViewport(view) || !finite(deltaTimeS) || !finite(deltaValue)) return {...view};
  const result = {timeMinS:view.timeMinS+deltaTimeS,timeMaxS:view.timeMaxS+deltaTimeS,valueMin:view.valueMin+deltaValue,valueMax:view.valueMax+deltaValue};
  return validViewport(result) ? result : {...view};
}

/** A factor below one increases the magnification. */
export function zoomViewport(view: Viewport, anchor: DataPoint, factor: number): Viewport {
  if (!validViewport(view) || !finite(anchor.timeS) || !finite(anchor.value) || !finite(factor) || factor <= 0) return {...view};
  const result = {
    timeMinS:anchor.timeS+(view.timeMinS-anchor.timeS)*factor,
    timeMaxS:anchor.timeS+(view.timeMaxS-anchor.timeS)*factor,
    valueMin:anchor.value+(view.valueMin-anchor.value)*factor,
    valueMax:anchor.value+(view.valueMax-anchor.value)*factor
  };
  return validViewport(result) ? result : {...view};
}

export function snapPoint(point: DataPoint, timeStepS?: number, valueStep?: number): DataPoint {
  if (!finite(point.timeS) || !finite(point.value)) throw Error('Use finite snap coordinates within the plot range.');
  const snap = (value: number, step?: number) => {
    if (step === undefined) return value;
    if (!finite(step) || step <= 0 || !finite(value)) throw Error('Use a finite positive snap step.');
    const result = Math.round(value/step)*step;
    if (!finite(result)) throw Error('The snapped value exceeds the finite plot range.');
    return Object.is(result,-0) ? 0 : result;
  };
  return {timeS:snap(point.timeS,timeStepS),value:snap(point.value,valueStep)};
}

const decimal = (n: number) => Number(n.toPrecision(15)).toString();
/** Keep the authored unit. Values remain quantities, rather than expressions. */
export function pointQuantity(valueSI: number, oldQuantity: string, dimension: 'current' | 'voltage' | 'time'): string {
  if (!finite(valueSI)) throw Error('Use a finite quantity within the plot range.');
  parseQuantity(oldQuantity, dimension);
  const unit = oldQuantity.trim().match(/([A-Za-zµμ]+)$/)![1];
  const factor = parseQuantity(`1 ${unit}`,dimension);
  const value = valueSI/factor;
  if (!Number.isFinite(value) || valueSI !== 0 && value === 0) throw Error('The quantity exceeds the finite numeric range.');
  const result = `${decimal(value)} ${unit}`;
  parseQuantity(result,dimension);
  return result;
}

export function rampTargetValue(valueSI: number, oldTarget: string, dimension: 'current'|'voltage', nominalSI?: number): string {
  if (!finite(valueSI)) throw Error('Use a finite target within the plot range.');
  resolveLevel(oldTarget,dimension,nominalSI);
  if (!oldTarget.trim().endsWith('%')) return pointQuantity(valueSI,oldTarget,dimension);
  if (nominalSI === undefined || !Number.isFinite(nominalSI) || nominalSI === 0) throw Error('Use the numeric target inspector when the nominal reference is zero.');
  const value = valueSI/nominalSI*100;
  if (!Number.isFinite(value) || valueSI !== 0 && value === 0) throw Error('The percentage exceeds the finite numeric range.');
  const result = `${decimal(value)}%`;
  resolveLevel(result,dimension,nominalSI);
  return result;
}

export type PlotGesture = {kind:'draw'|'drag';start:DataPoint;end:DataPoint;ownerId?:string;pointId?:string;originS?:number;role?:string};
export type PlotGestureOptions = {
  read(): {viewport:Viewport;rect:PlotRect;mode:'select'|'pan'|'draw'|'drag';enabled:boolean;snapTimeS?:number;snapValue?:number};
  onViewport(viewport:Viewport):void;
  onDragPosition?(point:DataPoint,label:string):void;
  onGesture(gesture:PlotGesture):void;
};

export function attachPlotGestures(svg: SVGSVGElement, options: PlotGestureOptions): () => void {
  let pending: {pointerId:number;mode:'pan'|'draw'|'drag';start:DataPoint;previousX:number;previousY:number;ownerId?:string;pointId?:string;originS?:number;role?:string} | undefined;
  const inside = (point: DataPoint, view: Viewport) => point.timeS >= view.timeMinS && point.timeS <= view.timeMaxS && point.value >= view.valueMin && point.value <= view.valueMax;
  const release = () => {
    const id = pending?.pointerId; pending = undefined;
    if (id !== undefined && svg.hasPointerCapture(id)) svg.releasePointerCapture(id);
  };
  const down = (event: PointerEvent) => {
    if (pending || event.button !== 0) return;
    const state = options.read();
    if (state.mode === 'select' || state.mode !== 'pan' && !state.enabled) return;
    const start = clientToData(svg,event.clientX,event.clientY,state.rect,state.viewport);
    if (!start || !inside(start,state.viewport)) return;
    const marker = (event.target as Element)?.closest?.('[data-editable="true"][data-owner]');
    if (state.mode === 'drag' && (!marker || !svg.contains(marker))) return;
    const rawOrigin = marker?.getAttribute('data-origin-s'), originS = rawOrigin ? Number(rawOrigin) : undefined;
    if (originS !== undefined && !finite(originS)) return;
    pending = {pointerId:event.pointerId,mode:state.mode,start,previousX:event.clientX,previousY:event.clientY,ownerId:marker?.getAttribute('data-owner') || undefined,pointId:marker?.getAttribute('data-source-point') || undefined,originS,role:marker?.getAttribute('data-role') || undefined};
    try { svg.setPointerCapture(event.pointerId); } catch { pending = undefined; return; }
    event.preventDefault();
  };
  const move = (event: PointerEvent) => {
    if (!pending || pending.pointerId !== event.pointerId) return;
    const state = options.read();
    if(pending.mode==='drag' && state.mode==='drag'){
      const point=clientToData(svg,event.clientX,event.clientY,state.rect,state.viewport);
      if(point && inside(point,state.viewport)) options.onDragPosition?.(snapPoint(point,state.snapTimeS,state.snapValue),pending.pointId||pending.ownerId||'Point');
      return;
    }
    if(pending.mode!=='pan')return;
    if (state.mode !== 'pan') { release(); return; }
    const previous = clientToData(svg,pending.previousX,pending.previousY,state.rect,state.viewport);
    const current = clientToData(svg,event.clientX,event.clientY,state.rect,state.viewport);
    if (!previous || !current) return;
    pending.previousX = event.clientX; pending.previousY = event.clientY;
    options.onViewport(panViewport(state.viewport,previous.timeS-current.timeS,previous.value-current.value));
  };
  const up = (event: PointerEvent) => {
    if (!pending || pending.pointerId !== event.pointerId) return;
    const current = pending, state = options.read();
    const end = clientToData(svg,event.clientX,event.clientY,state.rect,state.viewport);
    release();
    if (current.mode === 'pan' || !state.enabled || state.mode !== current.mode || !end || !inside(end,state.viewport)) return;
    let snapped: DataPoint;
    try { snapped = snapPoint(end,state.snapTimeS,state.snapValue); }
    catch { return; }
    if (!inside(snapped,state.viewport)) return;
    options.onGesture({kind:current.mode,start:current.start,end:snapped,ownerId:current.ownerId,pointId:current.pointId,originS:current.originS,role:current.role});
  };
  const cancel = (event: PointerEvent) => { if (pending?.pointerId === event.pointerId) release(); };
  const wheel = (event: WheelEvent) => {
    const state = options.read();
    if (state.mode !== 'pan' || !Number.isFinite(event.deltaY)) return;
    const anchor = clientToData(svg,event.clientX,event.clientY,state.rect,state.viewport);
    if (!anchor || !inside(anchor,state.viewport)) return;
    event.preventDefault();
    options.onViewport(zoomViewport(state.viewport,anchor,Math.exp(Math.max(-1,Math.min(1,event.deltaY*.002)))));
  };
  svg.addEventListener('pointerdown',down); svg.addEventListener('pointermove',move); svg.addEventListener('pointerup',up);
  svg.addEventListener('pointercancel',cancel); svg.addEventListener('lostpointercapture',cancel); svg.addEventListener('wheel',wheel,{passive:false});
  return () => {
    release();
    svg.removeEventListener('pointerdown',down); svg.removeEventListener('pointermove',move); svg.removeEventListener('pointerup',up);
    svg.removeEventListener('pointercancel',cancel); svg.removeEventListener('lostpointercapture',cancel); svg.removeEventListener('wheel',wheel);
  };
}
