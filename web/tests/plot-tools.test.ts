import test from 'node:test';
import assert from 'node:assert/strict';
import { attachPlotGestures, clientToData, dataToSvg, fitViewport, inverseAffinePoint, panViewport, pointQuantity, rampTargetValue, snapPoint, validViewport, zoomViewport } from '../src/ui/plot-tools.ts';
import type { Affine, PlotGesture, PlotGestureOptions, Viewport } from '../src/ui/plot-tools.ts';
import { SemanticController } from '../src/source/controller.ts';
import { resolveLevel } from '../src/semantic/units.ts';

const near = (a:number,b:number) => assert.ok(Math.abs(a-b) <= Math.max(1e-14,Math.abs(b)*1e-13),`${a} != ${b}`);
const rect = {left:20,right:220,top:10,bottom:110};
const view = {timeMinS:0,timeMaxS:10,valueMin:-50,valueMax:50};
const identity = {a:1,b:0,c:0,d:1,e:0,f:0};

class TestDOMPoint {
  x:number; y:number;
  constructor(x:number,y:number) {this.x=x;this.y=y;}
  matrixTransform(m:Affine) {return {x:m.a*this.x+m.c*this.y+m.e,y:m.b*this.x+m.d*this.y+m.f};}
}
Object.defineProperty(globalThis,'DOMPoint',{value:TestDOMPoint,configurable:true});

class TestSvg extends EventTarget {
  matrix: Affine = identity;
  inverse: Affine = identity;
  captured = new Set<number>();
  getScreenCTM() { return {...this.matrix,inverse:()=>this.inverse}; }
  setPointerCapture(id:number) {this.captured.add(id);}
  hasPointerCapture(id:number) {return this.captured.has(id);}
  releasePointerCapture(id:number) {this.captured.delete(id);}
  contains(marker:unknown) {return marker === markerElement;}
  fire(type:string,x:number,y:number,marker = false, extra:Record<string,unknown> = {}) {
    const e = new Event(type,{cancelable:true});
    Object.defineProperties(e,Object.fromEntries(Object.entries({clientX:x,clientY:y,pointerId:1,button:0,...extra}).map(([key,value])=>[key,{value}])));
    if(marker) Object.defineProperty(e,'target',{value:{closest:()=>markerElement}});
    this.dispatchEvent(e); return e;
  }
}
const markerElement = {getAttribute:(key:string)=>({'data-owner':'rise','data-source-point':'sample-2','data-origin-s':'0.002','data-role':'point'}[key] || null)};
const svgElement = (svg:TestSvg) => svg as unknown as SVGSVGElement;

test('affine inversion covers independently calculated translation, scale, rotation and shear',()=>{
  const cases: [Affine,number,number,number,number][] = [
    [{a:1,b:0,c:0,d:1,e:100,f:-30},107,-19,7,11],
    [{a:2,b:0,c:0,d:3,e:10,f:20},24,53,7,11],
    [{a:0,b:2,c:-3,d:0,e:100,f:50},67,64,7,11],
    [{a:2,b:1,c:3,d:4,e:-10,f:5},37,56,7,11]
  ];
  for(const [m,x,y,ex,ey] of cases) { const p=inverseAffinePoint(x,y,m)!; near(p.x,ex);near(p.y,ey); }
  assert.equal(inverseAffinePoint(1,2,{a:1,b:2,c:2,d:4,e:0,f:0}),null);
  assert.equal(inverseAffinePoint(Infinity,2,identity),null);
});

test('client coordinates use the current CTM after scaling, rotation, shear and resize',()=>{
  const svg = new TestSvg();
  const cases:[Affine,Affine,number,number][] = [
    [identity,identity,120,35],
    [{a:2,b:0,c:0,d:3,e:10,f:20},{a:.5,b:0,c:0,d:1/3,e:-5,f:-20/3},250,125],
    [{a:0,b:2,c:-3,d:0,e:100,f:50},{a:0,b:-1/3,c:.5,d:0,e:-25,f:100/3},-5,290],
    [{a:2,b:1,c:3,d:4,e:-10,f:5},{a:.8,b:-.2,c:-.6,d:.4,e:11,f:-4},335,265]
  ];
  for(const [matrix,inverse,x,y] of cases) {
    svg.matrix=matrix;svg.inverse=inverse;
    const p=clientToData(svgElement(svg),x,y,rect,view)!;near(p.timeS,5);near(p.value,25);
  }
  svg.matrix={a:.5,b:0,c:0,d:.5,e:5,f:10};svg.inverse={a:2,b:0,c:0,d:2,e:-10,f:-20};
  const resized={left:20,right:420,top:10,bottom:210};
  const p=clientToData(svgElement(svg),115,40,resized,view)!;near(p.timeS,5);near(p.value,25);
  assert.deepEqual(dataToSvg({timeS:5,value:25},resized,view),{x:220,y:60});
  svg.inverse={...identity,a:NaN};assert.equal(clientToData(svgElement(svg),115,40,resized,view),null);
  svg.matrix={a:1,b:2,c:2,d:4,e:0,f:0};assert.equal(clientToData(svgElement(svg),115,40,resized,view),null);
});

test('linear viewport operations preserve data and refuse invalid or collapsed domains',()=>{
  const points:[number,number][]=[[0,-12],[30e-6,6],[70e-6,-12]], before=structuredClone(points);
  const fitted=fitViewport(points);assert.ok(validViewport(fitted)); assert.ok(fitted.valueMin < -12 && fitted.valueMax > 6);
  assert.deepEqual(panViewport(view,2,-5),{timeMinS:2,timeMaxS:12,valueMin:-55,valueMax:45});
  assert.deepEqual(zoomViewport(view,{timeS:2,value:10},.5),{timeMinS:1,timeMaxS:6,valueMin:-20,valueMax:30});
  assert.deepEqual(zoomViewport(view,{timeS:2,value:10},0),view);
  assert.deepEqual(zoomViewport(view,{timeS:2,value:10},1e-30),view);
  assert.deepEqual(zoomViewport(view,{timeS:Infinity,value:10},.5),view);
  assert.deepEqual(panViewport(view,1e150,0),view);
  assert.deepEqual(points,before);
  assert.ok(validViewport(fitViewport([[0,0]])));
  assert.throws(()=>fitViewport([[Infinity,2]]),/finite/);
});

test('snapping is disabled by omitted steps and uses explicit SI grids',()=>{
  const point={timeS:1.23e-6,value:-12.34};
  assert.deepEqual(snapPoint(point),point);
  const snapped=snapPoint(point,.5e-6,.5);near(snapped.timeS,1e-6);near(snapped.value,-12.5);
  assert.throws(()=>snapPoint(point,0,.5),/positive/);
  assert.throws(()=>snapPoint(point,NaN,.5),/positive/);
  assert.throws(()=>snapPoint({timeS:NaN,value:2}),/finite/);
  assert.throws(()=>snapPoint({timeS:1e150,value:2},1e-200),/range/);
});

test('quantity conversion keeps authored units and percentage targets',()=>{
  assert.equal(rampTargetValue(480,'175%','current',240),'200%');
  assert.equal(rampTargetValue(-.002,'3 mA','current'),'-2 mA');
  assert.equal(rampTargetValue(-1200,'2 kV','voltage'),'-1.2 kV');
  assert.equal(pointQuantity(30e-6,'10 us','time'),'30 us');
  assert.equal(pointQuantity(-3e-6,'1 µV','voltage'),'-3 µV');
  for(const [old,value] of [['2 kA',-500],['3 mA',-.002],['4 uA',-1e-6],['5 nA',-2e-9]] as const) near(resolveLevel(rampTargetValue(value,old,'current'),'current'),value);
  assert.throws(()=>rampTargetValue(1,'20%','current',0),/nominal/);
  assert.throws(()=>rampTargetValue(1,'0 A + 1 A','current'),/quantity/);
  assert.throws(()=>rampTargetValue(Infinity,'1 V','voltage'),/finite/);
});

function gestures(mode:'draw'|'drag'|'pan'='drag') {
  const svg=new TestSvg(), output:PlotGesture[]=[], views:Viewport[]=[];
  const state:ReturnType<PlotGestureOptions['read']>={viewport:view,rect,mode,enabled:true};
  const dispose=attachPlotGestures(svgElement(svg),{read:()=>state,onViewport:v=>{views.push(v);state.viewport=v;},onGesture:g=>output.push(g)});
  return {svg,state,output,views,dispose};
}

test('drag stages only an editable owner on pointerup and cancel drops transient state',()=>{
  const g=gestures();
  g.svg.fire('pointerdown',120,35);g.svg.fire('pointerup',140,30);assert.equal(g.output.length,0);
  g.svg.fire('pointerdown',120,35,true);g.svg.fire('pointermove',140,30);assert.equal(g.output.length,0);assert.equal(g.svg.captured.has(1),true);
  g.svg.fire('pointercancel',140,30);g.svg.fire('pointerup',140,30);assert.equal(g.output.length,0);assert.equal(g.svg.captured.size,0);
  g.svg.fire('pointerdown',120,35,true);g.svg.fire('lostpointercapture',140,30);g.svg.fire('pointerup',140,30);assert.equal(g.output.length,0);
  g.svg.fire('pointerdown',120,35,true);g.svg.fire('pointerup',140,30);
  assert.deepEqual(g.output[0],{kind:'drag',start:{timeS:5,value:25},end:{timeS:6,value:30},ownerId:'rise',pointId:'sample-2',originS:.002,role:'point'});
  g.svg.fire('pointerdown',120,35,true);g.svg.fire('pointerup',300,30);assert.equal(g.output.length,1);
  g.dispose();g.svg.fire('pointerdown',120,35,true);g.svg.fire('pointerup',140,30);assert.equal(g.output.length,1);
});

test('draw click stages a point, dirty drafts block edits, and pan remains view-only',()=>{
  const g=gestures('draw');g.svg.fire('pointerdown',120,35);g.svg.fire('pointerup',120,35);
  assert.equal(g.output.length,1);assert.deepEqual(g.output[0].start,g.output[0].end);
  g.state.enabled=false;g.svg.fire('pointerdown',120,35);g.svg.fire('pointerup',130,30);assert.equal(g.output.length,1);
  g.state.mode='pan';g.svg.fire('pointerdown',120,35);g.svg.fire('pointermove',140,45);g.svg.fire('pointerup',140,45);
  assert.deepEqual(g.views[0],{timeMinS:-1,timeMaxS:9,valueMin:-40,valueMax:60});assert.equal(g.output.length,1);
  const wheel=g.svg.fire('wheel',120,35,false,{deltaY:-100});assert.equal(wheel.defaultPrevented,true);assert.equal(g.views.length,2);
  g.dispose();
});

test('gesture conversion previews through the controller and retains percentage and slew authority',()=>{
  const source='schema: wavecraft/1\nname: Drag\nsignal: {dimension: current, nominal: 240 A, initial: 0 A}\nsegments:\n  - {id: rise, kind: ramp, to: 175%, slew: 6 A/us}\n  - {id: top, kind: hold, duration: 2 ms}\n';
  const controller=new SemanticController();controller.setDraft(source);assert.equal(controller.applyDraft().ok,true);
  const revision=controller.revision;
  const proposal=controller.propose({type:'target',id:'rise',value:rampTargetValue(480,'175%','current',240)});
  assert.equal(proposal.ok,true);if(!proposal.ok)return;
  assert.equal(controller.committedSource,source);assert.equal(controller.revision,revision);
  assert.match(proposal.proposal.source,/to: 200%, slew: 6 A\/us/);
  near(proposal.proposal.result.compiled.nodes[0].timing.durationS,80e-6);
  assert.equal(controller.commitProposal(proposal.proposal).ok,true);
  assert.equal(controller.undo().ok,true);assert.equal(controller.committedSource,source);
});
