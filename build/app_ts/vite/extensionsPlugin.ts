import { isAbsolute, relative } from 'node:path';
import type { Plugin } from 'vite';
import { browserExtensionRoots, prepareBrowserExtensions } from '../../resources/extensions.ts';

/** Publishes package snapshots before compilation and reloads after an extension source changes. */
export function browserExtensionsPlugin(): Plugin {
	let pending = Promise.resolve();
	let timer: ReturnType<typeof setTimeout> | undefined;
	return {
		name: 'ash-browser-extensions',
		async buildStart() { await prepareBrowserExtensions(); },
		configureServer(server) {
			server.watcher.add(browserExtensionRoots);
			const onChange = (event: string, path: string): void => {
				if (!['add', 'change', 'unlink'].includes(event) || !browserExtensionRoots.some(root => {
					const inside = relative(root, path);
					return !isAbsolute(inside) && inside !== '..' && !inside.startsWith('..\\') && !inside.startsWith('../');
				})) { return; }
				clearTimeout(timer);
				timer = setTimeout(() => {
					pending = pending.then(async () => { await prepareBrowserExtensions(); server.ws.send({ type: 'full-reload' }); }).catch(error => { server.config.logger.error(String(error)); });
				}, 50);
			};
			server.watcher.on('all', onChange);
			server.httpServer?.once('close', () => { clearTimeout(timer); server.watcher.off('all', onChange); });
		},
	};
}
