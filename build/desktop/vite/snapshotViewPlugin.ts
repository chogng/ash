import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { compileExtensionWebviews } from '../../builtin/extensionWebviews.ts';

export function snapshotViewPlugin(root: string): Plugin {
	const moduleId = '\0ash:snapshot-view';
	const packageRoot = resolve(root, 'extensions/snapshot');
	return {
		name: 'ash-snapshot-view',
		resolveId(id) { if (id === 'virtual:ash-snapshot-view') return moduleId; },
		async load(id) {
			if (id !== moduleId) return;
			const declarations = [{ entry: 'browser/editor.ts', script: 'editor.js', style: 'editor.css' }];
			const localization = ['package.nls.json', 'package.nls.zh-CN.json', 'l10n/bundle.l10n.zh-CN.json'];
			const [{ resources, files }, [en, zh, messages]] = await Promise.all([
				compileExtensionWebviews(packageRoot, declarations),
				Promise.all(localization.map(path => readFile(resolve(packageRoot, path), 'utf8').then(JSON.parse))),
			]);
			for (const file of [...files, ...localization.map(path => resolve(packageRoot, path))]) this.addWatchFile(file);
			return `export default ${JSON.stringify({ script: resources['editor.js'], style: resources['editor.css'], en, zh, messages })};`;
		},
	};
}
