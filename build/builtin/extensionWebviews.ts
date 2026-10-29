import { build } from 'vite';
import { isAbsolute, resolve } from 'node:path';

/** Compile package-owned view resources without creating a JavaScript extension runtime. */
export async function compileExtensionWebviews(
	packageRoot: string,
	declarations: unknown,
): Promise<{ resources: Record<string, string>; files: string[] }> {
	if (declarations === undefined) return { resources: {}, files: [] };
	if (!Array.isArray(declarations) || declarations.length > 16) throw new TypeError('Invalid extension webviews');
	const resources: Record<string, string> = Object.create(null);
	const files = new Set<string>();
	const path = (value: unknown): string => {
		if (
			typeof value !== 'string' ||
			isAbsolute(value) ||
			/[\\:\0]/u.test(value) ||
			value.split('/').some(part => !part || part === '.' || part === '..')
		)
			throw new TypeError('Invalid extension webview resource path');
		return value;
	};
	for (const declaration of declarations) {
		const entry = path(declaration?.entry),
			script = path(declaration?.script),
			style = path(declaration?.style);
		if (script === style || resources[script] !== undefined || resources[style] !== undefined)
			throw new Error('Duplicate extension webview resource');
		const output = await build({
			configFile: false,
			logLevel: 'error',
			plugins: [
				{
					name: 'ash-extension-view-inputs',
					transform(_code, id) {
						const path = id.split('?')[0];
						if (isAbsolute(path)) files.add(resolve(path));
					},
				},
			],
			build: {
				write: false,
				minify: true,
				assetsInlineLimit: Infinity,
				lib: { entry: resolve(packageRoot, entry), formats: ['iife'], name: 'extensionWebview' },
			},
		});
		const outputs = Array.isArray(output)
			? output.flatMap(value => value.output)
			: 'output' in output
				? output.output
				: [];
		resources[script] = outputs
			.filter(file => file.type === 'chunk')
			.map(file => file.code)
			.join('\n');
		resources[style] = outputs
			.flatMap(file => (file.type === 'asset' && file.fileName.endsWith('.css') ? [String(file.source)] : []))
			.join('\n');
	}
	return { resources, files: [...files].sort() };
}
