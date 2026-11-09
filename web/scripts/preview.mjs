import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const portArgument = process.argv.find(argument => argument.startsWith('--port='));
const port = Number(portArgument?.split('=')[1] ?? 8771);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Select a port between 1024 and 65535.');
const latest = JSON.parse(await readFile(path.join(root, 'outputs/phase1/web/latest.json'), 'utf8'));
const routes = new Map([
  ['/', [path.join(root, 'prototypes/wavecraft-web-prototype.html'), 'text/html; charset=utf-8']],
  ['/wavecraft.html', [path.join(root, 'prototypes/wavecraft-web-prototype.html'), 'text/html; charset=utf-8']],
  ['/wavecraft-web-prototype.html', [path.join(root, 'prototypes/wavecraft-web-prototype.html'), 'text/html; charset=utf-8']]
]);
for (const [name, type] of [
  ['wavecraft-phase1.html', 'text/html; charset=utf-8'],
  ['HUMAN_TEST.md', 'text/plain; charset=utf-8'],
  ['phase1-sample-bom-crlf.yaml', 'application/octet-stream'],
  ['phase1-pixel.png', 'application/octet-stream'],
  ['phase1-sample-proof.zip', 'application/zip'],
  ['METADATA.json', 'application/json'],
  ['THIRD_PARTY_NOTICES.txt', 'text/plain; charset=utf-8']
]) routes.set(`/diagnostics/${name}`, [path.join(latest.directory, name), type]);
routes.set('/diagnostics/', routes.get('/diagnostics/wavecraft-phase1.html'));
const server = createServer(async (request, response) => {
  let route = routes.get(request.url ?? '');
  if (request.method === 'GET' && request.url === '/packaged/wavecraft.html') {
    try {
      const packaged = JSON.parse(await readFile(path.join(root, 'outputs/ui-restore/web/latest.json'), 'utf8'));
      route = [packaged.artifactPath, 'text/html; charset=utf-8'];
    } catch {
      response.writeHead(404);
      response.end('Build the editor package first.');
      return;
    }
  }
  if (request.method !== 'GET' || !route) {
    response.writeHead(404);
    response.end('Not found.');
    return;
  }
  try {
    const bytes = await readFile(route[0]);
    response.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(bytes);
  } catch {
    response.writeHead(500);
    response.end('The preview file could not be read.');
  }
});
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({
  editor: `http://127.0.0.1:${port}/`,
  diagnostics: `http://127.0.0.1:${port}/diagnostics/`,
  artifactPath: latest.artifactPath
}, null, 2)));
