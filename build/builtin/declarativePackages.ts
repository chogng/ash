import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readExtensionUiTargets } from './extensionManifest.ts';

/** Stages code-free editor and language packages for the existing signed Extensions registry. */
export async function buildDeclarativePackage(source: string, output: string): Promise<void> {
	const destination = relative(resolve(source), resolve(output));
	if (!isAbsolute(destination) && destination !== '..' && !destination.startsWith(`..${sep}`)) { throw new Error('The package output must be outside its source directory'); }
	const manifest = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'));
	if (!/^[a-z0-9-]+$/u.test(manifest.name) || !/^[a-z0-9-]+$/u.test(manifest.publisher) || !/^\d+\.\d+\.\d+$/u.test(manifest.version) || !manifest.contributes || ['main', 'browser', 'ashRuntime', 'activationEvents'].some(key => key in manifest)) { throw new Error('A declarative package must contain contributions without runtime code'); }
	const languages = manifest.contributes.languages ?? [];
	const kind = languages.length ? 'language' : 'editor';
	if (kind === 'editor' && !manifest.contributes.keybindings?.length) { throw new Error('A declarative editor package requires keybindings'); }
	const messages = JSON.parse(await readFile(resolve(source, 'package.nls.json'), 'utf8'));
	try { await lstat(output); throw new Error('Refusing to replace an existing package'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
	const staging = `${output}.partial-${crypto.randomUUID()}`;
	try {
		const assets = resolve(staging, 'package', kind);
		await mkdir(assets, { recursive: true });
		const copy = async (directory: string, relative = ''): Promise<void> => {
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				if (entry.name === 'test' || entry.name === 'node_modules' || entry.name.startsWith('.')) { continue; }
				const name = relative ? `${relative}/${entry.name}` : entry.name;
				if (entry.isSymbolicLink()) { throw new Error('Declarative package resources must not be symbolic links'); }
				if (entry.isDirectory()) { await mkdir(resolve(assets, name)); await copy(resolve(directory, entry.name), name); }
				else if (entry.isFile() && /\.(?:json|md)$/u.test(name)) { await cp(resolve(source, name), resolve(assets, name)); }
				else { throw new Error(`Unsupported declarative package resource: ${name}`); }
			}
		};
		await copy(source);
		await cp(resolve(source, 'README.md'), resolve(staging, 'package/README.md'));
		await cp(resolve(import.meta.dirname, '../../LICENSE'), resolve(staging, 'package/LICENSE'));
		const catalog = {
			schemaVersion: 2, packageType: kind, source: 'official', id: `${manifest.publisher}/${manifest.name}`, version: manifest.version,
			displayName: messages[manifest.displayName?.slice(1, -1)] ?? manifest.displayName,
			description: messages[manifest.description?.slice(1, -1)] ?? manifest.description,
			license: 'LicenseRef-Ash', uiTargets: readExtensionUiTargets(manifest.ashUiTargets), capabilities: [{ kind: 'asset', id: `${kind}-resources`, path: kind }],
			...(languages.length ? { languages: languages.map((language: { id: string; aliases?: string[]; extensions?: string[]; }) => ({ id: language.id, displayName: language.aliases?.[0] ?? language.id, aliases: language.aliases ?? [], fileExtensions: language.extensions ?? [] })) } : {}),
		};
		await writeFile(resolve(staging, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
		await rename(staging, output);
	} catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const [source, output] = process.argv.slice(2);
	if (!source || !output) { throw new Error('Usage: package:declarative <source> <output>'); }
	await buildDeclarativePackage(resolve(source), resolve(output));
}
