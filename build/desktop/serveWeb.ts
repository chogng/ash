import { createServer } from 'node:http';
import { resolve } from 'node:path';
import sirv from 'sirv';
import { attachWebAppServer } from './webAppServer.ts';

const root = resolve(process.argv[2] ?? '.build/desktop/renderer/ash');
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
const closeConnections = process.env.ASH_WEB_APP_SERVER === '1' ? attachWebAppServer(server) : undefined;
server.on('upgrade', (request, socket) => {
	if (!closeConnections || request.url !== '/ash/app-server') socket.destroy();
});
server.listen(port, '127.0.0.1');
function stop(): void {
	closeConnections?.();
	server.close();
	server.closeAllConnections();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
