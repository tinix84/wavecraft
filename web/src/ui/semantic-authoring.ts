import { stringify } from 'yaml';
import type { CompiledLeaf, CompiledRepeat, Diagnostic, LeafSegment, Ramp, Repeat } from '../semantic/types.ts';
import type { EditCommand, ValidCompile } from '../source/types.ts';
import { parseQuantity } from '../semantic/units.ts';
import { pointQuantity } from './plot-tools.ts';

export function newDocumentSource(name: string, dimension: 'current' | 'voltage', initial: string, nominal?: string) {
  return stringify({schema:'wavecraft/1',name,signal:{dimension,initial,...(nominal?.trim()?{nominal}: {})},segments:[]});
}
export function unusedId(base: string, ids: Iterable<string>) {
  const used = new Set(ids); let id = base, next = 2;
  while (used.has(id)) id = `${base}-${next++}`;
  return id;
}
export function rampTimeCommand(segment:Ramp,durationS:number,deltaTimeS:number):EditCommand {
  if(segment.arriveAt) return {type:'timing',id:segment.id,arriveAt:pointQuantity(parseQuantity(segment.arriveAt,'time')+deltaTimeS,segment.arriveAt,'time')};
  const duration=durationS+deltaTimeS;
  if(duration<=0)throw Error('Use a positive ramp duration.');
  if(segment.duration)return {type:'ramp-control',id:segment.id,control:'duration',value:pointQuantity(duration,segment.duration,'time')};
  const match=segment.slew!.match(/^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)([\s\S]*)$/)!;
  return {type:'ramp-control',id:segment.id,control:'slew',value:`${Number((Number(match[1])*durationS/duration).toPrecision(15))}${match[2]}`};
}
export type SegmentFields = {id:string;kind:'hold'|'ramp'|'points';duration:string;target:string;control:'duration'|'slew';arriveAt?:string;maxSlew?:string;pointTime:string;pointValue:string;pointId:string};
export function segmentCommand(fields: SegmentFields, parentId?:string, beforeId?:string): EditCommand {
  let segment: LeafSegment;
  if (fields.kind === 'hold') segment = {id:fields.id,kind:'hold',duration:fields.duration};
  else if (fields.kind === 'points') segment = {id:fields.id,kind:'points',points:[{id:fields.pointId,time:fields.pointTime,value:fields.pointValue}]};
  else segment = {id:fields.id,kind:'ramp',to:fields.target,[fields.control]:fields.duration,...(fields.arriveAt?{arriveAt:fields.arriveAt}:{}),...(fields.maxSlew?{maxSlew:fields.maxSlew}:{})};
  return {type:'insert-segment',segment,...(parentId?{parentId}:{}),...(beforeId?{beforeId}:{})};
}
export function findCompiled(result: ValidCompile, id: string): CompiledLeaf | CompiledRepeat | undefined {
  for (const node of result.compiled.nodes) {
    if (node.id === id) return node;
    if (node.kind === 'repeat') { const child=node.pattern.find(n=>n.id===id); if(child)return child; }
  }
}
const show = (n:number) => Number(n.toPrecision(10)).toString();
export function feasibleArrival(previousEndS:number,durationS:number) {
  let arrival=previousEndS+durationS;
  if(arrival-durationS<previousEndS && Number.isFinite(arrival) && arrival>=0) {
    const view=new DataView(new ArrayBuffer(8));view.setFloat64(0,arrival);view.setBigUint64(0,view.getBigUint64(0)+1n);arrival=view.getFloat64(0);
  }
  return arrival;
}
export function inspectorSummary(result:ValidCompile, segment:LeafSegment|Repeat) {
  const node = findCompiled(result,segment.id); if(!node)return '';
  const unit=result.compiled.dimension==='current'?'A':'V';
  if(node.kind==='repeat' && segment.kind==='repeat') return `Pattern clock: ${segment.frequency?'frequency':'period'} controls. Resolved period ${show(node.periodS)} s; frequency ${show(node.frequencyHz)} Hz. Pattern repetitions ${node.count}. Pattern duration ${show(node.patternDurationS)} s. Active span ${show(node.activeSpanS)} s.${node.outer?` Outer clock: ${segment.outer?.frequency?'frequency':'period'} controls. Resolved period ${show(node.outer.periodS)} s; frequency ${show(node.outer.frequencyHz)} Hz. Burst repetitions ${node.outer.count}.`:''}`;
  if(node.kind==='repeat')return '';
  const timing=`Resolved start ${show(node.timing.startS*1e6)} µs; end ${show(node.timing.endS*1e6)} µs; duration ${show(node.timing.durationS*1e6)} µs.`;
  if(segment.kind==='ramp') {
    const parent=result.compiled.nodes.find(n=>n.kind==='repeat'&&n.pattern.some(p=>p.id===segment.id)),timeline=parent?.kind==='repeat'?parent.pattern:result.compiled.nodes;
    const idle=timeline.find(n=>n.kind==='idle'&&n.source.id===segment.id)?.timing.durationS || 0;
    const anchor=segment.arriveAt?`Absolute arrival${parent?' (pattern-local)':''} ${segment.arriveAt}; idle ${show(idle*1e6)} µs.`:'Relative timing: sequential.';
    return `Requested target ${segment.to}; resolved target ${show(node.points.at(-1)![1])} ${unit}. ${segment.slew?'Slew':'Duration'} controls: ${segment.slew||segment.duration}. Derived slew ${show((node.resolvedSlew||0)/1e6)} ${unit}/µs. ${anchor} Ramp duration ${show(node.timing.durationS*1e6)} µs; total occupied ${show((node.timing.durationS+idle)*1e6)} µs. ${timing}`;
  }
  return `${segment.kind==='hold'?'Hold duration':'Explicit points'}. ${timing}`;
}
export function correctionCommands(edit:EditCommand, diagnostics:Diagnostic[]): {label:string;command:EditCommand}[] {
  const items:{label:string;command:EditCommand}[]=[];
  if(edit.type==='batch')return items;
  for(const diagnostic of diagnostics) {
    const values=diagnostic.values, id=diagnostic.source.id;
    if(diagnostic.code==='ANCHOR_CONFLICT' && id && values) {
      const required=feasibleArrival(Number(values.previousEndS),Number(values.rampDurationS));
      items.push({label:'Remove arrival anchor; use sequential timing',command:{type:'batch',commands:[edit as any,{type:'timing',id,arriveAt:null}]}});
      items.push({label:`Set arrival to ${show(required*1e6)} µs (${required} s)`,command:{type:'batch',commands:[edit as any,{type:'timing',id,arriveAt:`${required} s`}]}});
    }
    if(diagnostic.code==='REPEAT_FIT' && id && values) {
      const outer=diagnostic.source.path.includes('outer'),required=Number(outer?values.activeSpanS:values.patternDurationS);
      if(edit.type==='wrap-repeat') items.push({label:`Use ${outer?'outer':'pattern'} period ${show(required)} s`,command:{...edit,repeat:{...edit.repeat,...(outer?{outer:{...edit.repeat.outer!,period:`${required} s`,frequency:undefined}}:{period:`${required} s`,frequency:undefined})}}});
      else items.push({label:`Set ${outer?'outer':'pattern'} period to ${show(required)} s`,command:{type:'batch',commands:[edit as any,{type:'repeat-clock',id,level:outer?'outer':'inner',control:'period',value:`${required} s`}]}});
    }
  }
  return items;
}
