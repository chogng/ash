import { isAbsolute, relative, resolve } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { Plugin } from 'vite';
import { browserExtensionRoots, browserExtensionWatchFiles, prepareBuiltinExtensions } from '../../builtin/extensions.ts';
import { watchRebuild } from '../../lib/watchRebuild.ts';
import { generateLocalization, isLocalizationInput, localizationWatchRoots } from '../../resources/localization.ts';

/** Publishes package snapshots before compilation and reloads after an extension source changes. */
export function browserExtensionsPlugin(): Plugin {
	let stopWatching: (() => Promise<void>) | undefined;
	let updateWatchFiles: (() => Promise<void>) | undefined;
	return {
		name: 'ash-browser-extensions',
		async config(_config, environment) {
			const locations: Record<string, string> = Object.create(null);
			if (environment.command === 'serve') {
				for (const entry of await readdir(browserExtensionRoots[0], { withFileTypes: true })) {
					if (!entry.isDirectory()) {
						continue;
					}
					const directory = resolve(browserExtensionRoots[0], entry.name);
					const source = await readFile(resolve(directory, 'package.json'), 'utf8').catch(error => {
						if (error.code === 'ENOENT') {
							return undefined;
						}
						throw error;
					});
					if (source === undefined) {
						continue;
					}
					const manifest = JSON.parse(source);
					if (!Array.isArray(manifest.contributes?.themes) || manifest.contributes.themes.length === 0) {
						continue;
					}
					const id = `${manifest.publisher}.${manifest.name}`;
					if (!/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/iu.test(id) || Object.hasOwn(locations, id)) {
						throw new TypeError(`Invalid development theme extension identity: ${id}`);
					}
					locations[id] = pathToFileURL(directory).href;
				}
			}
			// Editing uses the checkout; execution keeps its immutable package identity.
			return { define: { 'import.meta.env.ASH_BUILTIN_THEME_SOURCES': JSON.stringify(locations) } };
		},
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
				for (const file of files) { dependencies.add(resolve(file)); }
				server.watcher.add(files);
			};
			server.watcher.add([...browserExtensionRoots, ...localizationWatchRoots]);
			stopWatching = watchRebuild(server, path => dependencies.has(resolve(path)) || isLocalizationInput(path) || browserExtensionRoots.some(root => {
				const inside = relative(root, path);
				return !isAbsolute(inside) && inside !== '..' && !inside.startsWith('..\\') && !inside.startsWith('../')
					&& !inside.split(/[\\/]/).some(part => part.startsWith('.') || ['node_modules', 'test', 'target'].includes(part));
			}), async () => {
				const localized = await generateLocalization();
				const extensions = await prepareBuiltinExtensions();
				await updateWatchFiles?.();
				return localized || extensions;
			});
		},
	};
}
