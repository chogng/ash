import { isAbsolute, relative, resolve } from 'node:path';
import type { Plugin } from 'vite';
import {
	browserExtensionRoots,
	browserExtensionWatchFiles,
	prepareBuiltinExtensions,
} from '../../builtin/extensions.ts';
import { watchRebuild } from '../../lib/watchRebuild.ts';
import { generateLocalization, isLocalizationInput, localizationWatchRoots } from '../../resources/localization.ts';

/** Publishes package snapshots before compilation and reloads after an extension source changes. */
export function browserExtensionsPlugin(): Plugin {
	let stopWatching: (() => Promise<void>) | undefined;
	let updateWatchFiles: (() => Promise<void>) | undefined;
	return {
		name: 'ash-browser-extensions',
		async buildStart() {
			await generateLocalization();
			await prepareBuiltinExtensions();
			await updateWatchFiles?.();
		},
		async closeBundle() {
			await stopWatching?.();
		},
		configureServer(server) {
			const dependencies = new Set<string>();
			updateWatchFiles = async () => {
				const files = await browserExtensionWatchFiles();
				dependencies.clear();
				for (const file of files) {
					dependencies.add(resolve(file));
				}
				server.watcher.add(files);
			};
			server.watcher.add([...browserExtensionRoots, ...localizationWatchRoots]);
			stopWatching = watchRebuild(
				server,
				path =>
					dependencies.has(resolve(path)) ||
					isLocalizationInput(path) ||
					browserExtensionRoots.some(root => {
						const inside = relative(root, path);
						return (
							!isAbsolute(inside) &&
							inside !== '..' &&
							!inside.startsWith('..\\') &&
							!inside.startsWith('../') &&
							!inside
								.split(/[\\/]/)
								.some(part => part.startsWith('.') || ['node_modules', 'test', 'target'].includes(part))
						);
					}),
				async () => {
					const localized = await generateLocalization();
					const extensions = await prepareBuiltinExtensions();
					await updateWatchFiles?.();
					return localized || extensions;
				},
			);
		},
	};
}
