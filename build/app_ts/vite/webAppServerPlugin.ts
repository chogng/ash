import type { Plugin } from 'vite';
import { authenticatedWebUrl, startWeb } from '../web.ts';
import { watchAppServer } from '../appServer.ts';

export function webAppServerVitePlugin(entryPath: string): Plugin {
	let close: (() => Promise<void>) | undefined;
	let closing: Promise<void> | undefined;
	return {
		name: 'ash-web-app-server',
		apply: 'serve',
		async configureServer(server) {
			if (!server.httpServer) { throw new Error('Web App Server requires an HTTP server'); }
			server.config.server.host = '127.0.0.1';
			server.config.server.strictPort = true;
			const origin = `http://127.0.0.1:${server.config.server.port ?? 5173}`;
			const launch = await startWeb({ port: 0, origin, environment: process.env });
			try {
				const stopWatching = await watchAppServer({ skipInitial: true, javascriptRuntime: 'packaged-node', onDidBuild: launch.reloadBackend });
				close = () => closing ??= (async () => { stopWatching(); await launch.close(); })();
			} catch (error) {
				await launch.close();
				throw error;
			}
			server.httpServer.once('listening', () => console.info(`Open Ash: ${authenticatedWebUrl(launch.info, origin, entryPath)}`));
			server.httpServer.once('close', () => void close?.());
			void launch.exited.then(async code => {
				if (closing) return;
				server.config.logger.error(`Web App Server exited with status ${code}`);
				process.exitCode = code || 1;
				await server.close();
			});
		},
		closeBundle() { return close?.(); },
	};
}
