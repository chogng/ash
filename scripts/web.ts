import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import sirv from 'sirv';
import { compile } from '../build/lib/compilation.ts';
import { webAppServerOptions } from '../build/lib/appServer.ts';

const repositoryRoot = resolve(import.meta.dirname, '..');
const root = resolve(process.argv[2] ?? resolve(repositoryRoot, '.build/desktop/renderer/ash'));
const port = Number(process.argv[3] ?? 5173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Web server port');
const serve = sirv(root, { etag: true });
const server = createServer((request, response) => {
  if (request.url === '/') {
    response.writeHead(302, { Location: '/browser/workbench/workbench.html' });
    response.end();
    return;
  }
  serve(request, response);
});
let closeConnections: (() => Promise<void>) | undefined;
if (process.env.ASH_WEB_APP_SERVER === '1') {
  await compile(['node']);
  const entry = resolve(repositoryRoot, '.build/desktop/node/src/ash/platform/app-server/node/webAppServer.js');
  const { attachWebAppServer } = await import(pathToFileURL(entry).href);
  closeConnections = attachWebAppServer(server, webAppServerOptions());
}
server.on('upgrade', (request, socket) => {
  if (!closeConnections || request.url !== '/ash/app-server') socket.destroy();
});
server.listen(port, '127.0.0.1');
async function stop(): Promise<void> {
  const closing = closeConnections?.();
  server.close();
  server.closeAllConnections();
  await closing;
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
