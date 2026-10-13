import { isAbsolute, relative } from 'node:path';
import type { Plugin } from 'vite';
import { browserExtensionRoots, prepareBrowserExtensions } from '../../builtin/extensions.ts';
import { watchRebuild } from '../../lib/watchRebuild.ts';

/** Publishes package snapshots before compilation and reloads after an extension source changes. */
export function browserExtensionsPlugin(): Plugin {
	let stopWatching: (() => void) | undefined;
	return {
		name: 'ash-browser-extensions',
		async buildStart() { await prepareBrowserExtensions(); },
		closeBundle() { stopWatching?.(); },
		configureServer(server) {
			server.watcher.add(browserExtensionRoots);
			stopWatching = watchRebuild(server, path => browserExtensionRoots.some(root => {
				const inside = relative(root, path);
				return !isAbsolute(inside) && inside !== '..' && !inside.startsWith('..\\') && !inside.startsWith('../');
			}), async () => { await prepareBrowserExtensions(); return true; });
		},
	};
}
