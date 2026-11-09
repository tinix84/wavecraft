"""Prepare a separate PLECS electrical-polarity model from the lookup fixture."""
import base64
import json
import pathlib
import re
import sys
import time
import uuid
from phase5_simulators import ROOT, write

previous=pathlib.Path(sys.argv[1]); prepared=json.loads(previous.read_text())
directory=ROOT/'outputs/phase8'/('simulators-plecs-electrical-'+time.strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:8]); directory.mkdir()
model=pathlib.Path(prepared['model']).read_text(); script=(previous.parent/'run-validation.m').read_text(); name='WavecraftPhase8Electrical_'+uuid.uuid4().hex[:8]
model=re.sub(r'Name "WavecraftPhase8_[^"]+"','Name "'+name+'"',model, count=1)
script=script.replace(previous.parent.as_posix(),directory.as_posix()).replace('out.Values(1,:)(:)','out.Values.\'').replace('actual Phase8 PLECS lookup runs','actual Phase8 PLECS electrical runs')
for item in prepared['cases']: item['output']=str(directory/pathlib.Path(item['output']).name)

def component(kind,name,x,y,parameters=''):
    return f'    Component {{\n      Type {kind}\n      Name "{name}"\n      Show on\n      Position [{x}, {y}]\n      Direction right\n      Flipped off\n      LabelPosition south\n{parameters}    }}\n'

def connect(kind,source,st,target,tt):
    return f'    Connection {{\n      Type {kind}\n      SrcComponent "{source}"\n      SrcTerminal {st}\n      DstComponent "{target}"\n      DstTerminal {tt}\n    }}\n'

extra=''
for tag,kind,index,y in [('I','CurrentSource',2,200),('V','VoltageSource',3,300)]:
    extra+=component(kind,'Source'+tag,260,y)
    extra+=component('Resistor','Load'+tag,360,y,'      Parameter {\n        Variable "R"\n        Value "1"\n        Show on\n      }\n')
    extra+=component('PlecsProbe','Probe'+tag,450,y,'      Probe {\n        Component "Load'+tag+'"\n        Path ""\n        Signals {"Resistor voltage", "Resistor current"}\n      }\n')
    extra+=component('Output','Electrical'+tag,560,y,'      Parameter {\n        Variable "Index"\n        Value "'+str(index)+'"\n        Show off\n      }\n      Parameter {\n        Variable "Width"\n        Value "2"\n        Show off\n      }\n')
    extra+=connect('Signal','Lookup',2,'Source'+tag,3)
    extra+=connect('Wire','Source'+tag,2 if tag=='I' else 1,'Load'+tag,1)
    extra+=connect('Wire','Source'+tag,1 if tag=='I' else 2,'Load'+tag,2)
    extra+=connect('Signal','Probe'+tag,1,'Electrical'+tag,1)
model=model.replace('  Script {', '  Script {',1)
position=model.index('  Script {'); before=model[:position]; closing=before.rfind('  }'); model=before[:closing]+extra+before[closing:]+model[position:]
model=re.sub(r'Script base64 "[^"]*"','Script base64 "'+base64.b64encode(script.encode()).decode()+'"',model)
prepared.update(model=str(directory/(name+'.plecs')),mode='electrical',outputSchema=['time_s','lookup','current_load_V','current_load_A','voltage_load_V','voltage_load_A'],header='none',numericalResolutionVerified=False,resolutionBlocker='Actual ramp-relative refinement is required before acceptance. The 133 us maximum step exceeds the 100 ns burst ramps.',scope='Columns: time, lookup, current-source load voltage/current, voltage-source load voltage/current. All loads are 1 ohm. Expected positive polarity for every load quantity.')
write(pathlib.Path(prepared['model']),model); write(directory/'prepared.json',json.dumps(prepared,indent=2)); write(directory/'run-validation.m',script)
print(prepared['model'])
