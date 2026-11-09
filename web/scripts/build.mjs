import { build } from 'esbuild';
import { zipSync } from 'fflate';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packProof, samplePngBase64, sampleYaml } from '../src/proof.ts';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
export const outputRoot = path.resolve(webRoot, '../outputs/phase1/web');
const sha256 = value => createHash('sha256').update(value).digest('hex');

export const checklist = `# Wavecraft Phase 1 human direct-file test

Document ID: WC-P1-FILE-001 · Version: 1.0 · Date: 2026-11-05

This card records a point-in-time test. It does not establish full editor readiness.
The browser automation policy blocks file URLs. A person must perform this test.
Record each browser version, operating system, HTML path, HTML SHA-256, and test date.
Use one copy of this card for Chrome and one for Edge.

1. Disconnect networking.
2. Open wavecraft-phase1.html directly from disk.
3. Confirm that the page reports the file: protocol.
4. Import phase1-sample-bom-crlf.yaml through the YAML input.
5. Import phase1-pixel.png through the image input.
6. Confirm a valid YAML syntax result and visible image.
7. Download the original YAML and image.
8. Compare their bytes with the imported files.
9. Download the proof ZIP.
10. Reopen the downloaded ZIP through the ZIP input.
11. Confirm that all three payload comparison fields are true.
12. Click the center cross and record its coordinates.
13. Set the view zoom to 2× and the panel width to 50%.
14. Resize the browser window.
15. Click the center cross again.
16. Confirm that both clicks are within two SVG units of (200, 120).
17. Run the native transform check.
18. Confirm an error below 1e-8 SVG units.
19. Write a recovery revision.
20. Wait for the transaction complete message.
21. Reload this same HTML file.
22. Read the recovery revision.
23. Confirm that all saved-original-byte comparison fields are true.
24. Enable simulated denied recovery storage.
25. Attempt a recovery write.
26. Confirm the visible recovery limitation.
27. Download and reopen another ZIP while storage remains denied.
28. Confirm that all three ZIP comparison fields remain true.
29. Download the diagnostic report.
30. Record observations and attach the downloaded files.

## Test record

- Browser and version:
- Operating system:
- HTML path and SHA-256:
- Test date:
- Networking disconnected:
- YAML and image local import:
- Downloaded raw byte comparisons:
- Downloaded ZIP reopen comparison:
- Pointer coordinates before and after zoom, width change, and resize:
- Native matrix error:
- Recovery transaction complete:
- Recovery read after reload:
- Denied storage limitation and explicit ZIP save/import:
- Diagnostic report path:
- Result: PENDING
- Failures and observations:

## Limits

HTTP tests do not prove direct-file operation.
Each browser uses its own origin storage.
Moving the HTML can change storage behavior.
Recovery is not an explicit portable backup.
The proof container is not the future version 1 project format.
Do not use this result as simulator or waveform compilation evidence.
`;

export async function buildArtifact({ release = false } = {}) {
  const buildId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const directory = path.join(outputRoot, `${release ? 'release' : 'build'}-${buildId}`);
  await mkdir(directory, { recursive: true });
  const pkg = JSON.parse(await readFile(path.join(webRoot, 'package.json'), 'utf8'));
  const lock = await readFile(path.join(webRoot, 'package-lock.json'));
  const notices = (await Promise.all(['yaml/LICENSE', 'fflate/LICENSE', 'esbuild/LICENSE.md'].map(async name => {
    return `${name}\n${await readFile(path.join(webRoot, 'node_modules', name), 'utf8')}`;
  }))).join('\n\n');
  const metadata = {
    scope: 'Phase 1 offline portability proof. No waveform compiler or full editor.',
    buildId, generatedAt: new Date().toISOString(), node: process.version,
    runtimeDependencies: pkg.dependencies, developerDependencies: pkg.devDependencies,
    lockfileSha256: sha256(lock), standalone: true, noExternalAssets: true,
    runtimeNetworkRequests: false, serviceWorker: false, filesystemAccessApi: false,
    fileOriginHumanGate: 'PENDING. Use HUMAN_TEST.md in Chrome and Edge.',
    notices: 'THIRD_PARTY_NOTICES.txt'
  };
  // Documented in-memory IIFE build. esbuild is a developer dependency only.
  // https://esbuild.github.io/api/#write
  // https://esbuild.github.io/api/#format
  // https://esbuild.github.io/api/#platform
  const bundled = await build({
    absWorkingDir: webRoot, entryPoints: ['src/main.ts'], bundle: true,
    platform: 'browser', format: 'iife', target: ['chrome110', 'edge110'],
    write: false, outfile: 'proof.js', metafile: true, minify: true, legalComments: 'inline',
    define: { __BUILD_META__: JSON.stringify(metadata), __NOTICES__: JSON.stringify(notices), __CHECKLIST__: JSON.stringify(checklist) }
  });
  const externalImports = Object.values(bundled.metafile.outputs).flatMap(output => output.imports.filter(entry => entry.external));
  if (externalImports.length) throw new Error('The browser bundle has external imports.');
  const script = bundled.outputFiles.find(file => file.path.endsWith('.js'))?.text;
  if (!script) throw new Error('esbuild did not return a JavaScript output file.');
  const template = await readFile(path.join(webRoot, 'src/index.html'), 'utf8');
  const css = await readFile(path.join(webRoot, 'src/style.css'), 'utf8');
  if (/@import|url\(/i.test(css)) throw new Error('The CSS contains an external asset pattern.');
  const html = template.replace('/*INLINE_CSS*/', () => css).replace('/*INLINE_JS*/', () => script.replace(/<\/script/gi, '<\\/script'));
  if (/<script\b[^>]*\bsrc\s*=|<link\b|<iframe\b|<object\b/i.test(html)) throw new Error('The HTML contains an external asset tag.');
  const bomYaml = Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(sampleYaml)]);
  const png = Buffer.from(samplePngBase64, 'base64');
  const fixture = { yamlName: 'phase1-sample-bom-crlf.yaml', yaml: new Uint8Array(bomYaml), image: { name: 'phase1-pixel.png', mime: 'image/png', bytes: new Uint8Array(png) } };
  const fixtureZip = packProof(fixture);
  const artifactPath = path.join(directory, 'wavecraft-phase1.html');
  const metadataFile = { ...metadata, artifactSha256: sha256(html), artifactBytes: Buffer.byteLength(html),
    esbuildExternalImports: externalImports, yamlFixtureSha256: sha256(bomYaml), imageFixtureSha256: sha256(png),
    fixtureZipSha256: sha256(fixtureZip), fixtureZipBytes: fixtureZip.length };
  const files = {
    'wavecraft-phase1.html': Buffer.from(html),
    'THIRD_PARTY_NOTICES.txt': Buffer.from(notices),
    'LICENSE.txt': await readFile(path.join(webRoot, '../LICENSE')),
    'METADATA.json': Buffer.from(JSON.stringify(metadataFile, null, 2)),
    'HUMAN_TEST.md': Buffer.from(checklist),
    'phase1-sample-bom-crlf.yaml': bomYaml,
    'phase1-pixel.png': png,
    'phase1-sample-proof.zip': fixtureZip,
    'bundle-metafile.json': Buffer.from(JSON.stringify(bundled.metafile, null, 2))
  };
  // Every build owns a new directory. The wx flag prevents accidental replacement.
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(directory, name), bytes, { flag: 'wx' });
  let releasePath;
  if (release) {
    releasePath = path.join(directory, 'wavecraft-phase1-release.zip');
    await writeFile(releasePath, zipSync(files, { level: 6 }), { flag: 'wx' });
  }
  const latest = { artifactPath, directory, releasePath, metadata: metadataFile };
  // This file is owned location metadata. Artifacts remain immutable.
  await writeFile(path.join(outputRoot, 'latest.json'), JSON.stringify(latest, null, 2));
  return latest;
}

export async function buildEditorArtifact({ release = false } = {}) {
  await bundleSemanticEditor();
  const proof = await buildArtifact();
  const buildId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const editorOutputRoot = path.resolve(webRoot, '../outputs/ui-restore/web');
  const directory = path.join(editorOutputRoot, `${release ? 'release' : 'build'}-${buildId}`);
  await mkdir(path.join(directory, 'diagnostics'), { recursive: true });
  const html = await readFile(path.resolve(webRoot, '../prototypes/wavecraft-web-prototype.html'));
  const files = { 'wavecraft.html': html };
  for (const name of await readdir(proof.directory)) {
    files[`diagnostics/${name}`] = await readFile(path.join(proof.directory, name));
  }
  const metadata = {
    scope: 'Existing Wavecraft editor with semantic authoring, source transactions, FFT and ideal filter analysis, shared compiled target exports, portable project ZIPs, and local browser recovery. Phase 7 adds checked linear image calibration, raw and corrected reconstruction, explicit CSV mapping, and persistent extraction evidence. CSV, LTspice, PLECS, and language-array exports remain available. Simulator validation and native cross-browser verification require separate evidence.',
    buildId, primary: 'wavecraft.html', diagnostics: 'diagnostics/wavecraft-phase1.html',
    artifactSha256: sha256(html), artifactBytes: html.length,
    source: 'prototypes/wavecraft-web-prototype.html'
  };
  files['EDITOR_METADATA.json'] = Buffer.from(JSON.stringify(metadata, null, 2));
  for (const [name, bytes] of Object.entries(files)) {
    await writeFile(path.join(directory, name), bytes, { flag: 'wx' });
  }
  const artifactPath = path.join(directory, 'wavecraft.html');
  let releasePath;
  if (release) {
    releasePath = path.join(directory, 'wavecraft-editor-release.zip');
    await writeFile(releasePath, zipSync(files, { level: 6 }), { flag: 'wx' });
  }
  const latest = { artifactPath, directory, releasePath, metadata };
  await writeFile(path.join(editorOutputRoot, 'latest.json'), JSON.stringify(latest, null, 2));
  return latest;
}

export async function bundleSemanticEditor() {
  const bundled = await build({
    absWorkingDir: webRoot, entryPoints: ['src/editor-semantic-entry.ts'], bundle: true,
    platform: 'browser', format: 'iife', target: ['chrome110', 'edge110'], write: false,
    minify: true, legalComments: 'inline', metafile: true
  });
  const external = Object.values(bundled.metafile.outputs).flatMap(output => output.imports.filter(entry => entry.external));
  if (external.length) throw new Error('The semantic editor bundle has external imports.');
  const script = bundled.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const prototypePath = path.resolve(webRoot, '../prototypes/wavecraft-web-prototype.html');
  const original = await readFile(prototypePath, 'utf8');
  const start = '/*WAVECRAFT_SEMANTIC_BUNDLE_START*/', end = '/*WAVECRAFT_SEMANTIC_BUNDLE_END*/';
  if (!original.includes(start) || !original.includes(end)) throw new Error('Semantic bundle markers are missing.');
  const from = original.indexOf(start) + start.length, to = original.indexOf(end, from);
  await writeFile(prototypePath, original.slice(0, from) + '\n' + script + '\n' + original.slice(to));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const buildSelected = process.argv.includes('--proof') ? buildArtifact : buildEditorArtifact;
  console.log(JSON.stringify(await buildSelected({ release: process.argv.includes('--release') }), null, 2));
}
