"""Reject invalid measured data and recheck the existing actual LTspice traces."""
import copy
import json
import pathlib
import sys
import uuid
from phase5_simulators import raw_ascii, write
from phase8_simulators import checks, plecs_checks, queries

directory=pathlib.Path(sys.argv[1]); manifests=[pathlib.Path(p) for p in sys.argv[2:]]
if not manifests:
    raise ValueError('At least one nonempty fixture manifest is required')
expected_matrix=[]
for path in manifests:
    cases=json.loads(path.read_text())['cases']
    if not cases:
        raise ValueError('Fixture manifests must contain cases')
    for item in cases:
        formats=[e['format'] for e in item['exports'] if e['format'] in ['pwl','pwl-file']]
        if sorted(formats)!=['pwl','pwl-file']:
            raise ValueError('Each fixture requires one inline and one file adapter')
        expected_matrix.extend((item['name'],fmt) for fmt in formats)
if len(set(expected_matrix))!=len(expected_matrix):
    raise ValueError('The expected case-format matrix contains duplicates')
case={'name':'adversarial','dimension':'voltage','stop':1.,'expected':{'points':[[0.,2.],[1.,2.]]}}
valid=[[t,2.] for t in queries(case)[2]]
assert checks(case,valid)['pass']
schema={'mode':'electrical','outputSchema':['time_s','lookup','current_load_V','current_load_A','voltage_load_V','voltage_load_A'],'header':'none','numericalResolutionVerified':True}
adversarial=[]
def reject(name,call):
    try: call()
    except ValueError as exc: adversarial.append({'case':name,'pass':True,'rejection':str(exc)}); return
    raise AssertionError(name+' was accepted')
for name,rows in [('nan',[[0,2],[.5,float('nan')],[1,2]]),('infinite-time',[[0,2],[float('inf'),2]]),('clipped-constant',[[.1,2],[.9,2]]),('nonmonotone',[[0,2],[.6,2],[.5,2],[1,2]]),('duplicate-time',[[0,2],[0,2],[1,2]]),('ragged',[[0,2],[1,2,3]])]:
    reject(name,lambda rows=rows:checks(case,rows))
reject('electrical-two-column',lambda:plecs_checks(schema,case,valid))
reject('missing-specified-times',lambda:plecs_checks({'mode':'lookup','outputSchema':['time_s','lookup'],'header':'none','numericalResolutionVerified':True},case,[[0,2],[1,2]]))
reject('unknown-header',lambda:plecs_checks({**schema,'header':'unexpected'},case,[[row[0],2,2,2,2,2] for row in valid]))
assert plecs_checks(schema,case,[[row[0],2,2,2,2,2] for row in valid])['pass']
assert not plecs_checks({**schema,'numericalResolutionVerified':False},case,[[row[0],2,2,2,2,2] for row in valid])['pass']
results=[]
for manifest in manifests:
    for case in json.loads(manifest.read_text())['cases']:
        for export in case['exports']:
            if export['format'] not in ['pwl','pwl-file']:continue
            target=directory/(case['name']+'-'+export['format']); names,rows=raw_ascii(target/'test.raw'); names=[n.lower() for n in names]
            measure='i(i_load)' if case['dimension']=='current' else 'v(1)'; polarity='v(1)' if case['dimension']=='current' else 'i(v_signal)'
            result=checks(case,rows,names.index(measure),names.index(polarity),1 if case['dimension']=='current' else -1)
            results.append({'case':case['name'],'format':export['format'],**result})
actual_matrix=[(r['case'],r['format']) for r in results]
record={'adversarial':adversarial,'positiveControls':2,'resolutionBlockerControl':'pass','actualLTspice':results,'pass':bool(results) and sorted(actual_matrix)==sorted(expected_matrix) and all(r['pass'] for r in results)}
output=directory/('hardened-comparison-'+uuid.uuid4().hex[:8]+'.json'); write(output,json.dumps(record,indent=2)); print(json.dumps({'output':str(output),'adversarialPassed':len(adversarial),'actualPassed':sum(r['pass'] for r in results),'actualTotal':len(results),'samples':sum(r['samples'] for r in results)})); raise SystemExit(0 if record['pass'] else 2)
