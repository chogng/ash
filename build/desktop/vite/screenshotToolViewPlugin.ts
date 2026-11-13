import { resolve, isAbsolute } from 'node:path';
import { build, type Plugin } from 'vite';

/** A single isolated presentation is shared by Browser and native capture windows. */
export function screenshotToolViewPlugin(root: string): Plugin {
	const moduleId = resolve(root, 'src/ash/workbench/contrib/screenshotTool/browser/screenshotToolView.virtual.ts');
	const entry = resolve(root, 'src/ash/workbench/contrib/screenshotTool/browser/screenshotToolView.ts');
	return {
		name: 'ash-screenshot-tool-view',
		resolveId(id) { if (id === 'virtual:ash-screenshot-tool-view') return moduleId; },
		async load(id) {
			if (id !== moduleId) return;
			const inputs = new Set<string>();
			const result = await build({
				configFile: false, logLevel: 'error',
				plugins: [{ name: 'ash-screenshot-tool-inputs', transform(_code, file) { const path = file.split('?')[0]; if (isAbsolute(path)) inputs.add(path); } }],
				build: { write: false, minify: true, assetsInlineLimit: Infinity, lib: { entry, formats: ['iife'], name: 'ashImageEditor' } },
			});
			const outputs = Array.isArray(result) ? result.flatMap(value => value.output) : 'output' in result ? result.output : [];
			for (const file of inputs) this.addWatchFile(file);
			const script = outputs.filter(file => file.type === 'chunk').map(file => file.code).join('\n');
			const style = outputs.flatMap(file => file.type === 'asset' && file.fileName.endsWith('.css') ? [String(file.source)] : []).join('\n');
			return `export default ${JSON.stringify({ script, style })};`;
		},
	};
}
