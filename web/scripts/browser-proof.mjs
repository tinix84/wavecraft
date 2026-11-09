import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildArtifact, outputRoot } from './build.mjs';

const portArgument = process.argv.find(argument => argument.startsWith('--port='));
const port = Number(portArgument?.split('=')[1] ?? 8771);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Select a port between 1024 and 65535.');
let latest;
try { latest = JSON.parse(await readFile(path.join(outputRoot, 'latest.json'), 'utf8')); }
catch { latest = await buildArtifact(); }
const routes = new Map([
  ['/', ['wavecraft-phase1.html', 'text/html; charset=utf-8']],
  ['/wavecraft-phase1.html', ['wavecraft-phase1.html', 'text/html; charset=utf-8']],
  ['/HUMAN_TEST.md', ['HUMAN_TEST.md', 'text/plain; charset=utf-8']],
  ['/phase1-sample-bom-crlf.yaml', ['phase1-sample-bom-crlf.yaml', 'application/octet-stream']],
  ['/phase1-pixel.png', ['phase1-pixel.png', 'application/octet-stream']],
  ['/phase1-sample-proof.zip', ['phase1-sample-proof.zip', 'application/zip']],
  ['/METADATA.json', ['METADATA.json', 'application/json']],
  ['/THIRD_PARTY_NOTICES.txt', ['THIRD_PARTY_NOTICES.txt', 'text/plain; charset=utf-8']]
]);
const server = createServer(async (request, response) => {
  const route = routes.get(request.url ?? '');
  if (request.method !== 'GET' || !route) { response.writeHead(404); response.end('Not found.'); return; }
  try {
    const bytes = await readFile(path.join(latest.directory, route[0]));
    response.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(bytes);
  } catch { response.writeHead(500); response.end('The proof artifact could not be read.'); }
});
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({
  mode: 'MANUAL browser proof. This command does not automate a browser or report test passes.',
  url: `http://127.0.0.1:${port}/`, artifactPath: latest.artifactPath,
  checklist: `http://127.0.0.1:${port}/HUMAN_TEST.md`,
  fixtures: [...routes.keys()].filter(route => route.includes('sample') || route.includes('pixel')),
  pendingGate: 'Human direct-file offline test in Chrome and Edge. HTTP does not satisfy it.'
}, null, 2)));
