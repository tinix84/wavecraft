"""Prepare and check event-aware PLECS runs with bounded tight-step refinements."""
import base64
import copy
import hashlib
import json
import math
import pathlib
import re
import sqlite3
import sys
import time
import uuid
import zlib
from phase5_simulators import ROOT, interpolate, write
from phase8_simulators import checks, queries, validate_rows

SCHEMA=['time_s','lookup','current_load_V','current_load_A','voltage_load_V','voltage_load_A']
FIXTURES=['A-175','A-200','signed-voltage','C-one','C-two','article-native','article-csv']

def validate_matrix(prepared):
    expected={(name,kind) for name in FIXTURES for kind in (['full','refine-0','refine-1','refine-2'] if name.startswith('C-') else ['full','refine'])}
    actual=[(r['originalName'],r['kind']) for r in prepared['runs']]
    if len(actual)!=18 or len(set(actual))!=18 or set(actual)!=expected:
        raise ValueError('All seven fixtures and 18 unique full/refinement runs are required')
    for item in prepared['runs']:
        if item['originalName'].startswith('C-') and item['kind']!='full':
            burst=int(item['kind'].split('-')[1]); case=item['case']
            if item['maxStepS']>1e-8 or not (case['start']<=burst and case['stop']>=burst+9.6e-6):
                raise ValueError('Each burst requires a full local refinement window at 10 ns or less')

def prepare(path):
    prior=json.loads(path.read_text()); directory=ROOT/'outputs/phase8'/('simulators-plecs-refinement-'+time.strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:8]); directory.mkdir()
    name='WavecraftPhase8Refined_'+uuid.uuid4().hex[:8]; model=pathlib.Path(prior['model']).read_text(); model=re.sub(r'Name\s+"[^"]+"','Name "'+name+'"',model,count=1)
    # Installed parameter-sweep demo declares each top-level circuit terminal
    # before Schematic, in addition to the Output component Index parameter.
    terminals=''.join(f'  Terminal {{\n    Type Output\n    Index "{index}"\n  }}\n' for index in [1,2,3])
    model=model.replace('  Schematic {',terminals+'  Schematic {',1)
    records=[]; script="% Dedicated event-aware validation and independent tight-step refinement.\n"
    for item in prior['cases']:
        case=item['case']; export=next(e for e in case['exports'] if e['format']=='plecs'); artifact=next(a for a in export['artifacts'] if a['role']=='primary'); source=pathlib.Path(export['directory'])/artifact['filename']
        durations=[b[0]-a[0] for a,b in zip(case['expected']['points'],case['expected']['points'][1:]) if b[0]>a[0]]; tight=min(durations)/10
        runs=[('full',0,case['stop'],case['stop']/15000)]
        if 'outer' in case['expected']:
            for j in range(int(case['stop']/case['expected']['outer'])+1):
                burst=j*case['expected']['outer']; end=min(case['stop'],burst+case['expected']['period']*case['expected']['count'])
                runs.append(('refine-'+str(j),max(0,burst-min(durations)),end,tight))
        else: runs.append(('refine',0,case['stop'],min(tight,case['stop']/30000)))
        for label,start,stop,step in runs:
            bounded=copy.deepcopy(case); bounded.update(start=start,stop=stop); ts=queries(bounded)[2]
            if label!='full': ts=sorted(set(ts+[t for t in queries(case)[2] if start<=t<=stop]))
            output=directory/(case['name']+'-'+label+'.csv'); literal=' '.join(f'{t:.17g}' for t in ts)
            script+=f"\n% {case['name']} {label}\nrun('{source.as_posix()}');\nopts=struct(); opts.ModelVars=struct('t',t,'y',y);\nopts.SolverOpts=struct('Solver','dopri','StartTime',{start:.17g},'TimeSpan',{stop-start:.17g},'OutputTimes',[{literal}],'OutputTimesOption','specified','MaxStep',{step:.17g},'RelTol',1e-10,'AbsTol',1e-12,'Timeout',120);\nout=plecs('simulate',opts);\nfid=fopen('{output.with_suffix('.runtime.txt').as_posix()}','w'); fprintf(fid,'TimeSize=%s ValuesSize=%s\\n',mat2str(size(out.Time)),mat2str(size(out.Values))); fclose(fid);\nassert(numel(out.Time)>1,'No actual output timestamps');\nif size(out.Values,1)==5 && size(out.Values,2)==numel(out.Time)\n values=out.Values.';\nelseif size(out.Values,2)==5 && size(out.Values,1)==numel(out.Time)\n values=out.Values;\nelse\n error('Expected exactly five measured output channels');\nend\ndlmwrite('{output.as_posix()}',[out.Time(:),values],'precision','%.17g');\n"
            records.append({'case':bounded,'originalName':case['name'],'kind':label,'output':str(output),'source':str(source),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'maxStepS':step,'minimumSegmentS':min(durations),'requiredTimes':ts})
    script+=f"fid=fopen('{directory.as_posix()}/COMPLETE.txt','w'); fprintf(fid,'Completed full and refinement PLECS runs.\\n'); fclose(fid);\n"
    # PLECS requires component declarations before connections. Replace the whole
    # script block because the GUI can serialize scripts as adjacent strings.
    script_start=re.search(r'^  Script \{',model,re.M).start()
    wrapper="run('"+(directory/'run-validation.m').as_posix()+"');\n"
    model=model[:script_start]+'  Script {\n    Name "Wavecraft Phase8 refinement"\n    Script base64 "'+base64.b64encode(wrapper.encode()).decode()+'"\n  }\n}\n'
    schematic_start=re.search(r'^  Schematic \{',model,re.M).end()
    first=re.search(r'^    (?:Component|Connection) \{',model[schematic_start:],re.M).start()+schematic_start
    schematic_end=model.rfind('\n  }',0,model.index('  Script {'))
    contents=model[first:schematic_end]
    starts=list(re.finditer(r'^    (Component|Connection) \{',contents,re.M))
    blocks=[(match.group(1),contents[match.start():starts[i+1].start() if i+1<len(starts) else len(contents)]) for i,match in enumerate(starts)]
    # A signal output has one Connection with Branch children for fanout.
    blocks=[(kind,block) for kind,block in blocks if not (kind=='Connection' and re.search(r'SrcComponent\s+"Lookup"',block))]
    fanout='    Connection {\n      Type Signal\n      SrcComponent "Lookup"\n      SrcTerminal 2\n'
    for target,terminal in [('Measured',1),('Scope',1),('SourceI',3),('SourceV',3)]:
        fanout+=f'      Branch {{\n        DstComponent "{target}"\n        DstTerminal {terminal}\n      }}\n'
    blocks.append(('Connection',fanout+'    }\n'))
    for i,(kind,block) in enumerate(blocks):
        if kind=='Component':
            match=re.search(r'Name\s+"(Measured|ElectricalI|ElectricalV)"',block)
            if match:
                index={'Measured':1,'ElectricalI':2,'ElectricalV':3}[match.group(1)]
                block=re.sub(r'(Variable\s+"Index"\s+Value\s+")[^"]+',lambda m:m.group(1)+str(index),block)
                blocks[i]=(kind,block)
    ordered=''.join(block for kind in ['Component','Connection'] for actual,block in blocks if kind==actual)
    model=model[:first]+ordered+model[schematic_end:]
    embedded=base64.b64decode(re.search(r'Script base64 "([^"]+)"',model).group(1)).decode()
    assert embedded==wrapper and script.count("plecs('simulate'")==len(records)
    kinds=[kind for kind,block in sorted(blocks,key=lambda item:0 if item[0]=='Component' else 1)]
    assert kinds==sorted(kinds,key=lambda kind:0 if kind=='Component' else 1)
    write(directory/(name+'.plecs'),model); write(directory/'run-validation.m',script)
    help_path=pathlib.Path(r'D:\OneDrive\Documenti\Plexim\PLECS 4.9 (64 bit)\onlinehelp\plecshelp.qch'); db=sqlite3.connect(help_path.as_uri()+'?mode=ro',uri=True)
    docs={}
    for filename in ['lookup1d.html','scripting.html']:
        identifier=db.execute('SELECT FileId FROM FileNameTable WHERE Name=?',(filename,)).fetchone()[0]; data=db.execute('SELECT Data FROM FileDataTable WHERE Id=?',(identifier,)).fetchone()[0]; content=zlib.decompress(data[4:]).decode(); write(directory/filename,content); docs[filename]={'fileId':identifier,'sha256':hashlib.sha256(content.encode()).hexdigest()}
    prepared={'model':str(directory/(name+'.plecs')),'externalScript':str(directory/'run-validation.m'),'externalScriptSha256':hashlib.sha256((directory/'run-validation.m').read_bytes()).hexdigest(),'embeddedWrapper':wrapper,'wrapperSha256':hashlib.sha256(wrapper.encode()).hexdigest(),'mode':'electrical','header':'none','outputSchema':SCHEMA,'numericalResolutionVerified':False,'strategy':'Lookup1D ZeroCrossingSignals=1 locates mapping derivative discontinuities per installed lookup1d.html. Full spans retain long idle gaps. Tight-step refinements cover every burst and full other fixtures at minimum segment duration/10 or smaller. Acceptance requires all actual outputs, independent waveform checks, refinement agreement and pulse identity.','documentation':docs,'runs':records}
    write(directory/'prepared.json',json.dumps(prepared,indent=2)); print(prepared['model'])

def compare(path):
    prepared=json.loads(path.read_text()); results=[]; measured={}; failures=[]
    if hashlib.sha256(pathlib.Path(prepared['externalScript']).read_bytes()).hexdigest()!=prepared['externalScriptSha256']:
        raise ValueError('External validation script hash changed')
    if hashlib.sha256(prepared['embeddedWrapper'].encode()).hexdigest()!=prepared['wrapperSha256']:
        raise ValueError('Embedded wrapper hash changed')
    if prepared.get('outputSchema')!=SCHEMA or prepared.get('mode')!='electrical' or prepared.get('header')!='none' or not prepared.get('runs'): raise ValueError('Invalid refinement schema')
    validate_matrix(prepared)
    for item in prepared['runs']:
        key=(item['originalName'],item['kind']); output=pathlib.Path(item['output'])
        try:
            if hashlib.sha256(pathlib.Path(item['source']).read_bytes()).hexdigest()!=item['sourceSha256']: raise ValueError('Exported source vector hash changed')
            rows=[[float(x) for x in line.split(',')] for line in output.read_text().splitlines() if line.strip()]
            validate_rows(item['case'],rows,6,item['requiredTimes']); channels=[checks(item['case'],rows,index,1 if index>1 else None) for index in range(1,6)]
            for index,channel in enumerate(channels):
                channel['channel']=SCHEMA[index+1]
                if index>0: channel['unit']='V' if index in [1,3] else 'A'
            result={'case':key[0],'kind':key[1],'channels':channels,'pass':all(c['pass'] for c in channels)}; measured[key]=rows
        except (OSError,ValueError,IndexError) as exc: result={'case':key[0],'kind':key[1],'pass':False,'error':str(exc)}
        results.append(result)
    agreements=[]; identities=[]
    for item in prepared['runs']:
        key=(item['originalName'],item['kind']); full=measured.get((key[0],'full')); refined=measured.get(key)
        if item['kind']=='full' or full is None or refined is None: continue
        shared=[row for row in full if refined[0][0]<=row[0]<=refined[-1][0]]
        errors=[max((abs(row[i]-interpolate([(r[0],r[i]) for r in refined],row[0])) for row in shared),default=math.inf) for i in range(1,6)]
        tolerance=checks(item['case'],refined)['absoluteTolerance']; agreements.append({'case':key[0],'kind':key[1],'sharedTimes':len(shared),'channelErrors':errors,'tolerance':tolerance,'pass':bool(shared) and all(e<=tolerance for e in errors)})
    for item in prepared['runs']:
        if item['kind']!='full' or not item['originalName'].startswith('C-'): continue
        rows=measured.get((item['originalName'],'full'))
        if rows is None: continue
        case=item['case']; points=case['expected']['points']; threshold=min(p[1] for p in points if p[1]>0)/2
        per_pattern=sum(a[1]<threshold<=b[1] for a,b in zip(points,points[1:])); count=(int(case['stop']/case['expected']['outer'])+1)*case['expected']['count']*per_pattern
        expected_crossings=[j*case['expected']['outer']+k*case['expected']['period']+a[0]+(b[0]-a[0])*(threshold-a[1])/(b[1]-a[1]) for j in range(3) for k in range(10) for a,b in zip(points,points[1:]) if a[1]<threshold<=b[1]]
        crossings=[[a[0]+(b[0]-a[0])*(threshold-a[i])/(b[i]-a[i]) for a,b in zip(rows,rows[1:]) if a[i]<threshold<=b[i]] for i in range(1,6)]
        counts=[len(c) for c in crossings]; timing=[max((abs(a-b) for a,b in zip(expected_crossings,c)),default=math.inf) for c in crossings]
        identities.append({'case':item['originalName'],'threshold':threshold,'expectedPulses':count,'measuredCounts':counts,'expectedCrossingTimesS':expected_crossings,'measuredCrossingTimesS':crossings,'maximumTimingErrorS':timing,'timeToleranceS':1e-10,'pass':all(n==count for n in counts) and all(error<=1e-10 for error in timing)})
    expected_refinements=sum(r['kind']!='full' for r in prepared['runs']); expected_identity=sum(r['kind']=='full' and r['originalName'].startswith('C-') for r in prepared['runs'])
    passed=all(r['pass'] for r in results) and len(agreements)==expected_refinements and all(r['pass'] for r in agreements) and len(identities)==expected_identity and all(r['pass'] for r in identities)
    result={'numericalResolutionVerified':passed,'results':results,'refinementAgreements':agreements,'pulseIdentity':identities,'pass':passed}; output=path.parent/('comparison-'+uuid.uuid4().hex[:8]+'.json'); write(output,json.dumps(result,indent=2)); print(json.dumps({'path':str(output),'pass':passed,'runs':len(results),'passed':sum(r['pass'] for r in results)})); raise SystemExit(0 if passed else 2)

if __name__=='__main__':
    (prepare if sys.argv[1]=='prepare' else compare)(pathlib.Path(sys.argv[2]))
