import ts from 'typescript';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile, lstat, realpath } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { gzipSync } from 'node:zlib';
import { fingerprintPaths, PreparedInputs, readJsonCache, writeJsonCache } from '../lib/preparedInputs.ts';
import { readPreinstalledLanguagePackIds } from '../resources/languagePacks.ts';
import { compileExtensionWebviews } from './extensionWebviews.ts';

const root = resolve(import.meta.dirname, '../..');
export const browserExtensionRoots = [resolve(root, 'extensions'), ...String(process.env.ASH_WEB_EXTENSION_PATHS ?? '').split(delimiter).filter(Boolean).map(path => resolve(path))];

const prepared = new PreparedInputs(resolve(root, '.build/browser-extension-inputs.json'));
// Vite sets NODE_ENV during its first build; cache hits must use that same default.
const buildEnvironment = process.env.NODE_ENV ?? 'production';
const toolchainFiles = [
	'build/builtin/extensions.ts', 'build/builtin/extensionWebviews.ts', 'build/lib/preparedInputs.ts', 'pnpm-lock.yaml', 'package.json', 'build/package.json',
	'build/resources/languagePacks.ts', 'localization/preinstalled.json', 'sdk/typescript/index.js',
	'tsconfig.json', 'tsconfig.base.json', 'extensions/tsconfig.json', 'extensions/tsconfig.base.json',
	'.env', '.env.local', '.env.production', '.env.production.local',
].map(path => resolve(root, path));
const environment = JSON.stringify([buildEnvironment, process.versions.node, Object.entries(process.env).filter(([key]) => key.startsWith('VITE_')).sort(([a], [b]) => a.localeCompare(b))]);

function preparedReferences(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && /^[a-f0-9]{64}(?:-[a-f0-9]{32})?$/u.test(entry)) : [];
}

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
	const publication = await readJsonCache(resolve(root, '.build/builtin/current.json'));
	const packages = [...preparedReferences(publication?.builtIn), ...preparedReferences(publication?.user)];
	return fingerprintPaths([
		resolve(root, '.build/builtin/fixture.json'),
		resolve(root, '.build/builtin/current.json'),
		...packages.filter(value => /^[a-f0-9]{64}(?:-[a-f0-9]{32})?$/u.test(value)).map(value => resolve(root, '.build/builtin/packages', value)),
		resolve(root, '.build/browser-extensions'), ...await browserExtensionWatchFiles(),
	]);
}

async function extensionFingerprint(): Promise<string> {
	return await fingerprintPaths([
		...browserExtensionRoots, resolve(root, '.build/desktop/localization/extensions'),
		...toolchainFiles,
		...await browserExtensionWatchFiles(),
	], (path, directory) => !directory || !['node_modules', 'test', 'target', '.git'].includes(path.split(/[\\/]/).at(-1)!))
		+ JSON.stringify(browserExtensionRoots) + environment;
}

export function prepareBuiltinExtensions(): Promise<boolean> {
	return prepared.prepare(extensionFingerprint, extensionOutputFingerprint, preparePackages);
}

async function preparePackages(): Promise<boolean> {
	const preinstalledLanguagePacks = await readPreinstalledLanguagePackIds();
	const toolchain = await fingerprintPaths(toolchainFiles);
	const packages: string[] = [];
	for (const entry of (await readdir(browserExtensionRoots[0], { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
		const packageRoot = resolve(browserExtensionRoots[0], entry.name);
		const files = await readdir(packageRoot);
		// Product capability processes have independent packages and no browser manifest.
		if (!files.includes('package.json') && (files.includes('Cargo.toml') || files.includes('runtime.json'))) { continue; }
		// Installed editor clients publish their own package; they are absent from the product catalog.
		if (files.includes('package.json')) {
			const manifestPath = resolve(packageRoot, 'package.json');
			if ((await stat(manifestPath)).size > 4 * 1024 * 1024) throw new RangeError('Browser extension manifest exceeds its byte limit');
			const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
			if (manifest.ashDistribution !== undefined && manifest.ashDistribution !== 'marketplace') { throw new TypeError('Invalid extension distribution'); }
			if (manifest.ashRuntime?.client || manifest.ashDistribution === 'marketplace') continue;
		}
		packages.push(packageRoot);
	}
	const builtInCount = packages.length;
	packages.push(...browserExtensionRoots.slice(1));
	if (packages.length > 4096) { throw new RangeError('Too many browser extension packages'); }
	let snapshotBytes = 0;
	const extensions = [];
	const bundledResources: Record<string, Record<string, string>> = {};
	const packageNames: Record<string, string> = Object.create(null);
	for (const [index, packageRoot] of packages.entries()) {
		if ((await stat(resolve(packageRoot, 'package.json'))).size > 4 * 1024 * 1024) { throw new RangeError('Browser extension manifest exceeds its byte limit'); }
		const manifestJson = await readFile(resolve(packageRoot, 'package.json'), 'utf8');
		const manifest = JSON.parse(manifestJson);
		const id = `${manifest.publisher}.${manifest.name}`;
		if (index < builtInCount && manifest.engines?.ash && manifest.contributes?.localizations
			&& !preinstalledLanguagePacks.has(`${manifest.publisher}/${manifest.name}`)) { continue; }
		packageNames[id] = basename(packageRoot);
		if (Object.hasOwn(bundledResources, id)) { throw new Error(`Duplicate browser extension: ${id}`); }
		const packageResources: Record<string, string> = Object.create(null);
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
				if (manifest.ashRuntime?.kind === 'rust' && ['src', 'tests', 'browser', 'common', 'Cargo.toml', 'Cargo.lock', 'build.rs', 'BUILD.bazel'].includes(entry.name)) { continue; }
				const path = resolve(resourceDirectory, entry.name);
				if (entry.isDirectory()) {
					// Rust source projects are build inputs; generated sibling WASM remains a resource.
					if ((await readdir(path)).includes('Cargo.toml')) { continue; }
					await collect(path);
				}
				else if (entry.isFile()) { packageResources[relative(packageRoot, path).replaceAll('\\', '/')] = (await readPackageFile(path)).toString('base64'); }
			}
		}
		await collect(packageRoot);
		if (manifest.ashRuntime?.kind === 'rust') {
			const views = await compileExtensionWebviews(packageRoot, manifest.ashRuntime.webviews);
			if (views.files.length) await writeJsonCache(resolve(root, '.build/browser-extensions', digest(packageRoot).slice(7) + '-views.json'), { bundle: { files: views.files } });
			for (const [path, content] of Object.entries(views.resources)) {
				const bytes = Buffer.from(content);
				const difference = bytes.length - Buffer.from(packageResources[path] ?? '', 'base64').length;
				if (bytes.length > 16 * 1024 * 1024 || packageBytes + difference > 64 * 1024 * 1024 || snapshotBytes + difference > 256 * 1024 * 1024) throw new RangeError('Extension webview exceeds its resource budget');
				packageBytes += difference;
				snapshotBytes += difference;
				packageResources[path] = bytes.toString('base64');
			}
		}
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
				const physicalPackageRoot = await realpath(packageRoot);
				const withinPackage = (path: string, base = packageRoot): boolean => {
					const location = relative(base, resolve(path)).replaceAll('\\', '/');
					return location !== '..' && !location.startsWith('../') && !isAbsolute(location);
				};
				const assertPhysicalSource = async (path: string): Promise<void> => {
					if (!withinPackage(await realpath(path.split('?')[0]), physicalPackageRoot)) throw new Error(`Extension import escapes its package through a symbolic link: ${path}`);
				};
				const entryPath = resolve(packageRoot, entry);
				if (!withinPackage(entryPath)) throw new Error(`Extension entry escapes its package: ${entry}`);
				await assertPhysicalSource(entryPath);
				const assertDependency = (source: string, importer: string): void => {
					if (source === '@ash/sdk') return;
					if (source.startsWith('.') || isAbsolute(source)) {
						if (!withinPackage(resolve(dirname(importer.split('?')[0]), source.split('?')[0]))) throw new Error(`Extension import escapes its package: ${source}`);
					} else if (!Object.keys(manifest.dependencies ?? {}).some(name => source === name || source.startsWith(name + '/'))) {
						throw new Error(`Extension import requires a declared dependency or @ash/sdk: ${source}`);
					}
				};
				const sourcePlugin: import('vite').Plugin = {
					name: 'ash-extension-sources',
					enforce: 'pre',
					async resolveId(source, importer) {
						if (!importer || !withinPackage(importer.split('?')[0])) return;
						assertDependency(source, importer);
						if (source.startsWith('.') || isAbsolute(source)) {
							const resolved = await this.resolve(source, importer, { skipSelf: true });
							if (resolved && !resolved.external && isAbsolute(resolved.id)) await assertPhysicalSource(resolved.id);
							return resolved;
						}
					},
					async load(id) {
						const path = id.split('?')[0];
						if (isAbsolute(path) && !dependencies.has(path)) { dependencies.set(path, await fingerprintPaths([path])); }
					},
					async transform(_code: string, id: string) {
						const path = id.split('?')[0];
						if (isAbsolute(path) && !dependencies.has(path)) { dependencies.set(path, await fingerprintPaths([path])); }
						const resource = relative(packageRoot, path).replaceAll('\\', '/');
						if (withinPackage(path) && /\.[cm]?[jt]sx?$/.test(path)) {
							// Type-only imports are erased before Vite resolution, but remain part of the SDK boundary.
							const source = ts.createSourceFile(path, _code, ts.ScriptTarget.Latest, true);
							const imports = new Set<string>();
							const visit = (node: ts.Node): void => {
								if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.add(node.moduleSpecifier.text);
								if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) imports.add(node.argument.literal.text);
								ts.forEachChild(node, visit);
							};
							visit(source);
							for (const dependency of imports) {
								assertDependency(dependency, path);
								// Resolve erased type imports too; otherwise a package-local symlink
								// could hide a dependency on the host's private declarations.
								if (dependency.startsWith('.') || isAbsolute(dependency)) {
									const resolved = await this.resolve(dependency, path, { skipSelf: true });
									if (resolved && !resolved.external && isAbsolute(resolved.id)) await assertPhysicalSource(resolved.id);
								}
							}
							compiledSources.add(resource);
						}
					}
				};
				const result = await build({
					configFile: false, logLevel: 'error',
					plugins: [sourcePlugin, {
						name: 'ash-extension-webview',
						async resolveId(source, importer) {
							if (source === '@ash/sdk') return '\0ash-public-api';
							if (source === '\0ash-api-bridge') return source;
							if (source === resolve(packageRoot, '__ash_browser_entry__.js')) return '\0ash-browser-entry';
							if (!source.endsWith('?webview')) return;
							const resolved = await this.resolve(source.slice(0, -8), importer);
							if (!resolved) throw new Error(`Cannot resolve extension webview: ${source}`);
							return resolved.id + '?webview';
						},
						async load(id) {
							const facade = JSON.stringify(resolve(root, 'resources/extension-host/ash.js'));
							if (id === '\0ash-public-api') {
								// The published entry owns the export inventory; reading its inert module
								// here cannot grant product authority or invoke the host-only methods.
								const names = Object.keys(await import(pathToFileURL(resolve(root, 'sdk/typescript/index.js')).href));
								return `import { bridge } from '\0ash-api-bridge'; const api = bridge.api; ${names.map(name => `export const ${name} = api.${name};`).join(' ')}`;
							}
							if (id === '\0ash-api-bridge') {
								return `import { createApi } from ${facade}; export const bridge = createApi(globalThis.__ashConfiguration, globalThis.__ashInitialization);`;
							}
							if (id === '\0ash-browser-entry') {
								return `import { __runtime } from ${JSON.stringify(resolve(root, 'resources/extension-host/host.mjs'))}; import { bridge } from '\0ash-api-bridge'; import * as extension from ${JSON.stringify(resolve(packageRoot, entry))}; export async function activate() { __runtime.onRegistrationsChanged(snapshot => globalThis.__ashRegistrationsChanged(JSON.parse(snapshot)), true); const context = __runtime.beginActivation(globalThis.__ashConfiguration.extensionId); await bridge.activate(context, extension.activate, extension, ['command', 'languageProvider', 'customTextEditor', 'imageEditor']); return JSON.parse(__runtime.sealActivation()); } export const invoke = (id, payload, requestId, operation) => __runtime.invoke(id, JSON.stringify(payload), requestId, operation).then(JSON.parse); export const cancel = id => __runtime.cancel(id); export const deactivate = () => __runtime.deactivate(() => { bridge.deactivate(); return extension.deactivate?.(); });`;
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
	// This JSON is a test fixture; product hosts discover and read the prepared directories in Rust.
	const fixtureChanged = await publish(resolve(root, '.build/builtin/fixture.json'), { catalog: { generation: 1, diagnostics: [], extensions }, resources: bundledResources });
	const packagesChanged = await publishPackages(extensions, bundledResources, packageNames);
	return fixtureChanged || packagesChanged;
}

async function publishPackages(extensions: { id: string; sourceKind: string; }[], resources: Record<string, Record<string, string>>, packageNames: Record<string, string>): Promise<boolean> {
	const directory = resolve(root, '.build/builtin');
	const previous = await readJsonCache(resolve(directory, 'current.json'));
	const previousPackages = [...preparedReferences(previous?.builtIn), ...preparedReferences(previous?.user)];
	const publication = { schemaVersion: 1, builtIn: [] as string[], user: [] as string[], packageNames: Object.create(null) as Record<string, string> };
	for (const extension of extensions) {
		const files = resources[extension.id];
		const content = digest(JSON.stringify(files)).slice(7);
		let snapshot = previousPackages.find(value => value === content || value.startsWith(content + '-'));
		if (!snapshot || !await packageMatches(resolve(directory, 'packages', snapshot), files)) {
			snapshot = content + '-' + randomUUID().replaceAll('-', '');
			const destination = resolve(directory, 'packages', snapshot);
			await mkdir(destination, { recursive: true });
			for (const [path, encoded] of Object.entries(files)) {
				if (isAbsolute(path) || /[\\:\0]/u.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Invalid prepared extension resource: ${path}`);
				const output = resolve(destination, path);
				await mkdir(dirname(output), { recursive: true });
				await writeFile(output, Buffer.from(encoded, 'base64'));
			}
		}
		publication[extension.sourceKind === 'builtIn' ? 'builtIn' : 'user'].push(snapshot);
		publication.packageNames[snapshot] = packageNames[extension.id];
	}
	// Each referenced directory is complete before the atomic publication. Old directories stay
	// immutable so a running host can retain its current generation until it observes this update.
	return publish(resolve(directory, 'current.json'), publication);
}

async function packageMatches(directory: string, files: Record<string, string>): Promise<boolean> {
	try {
		const paths: string[] = [];
		let entries = 0;
		async function visit(current: string): Promise<void> {
			if (++entries > 8192) throw new Error('Prepared package exceeds its entry budget');
			const metadata = await lstat(current);
			if (metadata.isDirectory()) {
				for (const entry of await readdir(current)) await visit(resolve(current, entry));
			} else if (metadata.isFile() && metadata.nlink === 1 && metadata.size <= 16 * 1024 * 1024) {
				paths.push(relative(directory, current).replaceAll('\\', '/'));
			} else { throw new Error('Prepared package contains an unsafe entry'); }
		}
		await visit(directory);
		if (paths.length !== Object.keys(files).length) return false;
		for (const path of paths) {
			if (!Object.hasOwn(files, path) || (await readFile(resolve(directory, path))).toString('base64') !== files[path]) return false;
		}
		return true;
	} catch { return false; }
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

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	await prepareBuiltinExtensions();
}
