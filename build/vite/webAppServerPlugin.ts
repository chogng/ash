import type { Plugin } from 'vite';
import { authenticatedWebUrl, startWeb } from '../lib/web.ts';

export function webAppServerVitePlugin(): Plugin {
	let close: (() => Promise<void>) | undefined;
	return {
		name: 'ash-web-app-server',
		apply: 'serve',
		async configureServer(server) {
			if (!server.httpServer) { throw new Error('Web App Server requires an HTTP server'); }
			server.config.server.host = '127.0.0.1';
			server.config.server.strictPort = true;
			const origin = `http://127.0.0.1:${server.config.server.port ?? 5173}`;
			const launch = await startWeb({ port: 0, origin });
			close = launch.close;
			server.httpServer.once('listening', () => console.info(`Open Ash: ${authenticatedWebUrl(launch.info, origin)}`));
			server.httpServer.once('close', () => void launch.close());
		},
		closeBundle() { return close?.(); },
	};
}
