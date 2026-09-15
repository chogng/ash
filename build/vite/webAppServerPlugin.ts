import type { Plugin } from 'vite';
import { attachWebAppServer } from '../desktop/webAppServer.ts';

export function webAppServerVitePlugin(): Plugin {
	let closeConnections: (() => Promise<void>) | undefined;
	return {
		name: 'ash-web-app-server',
		apply: 'serve',
		configureServer(server) {
			if (!server.httpServer) throw new Error('Web App Server requires an HTTP server');
			closeConnections = attachWebAppServer(server.httpServer);
		},
		closeBundle() {
			return closeConnections?.();
		},
	};
}
