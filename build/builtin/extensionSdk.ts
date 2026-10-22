import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { build } from 'vite';
import { readEditorClientApi } from './editorClientApi.ts';

const repository = resolve(import.meta.dirname, '../..');
interface Dependency { name: string; rename: string | null; req: string; path?: string; kind: string | null; features: string[]; uses_default_features: boolean; optional: boolean; }
interface Package { name: string; version: string; edition: string; manifest_path: string; dependencies: Dependency[]; features: Record<string, string[]>; }

async function fresh(path: string): Promise<void> {
	try { await lstat(path); throw new Error(`Refusing to replace existing SDK or project: ${path}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

function cargoManifest(pkg: Package, paths: Map<string, string>, library?: string): string {
	let text = `[package]\nname = ${JSON.stringify(pkg.name)}\nversion = ${JSON.stringify(pkg.version)}\nedition = ${JSON.stringify(pkg.edition)}\nlicense-file = "LICENSE"\npublish = false\n`;
	if (library) text += `\n[lib]\nname = ${JSON.stringify(library)}\n`;
	for (const [kind, section] of [[null, 'dependencies'], ['build', 'build-dependencies']] as const) {
		const dependencies = pkg.dependencies.filter(dependency => dependency.kind === kind);
		if (!dependencies.length) continue;
		text += `\n[${section}]\n`;
		for (const dependency of dependencies) {
			const fields = [`package = ${JSON.stringify(dependency.name)}`];
			if (dependency.path) {
				const path = paths.get(dependency.name);
				if (!path) throw new Error(`Unexported SDK dependency: ${dependency.name}`);
				fields.push(`path = ${JSON.stringify(path)}`);
			} else fields.push(`version = ${JSON.stringify(dependency.req)}`);
			if (dependency.features.length) fields.push(`features = ${JSON.stringify(dependency.features)}`);
			if (!dependency.uses_default_features) fields.push('default-features = false');
			if (dependency.optional) fields.push('optional = true');
			text += `${JSON.stringify(dependency.rename ?? dependency.name)} = { ${fields.join(', ')} }\n`;
		}
	}
	if (Object.keys(pkg.features).length) text += '\n[features]\n' + Object.entries(pkg.features).map(([name, values]) => `${JSON.stringify(name)} = ${JSON.stringify(values)}\n`).join('');
	return text;
}

/** Export an SDK plus an independently buildable Academy project. Both destinations must be new. */
export async function exportExtensionSdk(sdk: string, project: string, devHost: string): Promise<void> {
	sdk = resolve(sdk); project = resolve(project);
	if (sdk === project || sdk.startsWith(project + '/') || project.startsWith(sdk + '/')) throw new Error('SDK and project must be separate directories');
	await fresh(sdk); await fresh(project);
	if (!(await stat(devHost)).isFile()) throw new Error('Build the native editor_dev example first');
	const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--no-deps', '--format-version=1', '--locked'], { cwd: repository, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })) as { packages: Package[]; };
	const api = await readEditorClientApi(repository);
	const sdkStage = `${sdk}.partial-${crypto.randomUUID()}`;
	const projectStage = `${project}.partial-${crypto.randomUUID()}`;
	await mkdir(sdkStage, { recursive: true }); await mkdir(projectStage, { recursive: true });
	try {
		const selected = [['ash-external-ext-sdk', 'rust', 'external_ext_sdk'], ['ash-external-ext-protocol', 'protocol', 'external_ext_protocol'], ['ash-editor-client-build', 'editor-client-build', undefined]] as const;
		for (const [name, folder, library] of selected) {
			const pkg = metadata.packages.find(pkg => pkg.name === name)!;
			const root = resolve(sdkStage, folder);
			await cp(resolve(dirname(pkg.manifest_path), 'src'), resolve(root, 'src'), { recursive: true });
			const manifest = cargoManifest(pkg, new Map([['ash-external-ext-protocol', '../protocol']]), library);
			await writeFile(resolve(root, 'Cargo.toml'), manifest);
			await copyFile(resolve(repository, 'LICENSE'), resolve(root, 'LICENSE'));
		}
		await writeFile(resolve(sdkStage, 'Cargo.toml'), '[workspace]\nresolver = "2"\nmembers = ["rust", "protocol", "editor-client-build"]\n');
		await writeFile(resolve(sdkStage, 'editor-api.json'), JSON.stringify(api, null, 2) + '\n');
		await copyFile(resolve(repository, 'LICENSE'), resolve(sdkStage, 'LICENSE'));
		const require = createRequire(import.meta.url);
		const dependencies = Object.fromEntries(['vite', 'typescript'].map(name => {
			const pkg = require(`${name}/package.json`);
			return [name, pkg.name === name ? pkg.version : `npm:${pkg.name}@${pkg.version}`];
		}));
		await writeFile(resolve(sdkStage, 'package.json'), JSON.stringify({ name: 'ash-extension-development-sdk', private: true, type: 'module', version: '0.1.0', engines: { node: '>=22.18' }, dependencies }, null, 2) + '\n');
		const output = await build({ configFile: false, logLevel: 'error', build: { write: false, target: 'node22', minify: false, lib: { entry: resolve(repository, 'build/builtin/extensionDevelopment.ts'), formats: ['es'], fileName: 'dev' }, rolldownOptions: { platform: 'node', external: ['vite', 'typescript', /^node:/u] } } });
		const chunks = (Array.isArray(output) ? output.flatMap(value => value.output) : 'output' in output ? output.output : []).filter(file => file.type === 'chunk');
		if (chunks.length !== 1) throw new Error('Development SDK must be one portable entrypoint');
		await writeFile(resolve(sdkStage, 'dev.mjs'), chunks[0].code);
		await mkdir(resolve(sdkStage, 'bin'));
		await copyFile(devHost, resolve(sdkStage, 'bin', process.platform === 'win32' ? 'editor_dev.exe' : 'editor_dev'));
		// Emit declarations only. Runtime implementations remain in the admitted Ash host.
		const sourcePath = (key: string): string => {
			const file = resolve(repository, 'src/ash', key.replace(/\.js$/u, '.ts'));
			return existsSync(file) ? file : file.replace(/\.ts$/u, '.d.ts');
		};
		const roots = [...new Set([...Object.keys(api.modules), ...api.types])].map(sourcePath);
		roots.push(resolve(repository, 'src/typings/thenable.d.ts'));
		const program = ts.createProgram(roots, { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, experimentalDecorators: true, declaration: true, emitDeclarationOnly: true, stripInternal: true, noCheck: true, skipLibCheck: true, rootDir: repository, outDir: resolve(sdkStage, 'types/internal') });
		const emitted = program.emit();
		if (emitted.emitSkipped) throw new Error(`Cannot emit editor API declarations: ${ts.formatDiagnostics(emitted.diagnostics, { getCanonicalFileName: path => path, getCurrentDirectory: () => repository, getNewLine: () => '\n' })}`);
		for (const source of program.getSourceFiles()) {
			// TypeScript normalizes source paths to '/', including on Windows.
			const path = relative(repository, source.fileName);
			if (!source.isDeclarationFile || !path.replaceAll('\\', '/').startsWith('src/')) continue;
			const destination = resolve(sdkStage, 'types/internal', path);
			await mkdir(dirname(destination), { recursive: true });
			await copyFile(source.fileName, destination);
		}
		const checker = program.getTypeChecker();
		for (const key of [...new Set([...Object.keys(api.modules), ...api.types])]) {
			const source = program.getSourceFile(sourcePath(key))!;
			const symbol = checker.getSymbolAtLocation(source);
			if (!symbol) throw new Error(`Editor API module has no symbol: ${key}`);
			const names = checker.getExportsOfModule(symbol).map(symbol => symbol.name).filter(name => name !== 'default' && !api.modules[key]?.includes(name));
			const destination = resolve(sdkStage, 'types/api', key.replace(/\.js$/u, '.d.ts'));
			const internal = relative(dirname(destination), resolve(sdkStage, 'types/internal/src/ash', key)).replaceAll('\\', '/');
			await mkdir(dirname(destination), { recursive: true });
			await writeFile(destination, `${api.modules[key]?.length ? `export { ${api.modules[key].join(', ')} } from '${internal}';\n` : ''}${names.length ? `export type { ${names.join(', ')} } from '${internal}';\n` : ''}`);
		}
		const academy = resolve(repository, 'extensions/academy');
		for (const name of ['src', 'browser', 'common', 'tests', 'build.rs', 'package.json', 'package.nls.json', 'package.nls.zh-CN.json', 'README.md']) await cp(resolve(academy, name), resolve(projectStage, name), { recursive: true });
		await copyFile(resolve(repository, 'LICENSE'), resolve(projectStage, 'LICENSE'));
		const pkg = metadata.packages.find(pkg => pkg.name === 'ash-academy')!;
		const sdkRelative = relative(project, sdk).replaceAll('\\', '/');
		await writeFile(resolve(projectStage, 'Cargo.toml'), cargoManifest(pkg, new Map([['ash-external-ext-sdk', `${sdkRelative}/rust`], ['ash-editor-client-build', `${sdkRelative}/editor-client-build`]])) + '\n[workspace]\n');
		await writeFile(resolve(projectStage, 'styles.d.ts'), "declare module '*.css';\n");
		await writeFile(resolve(projectStage, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2024', module: 'NodeNext', moduleResolution: 'NodeNext', experimentalDecorators: true, strict: true, skipLibCheck: true, noEmit: true, lib: ['ES2024', 'DOM', 'DOM.Iterable', 'ESNext.Disposable'], types: [], paths: { 'ash:editor/*': [`${sdkRelative}/types/api/*`] } }, include: ['styles.d.ts', 'browser/**/*.ts', 'common/**/*.ts', `${sdkRelative}/types/internal/src/typings/thenable.d.ts`] }, null, 2) + '\n');
		await writeFile(resolve(sdkStage, 'README.md'), await readFile(resolve(repository, 'sdk/docs/development.md'), 'utf8'));
		await rename(sdkStage, sdk);
		try { await rename(projectStage, project); } catch (error) { await rm(sdk, { recursive: true, force: true }); throw error; }
	} finally { await rm(sdkStage, { recursive: true, force: true }); await rm(projectStage, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1]).catch(() => '')).href) {
	const [sdk, project, devHost, ...extra] = process.argv.slice(2);
	if (!sdk || !project || !devHost || extra.length) throw new Error('Usage: extension:sdk <new-sdk-directory> <new-project-directory> <editor_dev-executable>');
	await exportExtensionSdk(sdk, project, resolve(devHost));
}
