"""Measure exported sources in installed simulators without application changes."""
import argparse
import base64
import hashlib
import json
import math
import pathlib
import time
import uuid
from phase5_simulators import ROOT, LTSPICE, expected_at, interpolate, run_ltspice, write


def queries(case):
    spec = case['expected']; stop = case['stop']; points = spec['points']; begin = case.get('start',0)
    outer = spec.get('outer', stop + 1)
    count = spec.get('count', 1)
    starts = [j * outer + k * spec.get('period', 0)
              for j in range(int(stop / outer) + 1)
              for k in range(int(stop / spec['period']) + 1 if count == 'continuous' else count)]
    events = sorted({start + p[0] for start in starts for p in points if begin <= start + p[0] <= stop})
    interiors = sorted({start + (a[0] + b[0]) / 2 for start in starts for a, b in zip(points, points[1:])
                        if begin <= start + (a[0] + b[0]) / 2 <= stop})
    grid = [begin + (stop-begin) * i / 1024 for i in range(1025)]
    return events, interiors, sorted(set(events + interiors + grid + [begin, stop]))


def validate_rows(case, rows, width=None, required_times=None):
    if len(rows) < 2:
        raise ValueError('At least two measured rows are required')
    width = width or len(rows[0])
    if width < 2 or any(len(row) != width for row in rows):
        raise ValueError('Measured row width does not match the schema')
    if any(not math.isfinite(value) for row in rows for value in row):
        raise ValueError('Measured times and values must be finite')
    if any(b[0] <= a[0] for a,b in zip(rows,rows[1:])):
        raise ValueError('Measured times must increase strictly')
    stop = case['stop']; tolerance = 16 * math.ulp(stop)
    if abs(rows[0][0]-case.get('start',0)) > tolerance or abs(rows[-1][0] - stop) > tolerance:
        raise ValueError('Measured data must cover the full simulation horizon')
    if required_times is not None:
        import bisect
        actual = [row[0] for row in rows]
        for t in required_times:
            index = bisect.bisect_left(actual,t)
            near = actual[max(0,index-1):index+1]
            if not any(abs(value-t) <= 16*math.ulp(max(abs(t),1e-12)) for value in near):
                raise ValueError(f'Missing specified output time {t:.17g}')


def plecs_checks(prepared, case, rows):
    schemas = {'lookup':['time_s','lookup'], 'electrical':['time_s','lookup','current_load_V','current_load_A','voltage_load_V','voltage_load_A']}
    mode = prepared.get('mode')
    if mode not in schemas or prepared.get('outputSchema') != schemas[mode] or prepared.get('header') != 'none':
        raise ValueError('Unknown or incomplete structured PLECS output schema')
    validate_rows(case,rows,len(schemas[mode]),queries(case)[2])
    result = checks(case,rows)
    if mode == 'electrical':
        result['electricalChannels'] = [checks(case,rows,i,1) for i in range(2,6)]
        result['pass'] = result['pass'] and all(c['pass'] for c in result['electricalChannels'])
    if prepared.get('numericalResolutionVerified') is not True:
        result['pass'] = False
        result['resolutionBlocker'] = 'PLECS ramp-relative refinement has no actual verification. The global maximum step exceeds the burst ramps.'
    return result


def checks(case, rows, value_index=1, polarity_index=None, polarity_sign=1):
    validate_rows(case,rows)
    measured = [(r[0], r[value_index]) for r in rows]
    events, interiors, times = queries(case)
    error = lambda ts: max((abs(interpolate(measured, t) - expected_at(case['expected'], t)) for t in ts), default=0)
    scale = max(abs(p[1]) for p in case['expected']['points'])
    tolerance = max(1e-8, scale * 1e-6)
    if case['name'].startswith('article-'):
        tolerance = min(tolerance,1e-5)
    result = {'unit': 'A' if case['dimension'] == 'current' else 'V', 'absoluteTolerance': tolerance,
              'samples': len(rows), 'eventCount': len(events), 'interiorCount': len(interiors), 'queryCount': len(times),
              'sampleError': max(abs(v - expected_at(case['expected'], t)) for t, v in measured),
              'eventError': error(events), 'interiorError': error(interiors), 'gridError': error(times)}
    if polarity_index is not None:
        result['polarityError'] = max(abs(r[value_index] - polarity_sign * r[polarity_index]) for r in rows)
    result['pass'] = all(result[k] <= tolerance for k in ['sampleError', 'eventError', 'interiorError', 'gridError']) and result.get('polarityError', 0) < 1e-8
    return result


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('operation', choices=['ltspice','plecs','compare-plecs']); parser.add_argument('paths', nargs='+'); args = parser.parse_args()
    if args.operation == 'compare-plecs':
        prepared = json.loads(pathlib.Path(args.paths[0]).read_text()); results = []
        for item in prepared['cases']:
            path = pathlib.Path(item['output'])
            if path.exists():
                try:
                    rows = [[float(v) for v in line.split(',')] for line in path.read_text().splitlines() if line.strip()]
                    result = plecs_checks(prepared,item['case'],rows)
                except (ValueError,IndexError) as exc:
                    result = {'pass':False,'error':str(exc)}
            else:
                result = {'pass':False,'error':'No actual output'}
            results.append({'case':item['case']['name'], **result})
        target = pathlib.Path(args.paths[0]).parent / ('comparison-' + uuid.uuid4().hex[:8] + '.json'); write(target,json.dumps(results,indent=2)); print(json.dumps({'path':str(target),'results':results},indent=2)); raise SystemExit(0 if results and all(r['pass'] for r in results) else 2)
    manifests = [pathlib.Path(p).resolve() for p in args.paths]
    cases = [c for p in manifests for c in json.loads(p.read_text())['cases']]
    directory = ROOT / 'outputs' / 'phase8' / ('simulators-' + args.operation + '-' + time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8]); directory.mkdir(parents=True)
    write(directory/'inputs.json', json.dumps([{'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in manifests],indent=2))
    if args.operation == 'ltspice':
        results=[]
        for case in cases:
            for export in case['exports']:
                if export['format'] not in ['pwl','pwl-file']: continue
                target=directory/(case['name']+'-'+export['format']); target.mkdir(); source=''
                for artifact in export['artifacts']:
                    path=pathlib.Path(export['directory'])/artifact['filename']; content=path.read_text(); write(target/path.name,content)
                    if path.suffix=='.cir': source=content
                # Source PWL corners force solver events. A large idle gap does not require a nanosecond global step.
                measure='I(I_LOAD)' if case['dimension']=='current' else 'V(1)'
                polarity='V(1)' if case['dimension']=='current' else 'I(V_SIGNAL)'
                deck=f'* Phase8 actual adapter\n{source}\nR_LOAD 1 0 1\n.options plotwinsize=0 numdgt=15 reltol=1e-9\n.save V(1) {measure} {polarity}\n.tran 0 {case["stop"]:.17g} 0 {case["stop"]/15000:.17g}\n.end\n'
                try:
                    names,rows=run_ltspice(target,deck); names=[n.lower() for n in names]; result=checks(case,rows,names.index(measure.lower()),names.index(polarity.lower()),1 if case['dimension']=='current' else -1)
                except Exception as exc: result={'pass':False,'error':str(exc)}
                result={'case':case['name'],'format':export['format'],'directory':str(target),**result}; results.append(result); print(json.dumps(result),flush=True)
        write(directory/'comparison.json',json.dumps(results,indent=2)); print(directory,flush=True); raise SystemExit(0 if results and all(r['pass'] for r in results) else 2)
    # Use the verified Phase5 model format and installed Lookup1D parameter names.
    import phase5_simulators as old
    prepared=[]; script="% Dedicated Phase8 adapter validation.\n"
    for case in cases:
        export=next(e for e in case['exports'] if e['format']=='plecs'); artifact=next(a for a in export['artifacts'] if a['role']=='primary'); data=pathlib.Path(export['directory'])/artifact['filename']
        _,_,ts=queries(case); output=directory/(case['name']+'.csv'); literal=' '.join(f'{t:.17g}' for t in ts)
        script+=f"\nrun('{data.as_posix()}');\nopts=struct(); opts.ModelVars=struct('t',t,'y',y);\nopts.SolverOpts=struct('StartTime',0,'TimeSpan',{case['stop']:.17g},'OutputTimes',[{literal}],'OutputTimesOption','specified','MaxStep',{case['stop']/15000:.17g},'RelTol',1e-9,'Timeout',120);\nout=plecs('simulate',opts);\ndlmwrite('{output.as_posix()}',[out.Time(:),out.Values(1,:)(:)],'precision','%.17g');\n"
        prepared.append({'case':case,'output':str(output)})
    script+=f"fid=fopen('{directory.as_posix()}/COMPLETE.txt','w'); fprintf(fid,'Completed actual Phase8 PLECS lookup runs.\\n'); fclose(fid);\n"
    import re
    prior=ROOT/'outputs/phase5/simulators/plecs-manual-20261106-221520-99a090c8/WavecraftPhase5_8c787e5f.plecs'
    model=prior.read_text(); name='WavecraftPhase8_'+uuid.uuid4().hex[:8]; model=model.replace('WavecraftPhase5_8c787e5f',name).replace('Wavecraft Phase5 validation','Wavecraft Phase8 validation'); model=re.sub(r'Script base64 "[^"]*"','Script base64 "'+base64.b64encode(script.encode()).decode()+'"',model)
    model_path=directory/(name+'.plecs'); write(model_path,model); write(directory/'run-validation.m',script); write(directory/'prepared.json',json.dumps({'model':str(model_path),'mode':'lookup','outputSchema':['time_s','lookup'],'header':'none','numericalResolutionVerified':False,'resolutionBlocker':'Actual ramp-relative refinement is required before acceptance. Lookup zero-crossing configuration alone is not verified.','scope':'Actual lookup output. Electrical source polarity is not measured by this model.','cases':prepared},indent=2)); print(model_path,flush=True)


if __name__=='__main__': main()
