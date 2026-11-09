// Keep the published source and each acceptance run as separate local records.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { checkCalibration, rawPointsSI, correctedPointsSI, candidateSource } from '../../web/src/digitize/index.ts';
import { compileYaml, expandFinite } from '../../web/src/semantic/index.ts';
import { exportWaveform } from '../../web/src/export/index.ts';
import { packProject, unpackProject } from '../../web/src/project/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const original = path.join(root, 'outputs/phase7/article-20261107-132246');
const directory = path.join(root, 'outputs/phase7', `article-acceptance-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(directory);
const write = (name, data) => fs.writeFileSync(path.join(directory, name), data, { flag: 'wx' });
const json = (name, data) => write(name, JSON.stringify(data, null, 2) + '\n');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pixels = [[515,574],[529,575],[536,590],[541,675],[546,677],[551,565],[600,565],[610,574],[614,678],[614,574],[622,566],[632,575]];
// These independent formulas use the hand-selected tick locations, not the digitization implementation.
const expectedRaw = pixels.map(([x,y]) => [1 + (x - 398) * 5 / 584, 15 + (675 - y) * 30 / 100]);
const expectedCorrected = expectedRaw.map(p => [...p]);
expectedCorrected[9][0] += .01;
const assumptions = 'The source axis is normalized Load (%), not measured current. Assume constant voltage and an equivalent test-current scale of 100% = 100 A (1 A per percentage point). This does not establish physical GPU current. Keep the published time origin. Assume an initial hold from 0 s to the first selected timestamp. The manual points form a coarse local trace of the upper envelope and two troughs; they omit high-frequency detail. The apparent vertical return at raw indices 8 and 9 has no resolved duration. Assume a finite edge of 0.01 s by moving only index 9. Hold the last value after the final point. No smoothing, automatic sorting, or physical slew claim applies.';
const provenance = {
  article: '800 VDC Architecture for Next-Generation AI Infrastructure; Jared Huntington and Mike Tu; NVIDIA; https://www.nvidia.com/en-us/data-center/technologies/800-vdc-architecture/',
  page: 'PDF page 6 (printed page 6)',
  figure: 'Top Figure 4: GPU Load Swings during an LLM workload. The bottom illustration also says Figure 4 and is not the selected plot.',
  series: 'Green Load (%) trace. Bounded manual interval near 2 to 3 seconds.',
  notes: 'Public PDF https://dam-cdn.nvd.orangelogic.com/AssetLink/qq0vy0u48xfr0c81i2m1781pwea64n8v.pdf. Original page render 1391 by 1800 pixels. All clicks use this full image. No crop or rescale. Integer manual clicks; arithmetic decimals do not express measurement precision. External WebPlotDigitizer calibration metadata is unavailable. No actual WebPlotDigitizer session produced this fixture.'
};
const native = {
  extraction: { kind: 'image', size: [1391,1800], calibration: { dimension: 'current', timeUnit: 's', valueUnit: 'A', axes: 'linear', rotation: 'axis-aligned', x: [{pixel:[398,692],value:1},{pixel:[982,692],value:6}], y: [{pixel:[297,675],value:15},{pixel:[297,575],value:45}], tick:{axis:'x',pixel:[632,692],value:3,tolerance:.02} }, pixels },
  corrections: [{index:9,point:expectedCorrected[9],note:'Assume a 0.01 s finite return edge. Move only the second same-time click. The image does not resolve its physical duration.'}], assumptions, provenance, finiteEdgesConfirmed:true, initialHoldConfirmed:true
};
// The CSV is manual test input in a WPD-compatible two-column form.
const csv = 'time_s,equivalent_current_A\r\n' + expectedRaw.map(p => p.join(',')).join('\r\n') + '\r\n';
const external = { extraction: {kind:'csv',name:'manual-wpd-style.csv',text:csv,mapping:{dimension:'current',timeUnit:'s',valueUnit:'A',xColumn:0,yColumn:1,delimiter:',',decimal:'.',header:true,confirmed:true}}, corrections:structuredClone(native.corrections), assumptions, provenance, finiteEdgesConfirmed:true, initialHoldConfirmed:true };
const sourceImage = new Uint8Array(fs.readFileSync(path.join(original,'nvidia-page6.png')));
json('source-record.json', { capturedAt:new Date().toISOString(), provenance, assumptions, originalDirectory:original, originalSize:[1391,1800], crop:null, files:['nvidia-800vdc-whitepaper.pdf','nvidia-page6.png'].map(name=>({name,sha256:hash(fs.readFileSync(path.join(original,name)))})), rawAxisUnits:{time:'s',value:'Load (%)'}, equivalentCurrentScale:'1 A per load percentage point; engineering assumption', tolerances:{independentTickS:.02,arithmeticAbs:1e-12,ltspiceCurrentAbsA:1e-5,ltspicePolarityAbsA:1e-8,pixelSensitivity:{perPixelS:5/584,perPixelPercentagePoints:.3,assumedManualPixelRadius:2},physicalMeasurementUncertainty:'Unavailable. These tolerances do not bound physical uncertainty.'} });
json('native-digitization.json',native); json('csv-digitization.json',external); write('manual-wpd-style.csv',csv);
json('independent-baseline.json',{raw:expectedRaw,corrected:expectedCorrected,compiled:[[0,expectedCorrected[0][1]],...expectedCorrected],method:'Independent hand-selected integer pixels and explicit linear-axis formulas. Includes declared initial hold.',solverToleranceA:1e-5});
const close = (a,b) => { assert.equal(a.length,b.length); a.forEach((p,i)=>p.forEach((v,j)=>assert.ok(Math.abs(v-b[i][j])<1e-12,`${i},${j}: ${v} != ${b[i][j]}`))); };
const tick = checkCalibration(native.extraction.calibration); assert.equal(tick.passed,true);
const cases=[];
for (const [label,record] of [['native',native],['csv',external]]) {
  close(rawPointsSI(record.extraction),expectedRaw); close(correctedPointsSI(record),expectedCorrected);
  const rawOnly={...record,corrections:[]}; assert.throws(()=>candidateSource(rawOnly),/duplicate|backward/i);
  const accepted=candidateSource(record); write(`${label}-accepted.yaml`,accepted.source);
  const result=compileYaml(accepted.source); assert.equal(result.ok,true);
  const expanded=expandFinite(result.compiled); assert.equal(expanded.ok,true); close(expanded.points,[[0,expectedCorrected[0][1]],...expectedCorrected]);
  const snapshot={revisionId:`phase7-article-${label}`,mode:'semantic',source:accepted.source,evidence:{image:{name:'nvidia-page6.png',mime:'image/png',bytes:sourceImage},notes:JSON.stringify({provenance,assumptions}),transforms:{originalSize:[1391,1800],viewSize:[1391,1800],crop:null,reference:'image'},digitization:record}};
  const packed=packProject(snapshot); write(`${label}.wavecraft.zip`,packed); const reopened=unpackProject(packed);
  assert.deepEqual(reopened,snapshot); assert.equal(hash(reopened.evidence.image.bytes),hash(sourceImage));
  const exports=[];
  for (const format of ['csv','pwl','pwl-file','plecs']) {
    const exported=exportWaveform(result.compiled,{format,name:`article-${label}`}); assert.equal(exported.ok,true);
    const target=path.join(directory,`${label}-${format}`); fs.mkdirSync(target);
    for(const a of exported.artifacts) fs.writeFileSync(path.join(target,a.filename),a.content,{flag:'wx'});
    exports.push({format,directory:target,artifacts:exported.artifacts.map(({filename,role})=>({filename,role})),metadata:exported.metadata});
  }
  cases.push({name:`article-${label}`,dimension:'current',expected:{points:[[0,expectedCorrected[0][1]],...expectedCorrected]},stop:3.1,exports});
}
json('manifest.json',{generatedAt:new Date().toISOString(),cases});
json('verification.json',{tick,apiRawAndCorrectedComparisons:'pass',rawDuplicateRejection:'pass',archiveRoundTrip:'pass; source, notes, digitization and original image bytes',adapters:'generated through actual APIs; simulator comparison pending',plecs:'Unverified. No native or RPC simulator run.',webPlotDigitizer:'Not run. CSV uses manually selected source-image points.',nativeBrowserAndCrossBrowser:'Not established by this script.'});
console.log(directory);
