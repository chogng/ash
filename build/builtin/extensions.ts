import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { delimiter, dirname, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { gzipSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '../..');
const directory = resolve(root, 'extensions/theme-defaults');
export const browserExtensionRoots = [resolve(root, 'extensions'), ...String(process.env.ASH_WEB_EXTENSION_PATHS ?? '').split(delimiter).filter(Boolean).map(path => resolve(path))];

export async function prepareBrowserExtensions(): Promise<void> {
	const packages: string[] = [];
	for (const entry of (await readdir(browserExtensionRoots[0], { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
		const packageRoot = resolve(browserExtensionRoots[0], entry.name);
		const files = await readdir(packageRoot);
		// Rust capability processes are packaged separately from browser extension modules.
		if (!files.includes('package.json') && files.includes('Cargo.toml')) { continue; }
		packages.push(packageRoot);
	}
	const builtInCount = packages.length;
	packages.push(...browserExtensionRoots.slice(1));
	if (packages.length > 4096) { throw new RangeError('Too many browser extension packages'); }
	let snapshotBytes = 0;
	const extensions = [];
	const bundledResources: Record<string, Record<string, string>> = {};
	for (const [index, packageRoot] of packages.entries()) {
		if ((await stat(resolve(packageRoot, 'package.json'))).size > 4 * 1024 * 1024) { throw new RangeError('Browser extension manifest exceeds its byte limit'); }
		const manifestJson = await readFile(resolve(packageRoot, 'package.json'), 'utf8');
		const manifest = JSON.parse(manifestJson);
		const id = `${manifest.publisher}.${manifest.name}`;
		if (Object.hasOwn(bundledResources, id)) { throw new Error(`Duplicate browser extension: ${id}`); }
		const packageResources: Record<string, string> = {};
		let packageBytes = 0;
		let fileCount = 0;
		async function readPackageFile(path: string): Promise<Buffer> {
			const size = (await stat(path)).size;
			if (++fileCount > 4096 || size > 16 * 1024 * 1024 || packageBytes + size > 64 * 1024 * 1024 || snapshotBytes + size > 256 * 1024 * 1024) { throw new RangeError(`Browser extension '${id}' exceeds its resource budget`); }
			const bytes = await readFile(path);
			if (bytes.byteLength !== size) { throw new Error(`Browser extension '${id}' changed while packaging`); }
			packageBytes += size;
			snapshotBytes += size;
			return bytes;
		}
		async function collect(resourceDirectory: string): Promise<void> {
			for (const entry of (await readdir(resourceDirectory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
				if (entry.name.startsWith('.') || ['node_modules', 'test'].includes(entry.name)) { continue; }
				if (manifest.ashRuntime?.kind === 'rust' && entry.isFile() && entry.name.endsWith('.ts')) { continue; }
				if (manifest.ashRuntime?.kind === 'rust' && ['src', 'tests', 'Cargo.toml', 'Cargo.lock', 'BUILD.bazel'].includes(entry.name)) { continue; }
				const path = resolve(resourceDirectory, entry.name);
				if (entry.isDirectory()) { await collect(path); }
				else if (entry.isFile()) { packageResources[relative(packageRoot, path).replaceAll('\\', '/')] = (await readPackageFile(path)).toString('base64'); }
			}
		}
		await collect(packageRoot);
		if (typeof manifest.browser === 'string') {
			// Each Worker imports one immutable module. Package dependencies stay inside that module.
			const entry = manifest.browser.replace(/^\.\//, '');
			const result = await build({
				configFile: false, logLevel: 'error',
				plugins: [{
					name: 'ash-extension-webview',
					async resolveId(source, importer) {
						if (source === 'vscode') return '\0ash-vscode';
						if (source === 'ash') return '\0ash-public-api';
						if (source === '\0ash-vscode-bridge') return source;
						if (source === resolve(packageRoot, '__ash_browser_entry__.js')) return '\0ash-browser-entry';
						if (!source.endsWith('?webview')) return;
						const resolved = await this.resolve(source.slice(0, -8), importer);
						if (!resolved) throw new Error(`Cannot resolve extension webview: ${source}`);
						return resolved.id + '?webview';
					},
					async load(id) {
						const facade = JSON.stringify(resolve(root, 'crates/external-js-ext/src/vscode.js'));
						if (id === '\0ash-public-api') { return `import { bridge } from '\0ash-vscode-bridge'; export const { scm, backend, editors } = bridge.api.ash;`; }
						if (id === '\0ash-vscode') {
							const names = ['commands', 'workspace', 'window', 'languages', 'tasks', 'debug', 'env', 'l10n', 'Uri', 'Position', 'Range', 'Location', 'Hover', 'Disposable', 'EventEmitter', 'CancellationTokenSource', 'Diagnostic', 'DiagnosticSeverity', 'CompletionItem', 'CompletionList', 'CompletionItemKind', 'TextEdit', 'WorkspaceEdit', 'CodeActionKind', 'SymbolKind', 'FileType', 'Task', 'TaskGroup', 'TaskScope', 'ProcessExecution', 'ShellExecution', 'CustomExecution'];
							return `import { bridge } from '\0ash-vscode-bridge'; const api = bridge.api; ${names.map(name => `export const ${name} = api.${name};`).join(' ')} export default api;`;
						}
						if (id === '\0ash-vscode-bridge') {
							const messages = (path: string): unknown => packageResources[path] ? JSON.parse(Buffer.from(packageResources[path], 'base64').toString('utf8')) : {};
							const localization = JSON.stringify({ en: messages('package.nls.json'), 'zh-CN': messages('package.nls.zh-CN.json') });
							return `import { createApi } from ${facade}; const original = globalThis.__ashConfiguration; const bundles = ${localization}; const messages = { ...bundles.en, ...bundles[globalThis.__ashInitialization.language] }; function localize(value) { if (typeof value === 'string') return value.replace(/^%(.+)%$/, (text, key) => messages[key] ?? text); if (Array.isArray(value)) return value.map(localize); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, localize(entry)])); return value; } const manifest = localize(original.manifest); export const bridge = createApi({ ...original, manifest, commands: manifest.contributes?.commands ?? [] }, globalThis.__ashInitialization);`;
						}
						if (id === '\0ash-browser-entry') {
							return `import { __runtime } from ${JSON.stringify(resolve(root, 'crates/external-js-ext/src/host.mjs'))}; import { bridge } from '\0ash-vscode-bridge'; import * as extension from ${JSON.stringify(resolve(packageRoot, entry))}; export async function activate() { const context = __runtime.beginActivation(globalThis.__ashConfiguration.extensionId); await bridge.activate(context, extension.activate, extension, ['command', 'languageProvider', 'customTextEditor']); return JSON.parse(__runtime.sealActivation()); } export const invoke = (id, payload, requestId, operation) => __runtime.invoke(id, JSON.stringify(payload), requestId, operation).then(JSON.parse); export const cancel = id => __runtime.cancel(id); export const deactivate = () => __runtime.deactivate(() => { bridge.deactivate(); return extension.deactivate?.(); });`;
						}
						if (!id.endsWith('?webview')) return;
						const webview = await build({
							configFile: false, logLevel: 'error',
							build: {
								write: false, minify: true, assetsInlineLimit: Infinity,
								lib: { entry: id.slice(0, -8), formats: ['iife'], name: 'AshExtensionWebview' },
							},
						});
						const outputs = Array.isArray(webview) ? webview.flatMap(output => output.output) : 'output' in webview ? webview.output : [];
						const script = outputs.filter(output => output.type === 'chunk').map(output => output.code).join('\n');
						const style = outputs.flatMap(output => output.type === 'asset' && output.fileName.endsWith('.css') ? [String(output.source)] : []).join('\n');
						// Library assets stay in the Worker package; editor messages retain their existing JSON limit.
						const payload = gzipSync(JSON.stringify({ script, style })).toString('base64');
						return `export default ${JSON.stringify(payload)}`;
					},
				}],
				// Browser language libraries operate on URI paths without a Node runtime.
				resolve: { alias: { 'node:path': createRequire(import.meta.url).resolve('path-browserify'), 'path': createRequire(import.meta.url).resolve('path-browserify') } },
				build: { write: false, minify: false, target: 'es2015', lib: { entry: resolve(packageRoot, '__ash_browser_entry__.js'), formats: ['es'], fileName: 'extension' } }
			});
			const outputs = Array.isArray(result) ? result.flatMap(output => output.output) : 'output' in result ? result.output : [];
			const chunks = outputs.filter(output => output.type === 'chunk');
			if (chunks.length !== 1) throw new Error(`Browser extension '${id}' must produce one ES module`);
			const module = Buffer.from(chunks[0].code);
			const previousSize = Buffer.from(packageResources[entry] ?? '', 'base64').byteLength;
			const difference = module.byteLength - previousSize;
			if (module.byteLength > 16 * 1024 * 1024 || packageBytes + difference > 64 * 1024 * 1024 || snapshotBytes + difference > 256 * 1024 * 1024) { throw new RangeError(`Browser extension '${id}' exceeds its resource budget`); }
			packageBytes += difference;
			snapshotBytes += difference;
			packageResources[entry] = module.toString('base64');
		}
		bundledResources[id] = packageResources;
		extensions.push({ id, name: manifest.name, publisher: manifest.publisher, version: manifest.version, displayName: manifest.name, sourceKind: index < builtInCount ? 'builtIn' : 'user', manifestJson, manifestSha256: digest(manifestJson), packageSha256: digest(JSON.stringify(packageResources)) });
	}
	await publish(resolve(root, 'src/ash/platform/extensions/common/generated/browser.json'), { catalog: { generation: 1, diagnostics: [], extensions }, resources: bundledResources });
}

const digest = (content: string): string => 'sha256:' + createHash('sha256').update(content).digest('hex');

async function publish(output: string, value: unknown): Promise<void> {
	await mkdir(dirname(output), { recursive: true });
	const content = JSON.stringify(value) + '\n';
	let previous: string | undefined;
	try { previous = await readFile(output, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
	if (previous === content) { return; }
	// Preparation and Vite can publish concurrently; readers must see a complete catalog.
	const temporary = output + '.' + randomUUID();
	await writeFile(temporary, content);
	await rename(temporary, output);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	await prepareBrowserExtensions();
	const manifestJson = await readFile(resolve(directory, 'package.json'), 'utf8');
	const manifest = JSON.parse(manifestJson);
	const resources: Record<string, string> = {};
	for (const file of (await readdir(resolve(directory, 'themes'))).sort()) {
		if (file.endsWith('.json')) resources['themes/' + file] = await readFile(resolve(directory, 'themes', file), 'utf8');
	}
	const output = resolve(root, 'src/ash/platform/extensions/common/generated/theme-defaults.json');
	await mkdir(dirname(output), { recursive: true });
	// Build and test entry points can prepare resources concurrently; publish a complete snapshot.
	const temporary = output + '.' + randomUUID();
	await writeFile(temporary, JSON.stringify({
		descriptor: {
			id: `${manifest.publisher}.${manifest.name}`, name: manifest.name, publisher: manifest.publisher,
			version: manifest.version, displayName: manifest.name, sourceKind: 'builtIn',
			manifestJson, manifestSha256: digest(manifestJson), packageSha256: digest(JSON.stringify(resources)),
		},
		resources,
	}) + '\n');
	await rename(temporary, output);
}
