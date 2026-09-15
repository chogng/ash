import type { Plugin } from 'vite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { webAppServerOptions } from '../lib/appServer.ts';
import { compile } from '../lib/compilation.ts';

export function webAppServerVitePlugin(): Plugin {
	let closeConnections: (() => Promise<void>) | undefined;
	return {
		name: 'ash-web-app-server',
		apply: 'serve',
		async configureServer(server) {
			if (!server.httpServer) throw new Error('Web App Server requires an HTTP server');
			await compile(['node']);
			const entry = resolve(import.meta.dirname, '../../.build/desktop/node/src/ash/platform/app-server/node/webAppServer.js');
			const { attachWebAppServer } = await import(pathToFileURL(entry).href);
			closeConnections = attachWebAppServer(server.httpServer, webAppServerOptions());
		},
		closeBundle() {
			return closeConnections?.();
		},
	};
}
