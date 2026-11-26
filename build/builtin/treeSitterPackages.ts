import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { grammarResource, readGrammarPackages, treeSitterPackageName } from '../treeSitterRegistry.ts';
import { buildDeclarativePackage, publishDeclarativePackageDirectory } from './declarativePackages.ts';

const root = resolve(import.meta.dirname, '../..');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

/** Builds standalone registry submissions from the editor's checked queries and the pinned parser release. */
async function buildTreeSitterPackages(sourceLock: string, languageIndex: string, output: string): Promise<void> {
	const lock = JSON.parse(await readFile(resolve(root, 'third_party/ash-grammars/runtime-lock.json'), 'utf8'));
	const source = await readFile(sourceLock);
	if (createHash('sha256').update(source).digest('hex') !== lock.sourceLockSha256) {
		throw new Error('Grammar source lock does not match the pinned Ash release');
	}
	const index = JSON.parse(await readFile(languageIndex, 'utf8'));
	if (index.schemaVersion !== 2 || !Array.isArray(index.languages)) throw new Error('Invalid Extensions language index');
	const languageDisplayNames = new Map<string, string>();
	for (const { id, displayName } of index.languages) {
		if (typeof id !== 'string' || typeof displayName !== 'string' || !displayName.trim() || languageDisplayNames.has(id)) {
			throw new Error('Invalid language identity in Extensions index');
		}
		languageDisplayNames.set(id, displayName);
	}
	try { await lstat(output); throw new Error('Refusing to replace existing Tree-sitter submissions'); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
	const origins = new Map<string, string>(JSON.parse(source.toString('utf8')).grammars.map(({ name, crate }: { name: string; crate: string; }) => [name, crate]));
	const bundle = resolve(root, 'third_party/.cache/ash-grammars', lock.version, `wasm-${lock.wasm.sha256}`);
	const licenseDirectory = resolve(bundle, 'licenses');
	const licenseFiles = (await readdir(licenseDirectory)).sort();
	await mkdir(dirname(output), { recursive: true });
	const temporary = await mkdtemp(resolve(dirname(output), '.tree-sitter-packages-'));
	const submissions = resolve(temporary, 'submissions');
	try {
		await mkdir(submissions);
		for (const { directory, grammars } of await readGrammarPackages(root)) {
			const builtin = resolve(root, 'extensions', directory);
			const original = JSON.parse(await readFile(resolve(builtin, 'package.json'), 'utf8'));
			const messages = JSON.parse(await readFile(resolve(builtin, 'package.nls.json'), 'utf8').catch(error => {
				if (error.code !== 'ENOENT') throw error;
				return '{}';
			}));
			const name = treeSitterPackageName(directory);
			const authorPackage = resolve(temporary, name);
			await mkdir(resolve(authorPackage, 'queries'), { recursive: true });
			await mkdir(resolve(authorPackage, 'grammars'), { recursive: true });
			const associations = original.contributes.languages.map(({ configuration: _configuration, ...association }: { configuration?: string; id: string; }) => association);
			const displayName = original.displayName ?? '';
			const messageKey = /^%([^%]+)%$/u.exec(displayName)?.[1];
			const languageNames = associations.map((language: { id: string; aliases?: readonly string[]; }) => language.aliases?.[0] ?? language.id);
			const title = (messageKey ? messages[messageKey] : displayName) || languageNames.join(', ');
			const treeSitter = [];
			const notices = new Set<string>();
			for (const grammar of grammars) {
				const wasm = `grammars/${grammar.name}.wasm.gz`;
				await cp(resolve(bundle, 'renderer-wasm', `${grammar.name}.wasm.gz.bin`), resolve(authorPackage, wasm));
				const crate = origins.get(grammar.name);
				const upstream = licenseFiles.filter(file => file.replace(/-(?:\d+|upstream)\.txt$/u, '') === crate);
				if (!upstream.length) throw new Error(`Missing upstream license for ${grammar.name}`);
				for (const license of upstream) notices.add(resolve(licenseDirectory, license));
				const paths = { highlights: '', tags: '', folds: '', injections: '' };
				for (const kind of ['highlights', 'tags', 'folds', 'injections'] as const) {
					if (kind === 'injections' && !grammar.injections.length) continue;
					const queryPaths = grammar[kind].map(path => grammarResource(root, directory, path));
					for (const path of queryPaths) {
						const queryDirectory = dirname(path);
						for (const file of (await readdir(queryDirectory)).sort()) {
							if (file.endsWith('.LICENSE.txt')) notices.add(resolve(queryDirectory, file));
						}
					}
					paths[kind] = `queries/${grammar.name}.${kind}.scm`;
					const queries = await Promise.all(queryPaths.map(path => readFile(path, 'utf8')));
					await writeFile(resolve(authorPackage, paths[kind]), queries.join('\n'));
				}
				for (const { id, editorLanguage } of grammar.languages) {
					if (!associations.some((language: { id: string; }) => language.id === id || language.id === editorLanguage)) {
						throw new Error(`Missing editor language for ${directory}:${id}`);
					}
					treeSitter.push({ language: id, wasm, highlights: paths.highlights, tags: paths.tags, folds: paths.folds, ...(paths.injections ? { injections: paths.injections } : {}) });
				}
			}
			const readme = `# ${title} Tree-sitter syntax\n\nInstall this extension in the IDE for Tree-sitter highlighting, outline and folding.\n\nParser modules come from ash-grammars ${lock.version}. The package includes the applicable upstream notices.\n`;
			const licenses = await Promise.all([...notices].map(path => readFile(path, 'utf8')));
			await Promise.all([
				writeFile(resolve(authorPackage, 'README.md'), readme),
				writeFile(resolve(authorPackage, 'LICENSE'), licenses.join('\n\n')),
				writeFile(resolve(authorPackage, 'package.nls.json'), json({ displayName: `${title} Tree-sitter Syntax`, description: `Tree-sitter highlighting, outline and folding for ${title}.` })),
				writeFile(resolve(authorPackage, 'package.nls.zh-CN.json'), json({ displayName: `${title} Tree-sitter 语法`, description: '提供基于 Tree-sitter 的语法高亮、大纲和折叠。' })),
				writeFile(resolve(authorPackage, 'package.json'), json({
					name, publisher: 'marketplace', version: '1.0.0', license: 'LicenseRef-Ash', ashUiTargets: ['ide'],
					displayName: '%displayName%', description: '%description%', contributes: { languages: associations, treeSitter },
				})),
			]);
			await buildDeclarativePackage(authorPackage, resolve(submissions, name), languageDisplayNames);
		}
		await publishDeclarativePackageDirectory(submissions, output);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}

const [sourceLock, languageIndex, output] = process.argv.slice(2);
if (!sourceLock || !languageIndex || !output) throw new Error('Usage: package:syntax <verified grammar source lock> <Extensions language index> <new output directory>');
await buildTreeSitterPackages(resolve(sourceLock), resolve(languageIndex), resolve(output));
