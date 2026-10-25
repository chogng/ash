import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileEditorClient } from './editorClients.ts';
import type { EditorClientApi } from './editorClientApi.ts';
import { readExtensionUiTargets } from './extensionManifest.ts';

export interface EditorPackageBinary {
	readonly targetPlatform: string;
	readonly path: string;
}

/** Stage one immutable market submission. Signing and publication remain with the registry. */
export async function buildEditorPackage(packageRoot: string, binaries: readonly EditorPackageBinary[], output: string, sdk?: { api: EditorClientApi; licenseFile: string; }): Promise<void> {
	if (!binaries.length) throw new Error('An editor package needs at least one platform executable');
	const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
	if (manifest.ashRuntime?.kind !== 'rust' || !manifest.ashRuntime.client || !/^[a-z0-9-]+$/u.test(manifest.ashRuntime.entrypoint) || !/^[a-z0-9-]+$/u.test(manifest.publisher) || !/^[a-z0-9-]+$/u.test(manifest.name)) throw new Error('Invalid editor source manifest');
	const messages = JSON.parse(await readFile(resolve(packageRoot, 'package.nls.json'), 'utf8'));
	const platforms = new Set<string>();
	for (const binary of binaries) {
		if (!/^(?:darwin-(?:arm64|x64)|linux-(?:arm64|armhf|x64)|win32-(?:arm64|ia32|x64))$/u.test(binary.targetPlatform) || platforms.has(binary.targetPlatform)) throw new Error('Invalid or duplicate editor executable platform');
		platforms.add(binary.targetPlatform);
		if (!(await stat(binary.path)).isFile()) throw new Error('Editor executable must be a regular file');
	}
	try { await lstat(output); throw new Error('Refusing to replace an existing editor package'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
	const compiled = await compileEditorClient(packageRoot, sdk?.api);
	const staging = `${output}.partial-${crypto.randomUUID()}`;
	const payload = resolve(staging, 'package');
	const assets = resolve(payload, 'editor');
	await mkdir(assets, { recursive: true });
	try {
		manifest.ashRuntime.client = compiled.client;
		const declarations = [];
		const capabilities: { kind: string; id: string; path: string; runtime?: string; }[] = [{ kind: 'asset', id: 'editor-resources', path: 'editor' }];
		for (const binary of [...binaries].sort((left, right) => left.targetPlatform.localeCompare(right.targetPlatform))) {
			const executable = `bin/${binary.targetPlatform}/${manifest.ashRuntime.entrypoint}${binary.targetPlatform.startsWith('win32-') ? '.exe' : ''}`;
			const id = `editor-runtime-${binary.targetPlatform}`;
			await mkdir(dirname(resolve(payload, executable)), { recursive: true });
			await copyFile(binary.path, resolve(payload, executable));
			await chmod(resolve(payload, executable), 0o755);
			capabilities.push({ kind: 'executable', id, path: executable, runtime: 'direct' });
			declarations.push({ id: manifest.name, executable: id, targetPlatform: binary.targetPlatform, runtimeApiVersion: 1, activationEvents: [{ type: 'onDemand', capability: 'dataChannel' }], capabilities: ['dataChannel'] });
		}
		await copyFile(resolve(packageRoot, 'README.md'), resolve(payload, 'README.md'));
		for (const name of ['README.md', 'package.nls.json', 'package.nls.zh-CN.json']) await copyFile(resolve(packageRoot, name), resolve(assets, name));
		await copyFile(sdk?.licenseFile ?? resolve(import.meta.dirname, '../../LICENSE'), resolve(payload, 'LICENSE'));
		await writeFile(resolve(assets, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
		for (const [path, content] of Object.entries(compiled.resources)) {
			await mkdir(dirname(resolve(assets, path)), { recursive: true });
			await writeFile(resolve(assets, path), content);
		}
		await mkdir(resolve(assets, 'ash'));
		await writeFile(resolve(assets, 'ash/editor-extensions.json'), JSON.stringify({ schemaVersion: 1, editorExtensions: declarations }, null, 2) + '\n');
		const catalog = { schemaVersion: 2, packageType: 'editor', source: 'official', id: `${manifest.publisher}/${manifest.name}`, version: manifest.version, displayName: messages[manifest.displayName?.slice(1, -1)] ?? manifest.displayName ?? manifest.name, description: messages[manifest.description?.slice(1, -1)] ?? manifest.description ?? manifest.name, license: 'LicenseRef-Ash', uiTargets: readExtensionUiTargets(manifest.ashUiTargets), capabilities };
		await writeFile(resolve(staging, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
		await rename(staging, output);
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
}

if (import.meta.url.endsWith('/editorPackages.ts') && process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1]).catch(() => '')).href) {
	const [source, output, ...arguments_] = process.argv.slice(2);
	if (!source || !output || !arguments_.length || arguments_.some(value => !/^[a-z0-9-]+=.+$/u.test(value))) throw new Error('Usage: package:editor <source> <output> <target-platform>=<executable> ...');
	await buildEditorPackage(resolve(source), arguments_.map(value => ({ targetPlatform: value.slice(0, value.indexOf('=')), path: resolve(value.slice(value.indexOf('=') + 1)) })), resolve(output));
}
