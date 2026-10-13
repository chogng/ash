import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { gzipSync } from 'node:zlib';
import { fingerprintPaths, PreparedInputs, readJsonCache, writeJsonCache } from '../lib/preparedInputs.ts';

const root = resolve(import.meta.dirname, '../..');
const directory = resolve(root, 'extensions/theme-defaults');
export const browserExtensionRoots = [resolve(root, 'extensions'), ...String(process.env.ASH_WEB_EXTENSION_PATHS ?? '').split(delimiter).filter(Boolean).map(path => resolve(path))];

const prepared = new PreparedInputs(resolve(root, '.build/browser-extension-inputs.json'));
// Vite sets NODE_ENV during its first build; cache hits must use that same default.
const buildEnvironment = process.env.NODE_ENV ?? 'production';
const toolchainFiles = [
	'build/builtin/extensions.ts', 'build/lib/preparedInputs.ts', 'pnpm-lock.yaml', 'package.json', 'build/package.json',
	'tsconfig.json', 'tsconfig.base.json', 'extensions/tsconfig.json', 'extensions/tsconfig.base.json',
	'.env', '.env.local', '.env.production', '.env.production.local',
].map(path => resolve(root, path));
const environment = JSON.stringify([buildEnvironment, process.versions.node, Object.entries(process.env).filter(([key]) => key.startsWith('VITE_')).sort(([a], [b]) => a.localeCompare(b))]);

/** Vite also watches imported modules outside package roots (runtime bridges and shared sources). */
export async function browserExtensionWatchFiles(): Promise<string[]> {
	const dependencyFiles = new Set<string>(toolchainFiles);
	for (const entry of await readdir(resolve(root, '.build/browser-extensions')).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
		if (!entry.endsWith('.json')) continue;
		const cached = await readJsonCache(resolve(root, '.build/browser-extensions', entry));
		const bundle = cached?.bundle as { files?: unknown; } | undefined;
		if (Array.isArray(bundle?.files) && bundle.files.every(file => typeof file === 'string')) {
			for (const file of bundle.files) dependencyFiles.add(file);
		}
	}
	return [...dependencyFiles];
}

async function extensionOutputFingerprint(): Promise<string> {
	return fingerprintPaths([
		resolve(root, 'src/ash/platform/extensions/common/generated/browser.json'),
		resolve(root, '.build/browser-extensions'), ...await browserExtensionWatchFiles(),
	]);
}

async function extensionFingerprint(): Promise<string> {
	return await fingerprintPaths([
		...browserExtensionRoots, resolve(root, '.build/desktop/localization/extensions'),
		...toolchainFiles,
	], (path, directory) => !directory || !['node_modules', 'test', 'target', '.git'].includes(path.split(/[\\/]/).at(-1)!))
		+ JSON.stringify(browserExtensionRoots) + environment;
}

export function prepareBrowserExtensions(): Promise<boolean> {
	return prepared.prepare(extensionFingerprint, extensionOutputFingerprint, preparePackages);
}

async function preparePackages(): Promise<boolean> {
	const toolchain = await fingerprintPaths(toolchainFiles);
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
		if (index < builtInCount && manifest.engines?.ash && manifest.contributes?.localizations) {
			packageResources['localization/package.json'] = (await readPackageFile(resolve(root, '.build/desktop/localization/extensions', id, 'localization/package.json'))).toString('base64');
		}
		if (typeof manifest.browser === 'string') {
			// Each Worker imports one immutable module. Package dependencies stay inside that module.
			const entry = manifest.browser.replace(/^\.\//, '');
			const compiledSources = new Set<string>();
			const dependencies = new Map<string, string>();
			const cachePath = resolve(root, '.build/browser-extensions', digest(packageRoot).slice(7) + '.json');
			const input = digest(JSON.stringify([packageResources, toolchain, environment]));
			const cached = await readJsonCache(cachePath);
			const bundle = cached?.bundle as { module?: unknown; sources?: unknown; files?: unknown; } | undefined;
			let module: Buffer;
			if (cached?.input === input && bundle && typeof bundle.module === 'string'
				&& Array.isArray(bundle.sources) && bundle.sources.every(source => typeof source === 'string')
				&& Array.isArray(bundle.files) && bundle.files.every(file => typeof file === 'string')
				&& cached.digest === digest(JSON.stringify(bundle))
				&& cached.dependencies === await fingerprintPaths(bundle.files)) {
				module = Buffer.from(bundle.module, 'base64');
				for (const source of bundle.sources) { compiledSources.add(source); }
			} else {
				const sourcePlugin: import('vite').Plugin = {
					name: 'ash-extension-sources',
					enforce: 'pre',
					async load(id) {
						const path = id.split('?')[0];
						if (isAbsolute(path) && !dependencies.has(path)) { dependencies.set(path, await fingerprintPaths([path])); }
					},
					async transform(_code: string, id: string) {
						const path = id.split('?')[0];
						if (isAbsolute(path) && !dependencies.has(path)) { dependencies.set(path, await fingerprintPaths([path])); }
						const resource = relative(packageRoot, path).replaceAll('\\', '/');
						if (!resource.startsWith('../') && /\.[cm]?[jt]sx?$/.test(path)) { compiledSources.add(resource); }
					}
				};
				const result = await build({
					configFile: false, logLevel: 'error',
					plugins: [sourcePlugin, {
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
							const facade = JSON.stringify(resolve(root, 'resources/extension-host/vscode.js'));
							if (id === '\0ash-public-api') { return `import { bridge } from '\0ash-vscode-bridge'; export const { scm, backend, editors } = bridge.api.ash;`; }
							if (id === '\0ash-vscode') {
								const names = ['commands', 'workspace', 'window', 'languages', 'tasks', 'debug', 'env', 'l10n', 'Uri', 'Position', 'Range', 'Location', 'Hover', 'Disposable', 'EventEmitter', 'CancellationTokenSource', 'Diagnostic', 'DiagnosticSeverity', 'CompletionItem', 'CompletionList', 'CompletionItemKind', 'TextEdit', 'WorkspaceEdit', 'CodeActionKind', 'SymbolKind', 'FileType', 'Task', 'TaskGroup', 'TaskScope', 'ProcessExecution', 'ShellExecution', 'CustomExecution'];
								return `import { bridge } from '\0ash-vscode-bridge'; const api = bridge.api; ${names.map(name => `export const ${name} = api.${name};`).join(' ')} export default api;`;
							}
							if (id === '\0ash-vscode-bridge') {
								return `import { createApi } from ${facade}; export const bridge = createApi(globalThis.__ashConfiguration, globalThis.__ashInitialization);`;
							}
							if (id === '\0ash-browser-entry') {
								return `import { __runtime } from ${JSON.stringify(resolve(root, 'resources/extension-host/host.mjs'))}; import { bridge } from '\0ash-vscode-bridge'; import * as extension from ${JSON.stringify(resolve(packageRoot, entry))}; export async function activate() { const context = __runtime.beginActivation(globalThis.__ashConfiguration.extensionId); await bridge.activate(context, extension.activate, extension, ['command', 'languageProvider', 'customTextEditor']); return JSON.parse(__runtime.sealActivation()); } export const invoke = (id, payload, requestId, operation) => __runtime.invoke(id, JSON.stringify(payload), requestId, operation).then(JSON.parse); export const cancel = id => __runtime.cancel(id); export const deactivate = () => __runtime.deactivate(() => { bridge.deactivate(); return extension.deactivate?.(); });`;
							}
							if (!id.endsWith('?webview')) return;
							const webview = await build({
								configFile: false, logLevel: 'error',
								plugins: [sourcePlugin],
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
				module = Buffer.from(chunks[0].code);
				const bundle = { module: module.toString('base64'), sources: [...compiledSources].sort(), files: [...dependencies.keys()].sort() };
				if (!(await Promise.all([...dependencies].map(async ([path, fingerprint]) => await fingerprintPaths([path]) === fingerprint))).every(Boolean)) {
					throw new Error(`Browser extension '${id}' changed while bundling; retry preparation`);
				}
				await writeJsonCache(cachePath, { input, bundle, digest: digest(JSON.stringify(bundle)), dependencies: await fingerprintPaths(bundle.files) });
			}
			// Keep uncompiled samples and assets; bundled module inputs no longer need separate resources.
			for (const source of compiledSources) {
				const size = Buffer.from(packageResources[source] ?? '', 'base64').byteLength;
				delete packageResources[source];
				packageBytes -= size;
				snapshotBytes -= size;
			}
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
	return publish(resolve(root, 'src/ash/platform/extensions/common/generated/browser.json'), { catalog: { generation: 1, diagnostics: [], extensions }, resources: bundledResources });
}

const digest = (content: string): string => 'sha256:' + createHash('sha256').update(content).digest('hex');

async function publish(output: string, value: unknown): Promise<boolean> {
	await mkdir(dirname(output), { recursive: true });
	const content = JSON.stringify(value) + '\n';
	let previous: string | undefined;
	try { previous = await readFile(output, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
	if (previous === content) { return false; }
	// Preparation and Vite can publish concurrently; readers must see a complete catalog.
	const temporary = output + '.' + randomUUID();
	await writeFile(temporary, content);
	await rename(temporary, output);
	return true;
}

export async function prepareBuiltinExtensions(): Promise<void> {
	await prepareBrowserExtensions();
	const manifestJson = await readFile(resolve(directory, 'package.json'), 'utf8');
	const manifest = JSON.parse(manifestJson);
	const resources: Record<string, string> = {};
	for (const file of (await readdir(resolve(directory, 'themes'))).sort()) {
		if (file.endsWith('.json')) resources['themes/' + file] = await readFile(resolve(directory, 'themes', file), 'utf8');
	}
	const output = resolve(root, 'src/ash/platform/extensions/common/generated/theme-defaults.json');
	await publish(output, {
		descriptor: {
			id: `${manifest.publisher}.${manifest.name}`, name: manifest.name, publisher: manifest.publisher,
			version: manifest.version, displayName: manifest.name, sourceKind: 'builtIn',
			manifestJson, manifestSha256: digest(manifestJson), packageSha256: digest(JSON.stringify(resources)),
		},
		resources,
	});
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	await prepareBuiltinExtensions();
}
