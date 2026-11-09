import test from 'node:test';
import assert from 'node:assert/strict';
import { SemanticController } from '../src/source/controller.ts';
import type { EditCommand } from '../src/source/controller.ts';
import { newDocumentSource, segmentCommand, correctionCommands, rampTimeCommand } from '../src/ui/semantic-authoring.ts';

function accept(controller:SemanticController,command:EditCommand) {
  const result=controller.propose(command);assert.equal(result.ok,true,JSON.stringify(result));
  if(result.ok)assert.equal(controller.commitProposal(result.proposal).ok,true);
}
function current() { return new SemanticController(newDocumentSource('Authored pulse','current','0 A','240 A')); }
function ramp(id:string,to:string) {return segmentCommand({id,kind:'ramp',target:to,control:'slew',duration:'6 A/us',pointTime:'',pointValue:'',pointId:''});}
test('GUI source template has an explicit dimension and an empty authored sequence',()=>{
  for(const dimension of ['current','voltage'] as const) {
    const controller=new SemanticController(newDocumentSource('New',dimension,dimension==='current'?'0 A':'-12 V'));
    assert.equal(controller.result?.document.signal.dimension,dimension);assert.deepEqual(controller.result?.document.segments,[]);
  }
});
test('wrapping preserves AST comments and percentages, and undo restores exact source',()=>{
  const controller=new SemanticController('# Intent remains.\n'+newDocumentSource('Pulse','current','0 A','240 A'));
  accept(controller,ramp('rise','175%'));accept(controller,{type:'insert-segment',segment:{id:'top',kind:'hold',duration:'2 ms'}});accept(controller,ramp('return','0 A'));
  const before=controller.source;
  accept(controller,{type:'wrap-repeat',ids:['rise','top','return'],repeat:{id:'periodic',period:'3 ms',count:'continuous'}});
  assert.match(controller.source,/# Intent remains/);assert.match(controller.source,/175%/);
  accept(controller,{type:'target',id:'rise',value:'200%'});
  const repeat=controller.result!.compiled.nodes[0];assert.equal(repeat.kind,'repeat');
  if(repeat.kind==='repeat'){assert.equal(repeat.pattern[0].timing.durationS,80e-6);assert.equal(repeat.pattern[0].points.at(-1)![1],480);assert.equal(repeat.pattern[1].timing.durationS,.002);}
  controller.undo();controller.undo();assert.equal(controller.source,before);
});
test('point insertion and removal rebuild ranges and preserve signed quantities',()=>{
  const controller=new SemanticController(newDocumentSource('Signed','voltage','-12 V'));
  accept(controller,{type:'insert-segment',segment:{id:'points',kind:'points',points:[{id:'p1',time:'20 us',value:'6 V'}]}});
  accept(controller,{type:'insert-point',id:'points',beforeId:'p1',point:{id:'p0',time:'10 us',value:'-6 V'}});
  assert.deepEqual(controller.sourceMap.get('p1')?.path,['segments',0,'points',1]);
  accept(controller,{type:'remove-point',id:'p0'});assert.deepEqual(controller.sourceMap.get('p1')?.path,['segments',0,'points',0]);
  const before=controller.source;const bad=controller.propose({type:'remove-point',id:'p1'});assert.equal(bad.ok,false);assert.equal(controller.source,before);
});
test('explicit anchor correction retains the rejected target and commits one history entry',()=>{
  const controller=current();accept(controller,ramp('rise','175%'));accept(controller,{type:'timing',id:'rise',arriveAt:'70 us'});
  const before=controller.source,edit:EditCommand={type:'target',id:'rise',value:'200%'},proposal=controller.propose(edit);
  assert.equal(proposal.ok,false);if(proposal.ok)return;
  const corrections=correctionCommands(edit,proposal.diagnostics);assert.equal(corrections.length,2);assert.equal(controller.source,before);
  accept(controller,corrections[0].command);assert.match(controller.source,/200%/);assert.doesNotMatch(controller.source,/arriveAt/);
  controller.undo();assert.equal(controller.source,before);
});
test('scalar batch uses the final value for repeated paths and rejects structural mixing',()=>{
  const controller=current();accept(controller,ramp('rise','175%'));
  accept(controller,{type:'batch',commands:[{type:'target',id:'rise',value:'180%'},{type:'target',id:'rise',value:'200%'}]});
  assert.equal(controller.result!.document.segments[0].kind,'ramp');assert.match(controller.source,/200%/);assert.doesNotMatch(controller.source,/180%/);
  const before=controller.source;assert.equal(controller.propose({type:'batch',commands:[{type:'remove-segment',id:'rise'}]}).ok,false);assert.equal(controller.source,before);
});
test('initial and maximum slew commands retain intent and reject invalid constraints atomically',()=>{
  const controller=current();accept(controller,ramp('rise','175%'));
  accept(controller,{type:'initial',value:'-6 A'});accept(controller,{type:'max-slew',id:'rise',value:'6 A/us'});
  const before=controller.source;assert.equal(controller.propose({type:'max-slew',id:'rise',value:'5 A/us'}).ok,false);assert.equal(controller.source,before);
  accept(controller,{type:'max-slew',id:'rise',value:null});assert.doesNotMatch(controller.source,/maxSlew/);assert.match(controller.source,/175%/);
});
test('anchored time handle changes arrival and retains ramp duration, slew, and percent target',()=>{
  const command=rampTimeCommand({id:'rise',kind:'ramp',to:'175%',slew:'6 A/us',arriveAt:'100 us'},70e-6,20e-6);
  assert.deepEqual(command,{type:'timing',id:'rise',arriveAt:'120 us'});
  const controller=current();accept(controller,ramp('rise','175%'));accept(controller,{type:'timing',id:'rise',arriveAt:'100 us'});accept(controller,command);
  const segment=controller.result!.document.segments[0];assert.equal(segment.kind,'ramp');if(segment.kind==='ramp'){assert.equal(segment.arriveAt,'120 us');assert.equal(segment.slew,'6 A/us');assert.equal(segment.to,'175%');}
});
test('relative time handle keeps the authoritative ramp control and authored units',()=>{
  assert.deepEqual(rampTimeCommand({id:'rise',kind:'ramp',to:'175%',slew:'6 A/us'},70e-6,14e-6),{type:'ramp-control',id:'rise',control:'slew',value:'5 A/us'});
  assert.deepEqual(rampTimeCommand({id:'rise',kind:'ramp',to:'6 V',duration:'30 us'},30e-6,10e-6),{type:'ramp-control',id:'rise',control:'duration',value:'40 us'});
});
