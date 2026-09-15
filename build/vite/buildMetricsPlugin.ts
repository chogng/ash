import type { Plugin } from 'vite';
import { relative } from 'node:path';

/** Records the complete static JavaScript dependency set for each entry. */
export function buildMetricsPlugin(): Plugin {
	let root = process.cwd();
	return {
		name: 'ash-build-metrics',
		enforce: 'post',
		configResolved(config) { root = config.root; },
		generateBundle: { order: 'post', handler(_options, bundle) {
			for (const output of Object.values(bundle)) {
				if (output.type === 'chunk' && Buffer.byteLength(output.code) > 500_000) {
					this.error(`JavaScript chunk exceeds 500 kB: ${output.fileName}. Review its module dependencies and split boundaries.`);
				}
			}
			const entries = Object.values(bundle).filter(output => output.type === 'chunk' && output.isEntry);
			const report = entries.map(entry => {
				const files = new Set<string>();
				function visit(name: string): void {
					if (files.has(name)) return;
					const output = bundle[name];
					if (output?.type !== 'chunk') return;
					files.add(name);
					for (const dependency of output.imports) visit(dependency);
				}
				visit(entry.fileName);
				const chunks = [...files].sort().map(file => {
					const output = bundle[file];
					if (output.type !== 'chunk') throw new Error(`Static JavaScript dependency is not a chunk: ${file}`);
					return { file, bytes: Buffer.byteLength(output.code), imports: output.imports, dynamicImports: output.dynamicImports, modules: Object.keys(output.modules).map(id => id.startsWith('\0') ? id.slice(1) : relative(root, id)).sort() };
				});
				return { entry: entry.fileName, staticJavaScriptBytes: chunks.reduce((total, chunk) => total + chunk.bytes, 0), chunks };
			});
			this.emitFile({ type: 'asset', fileName: 'build-metrics.json', source: JSON.stringify(report, null, 2) });
			const assets = Object.values(bundle).filter(output => output.type === 'asset').filter(output => output.fileName !== 'build-metrics.json').map(output => ({ file: output.fileName, bytes: typeof output.source === 'string' ? Buffer.byteLength(output.source) : output.source.byteLength })).sort((a, b) => a.file.localeCompare(b.file));
			this.emitFile({ type: 'asset', fileName: 'build-assets.json', source: JSON.stringify(assets, null, 2) });
		} },
	};
}
