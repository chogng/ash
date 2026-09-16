import { createServer } from 'node:http';
import { resolve } from 'node:path';
import sirv from 'sirv';
import { authenticatedWebUrl, startWeb } from '../build/lib/web.ts';

const repositoryRoot = resolve(import.meta.dirname, '..');
const root = resolve(process.argv[2] ?? resolve(repositoryRoot, '.build/desktop/renderer/ash'));
const port = Number(process.argv[3] ?? 5173);
if (!Number.isInteger(port) || port < 1 || port > 65535) { throw new Error('Invalid Web server port'); }

if (process.env.ASH_WEB_APP_SERVER === '1') {
	const launch = await startWeb({ port, assets: root });
	console.log(JSON.stringify(launch.info));
	console.error(`Open Ash: ${authenticatedWebUrl(launch.info)}`);
	process.once('SIGTERM', () => void launch.close());
	process.once('SIGINT', () => void launch.close());
	process.exitCode = await launch.exited;
} else {
	const serve = sirv(root, { etag: true });
	const server = createServer((request, response) => {
		if (request.url === '/') { response.writeHead(302, { Location: '/browser/workbench/workbench.html' }); response.end(); return; }
		serve(request, response);
	});
	server.on('upgrade', (_request, socket) => socket.destroy());
	server.listen(port, '127.0.0.1');
	const stop = (): void => { server.close(); server.closeAllConnections(); };
	process.once('SIGTERM', stop);
	process.once('SIGINT', stop);
}
