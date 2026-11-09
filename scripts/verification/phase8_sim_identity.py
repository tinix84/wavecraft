"""Count measured threshold crossings independently of the simulator solver."""
import hashlib
import json
import pathlib
import sys
import uuid
from phase5_simulators import LTSPICE, raw_ascii, write
from phase8_simulators import queries

directory=pathlib.Path(sys.argv[1]); manifest_path=pathlib.Path(sys.argv[2]); manifest=json.loads(manifest_path.read_text()); results=[]
for case in manifest['cases']:
    if not case['name'].startswith('C-'): continue
    points=case['expected']['points']; threshold=min(p[1] for p in points if p[1]>0)/2
    events,interiors,_=queries(case)
    expected=[]
    for j in range(int(case['stop']/case['expected']['outer'])+1):
        for k in range(case['expected']['count']):
            start=j*case['expected']['outer']+k*case['expected']['period']
            for a,b in zip(points,points[1:]):
                if a[1]<threshold<=b[1]: expected.append(start+a[0]+(b[0]-a[0])*(threshold-a[1])/(b[1]-a[1]))
    for fmt in ['pwl','pwl-file']:
        target=directory/(case['name']+'-'+fmt); names,rows=raw_ascii(target/'test.raw'); index=[n.lower() for n in names].index('i(i_load)')
        crossings=[a[0]+(b[0]-a[0])*(threshold-a[index])/(b[index]-a[index]) for a,b in zip(rows,rows[1:]) if a[index]<threshold<=b[index]]
        error=max((abs(a-b) for a,b in zip(expected,crossings)),default=0)
        results.append({'case':case['name'],'format':fmt,'thresholdA':threshold,'expectedPulseCount':len(expected),'measuredPulseCount':len(crossings),'timeToleranceS':1e-10,'maximumCrossingTimeErrorS':error,'expectedCrossingsS':expected,'measuredCrossingsS':crossings,'pass':len(expected)==len(crossings) and error<1e-10})
if not results:
    raise ValueError('At least one C burst fixture is required')
record={'executable':str(LTSPICE),'executableSha256':hashlib.sha256(LTSPICE.read_bytes()).hexdigest(),'manifest':str(manifest_path.resolve()),'manifestSha256':hashlib.sha256(manifest_path.read_bytes()).hexdigest(),'results':results}
output=directory/('pulse-identity-'+uuid.uuid4().hex[:8]+'.json'); write(output,json.dumps(record,indent=2)); print(json.dumps({'path':str(output),'results':[{k:v for k,v in r.items() if 'CrossingsS' not in k} for r in results]},indent=2)); raise SystemExit(0 if all(r['pass'] for r in results) else 2)
