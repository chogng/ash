import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { delimiter, dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = resolve(import.meta.dirname, '../..');
const directory = resolve(root, 'extensions/theme-defaults');
export const browserExtensionRoots = [resolve(root, 'extensions'), ...String(process.env.ASH_WEB_EXTENSION_PATHS ?? '').split(delimiter).filter(Boolean).map(path => resolve(path))];

export async function prepareBrowserExtensions(): Promise<void> {
	const packages = (await readdir(browserExtensionRoots[0], { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)).map(entry => resolve(browserExtensionRoots[0], entry.name));
	const builtInCount = packages.length;
	packages.push(...browserExtensionRoots.slice(1));
	const extensions = [];
	const bundledResources: Record<string, Record<string, string>> = {};
	for (const [index, packageRoot] of packages.entries()) {
		const manifestJson = await readFile(resolve(packageRoot, 'package.json'), 'utf8');
		const manifest = JSON.parse(manifestJson);
		const id = `${manifest.publisher}.${manifest.name}`;
		if (Object.hasOwn(bundledResources, id)) { throw new Error(`Duplicate browser extension: ${id}`); }
		const packageResources: Record<string, string> = {};
		async function collect(resourceDirectory: string): Promise<void> {
			for (const entry of (await readdir(resourceDirectory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
				if (entry.name.startsWith('.') || ['node_modules', 'test'].includes(entry.name)) { continue; }
				const path = resolve(resourceDirectory, entry.name);
				if (entry.isDirectory()) { await collect(path); }
				else if (entry.isFile()) { packageResources[relative(packageRoot, path).replaceAll('\\', '/')] = (await readFile(path)).toString('base64'); }
			}
		}
		await collect(packageRoot);
		if (typeof manifest.browser === 'string') {
			// Each Worker imports one immutable module. Package dependencies stay inside that module.
			const entry = manifest.browser.replace(/^\.\//, '');
			const result = await build({ configFile: false, logLevel: 'error',
				build: { write: false, minify: false, lib: { entry: resolve(packageRoot, entry), formats: ['es'], fileName: 'extension' } } });
			const outputs = Array.isArray(result) ? result.flatMap(output => output.output) : 'output' in result ? result.output : [];
			const chunks = outputs.filter(output => output.type === 'chunk');
			if (chunks.length !== 1) throw new Error(`Browser extension '${id}' must produce one ES module`);
			packageResources[entry] = Buffer.from(chunks[0].code).toString('base64');
		}
		bundledResources[id] = packageResources;
		extensions.push({ id, name: manifest.name, publisher: manifest.publisher, version: manifest.version, displayName: manifest.name, sourceKind: index < builtInCount ? 'builtIn' : 'user', manifestJson, manifestSha256: digest(manifestJson), packageSha256: digest(JSON.stringify(packageResources)) });
	}
	await publish(resolve(root, 'app-ts/src/ash/platform/extensions/common/generated/browser.json'), { catalog: { generation: 1, diagnostics: [], extensions }, resources: bundledResources });
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
	const output = resolve(root, 'app-ts/src/ash/platform/extensions/common/generated/theme-defaults.json');
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
