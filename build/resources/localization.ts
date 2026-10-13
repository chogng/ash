import ts from 'typescript';
import type { Plugin } from 'vite';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { LanguagePackCatalog } from '../../src/ash/platform/languagePacks/common/languagePackContract.ts';
import { ASH_LOCALIZATION_CATALOG_VERSION } from '../../src/ash/platform/languagePacks/common/languagePackContract.ts';
import { watchRebuild } from '../lib/watchRebuild.ts';
import { fingerprintPaths, PreparedInputs } from '../lib/preparedInputs.ts';

const repository = resolve(import.meta.dirname, '../..');
const localizationInputs = new PreparedInputs(resolve(repository, '.build/localization-inputs.json'));
export const localizationWatchRoots = ['src/ash', 'localization', 'extensions'].map(path => resolve(repository, path));

export function isLocalizationInput(path: string): boolean {
	const file = resolve(path);
	const [sources, translations, extensions] = localizationWatchRoots;
	return file.startsWith(`${translations}${sep}`) && file.endsWith('.json')
		|| file.startsWith(`${extensions}${sep}`) && file.endsWith('.json') && !relative(extensions, file).split(sep).some(part => ['node_modules', 'test', 'generated', '.git', 'target'].includes(part))
		|| file.startsWith(`${sources}${sep}`) && sourceInput(file, false);
}

function sourceInput(path: string, directory: boolean): boolean {
	return !relative(resolve(repository, 'src/ash'), path).split(sep).some(part => part === 'test' || part === 'generated')
		&& (directory || path.endsWith('.ts') && !path.endsWith('.test.ts'));
}

async function localizationFingerprint(): Promise<string> {
	return (await fingerprintPaths([resolve(repository, 'src/ash')], sourceInput)) + await fingerprintPaths([
		resolve(repository, 'localization'), resolve(repository, 'extensions'),
		resolve(repository, '.build/protocol/typescript/ApprovalModes.ts'),
		fileURLToPath(import.meta.url), resolve(repository, 'build/lib/preparedInputs.ts'), resolve(repository, 'pnpm-lock.yaml'),
	], (path, directory) => directory ? !['node_modules', 'test', 'generated', '.git', 'target'].includes(path.split(sep).at(-1)!) : path.startsWith(`${resolve(repository, 'extensions')}${sep}`) ? path.endsWith('.json') : /\.(json|ts|yaml)$/.test(path));
}

type Bundles = Record<string, Record<string, string>>;
export interface LocalizationSource { readonly path: string; readonly text: string; }

/** Stable bundle/key IDs are retained when source files move between domains. */
export function extractLocalizationMessages(sources: readonly LocalizationSource[]): Bundles {
	const bundles: Bundles = {};
	for (const input of sources) {
		// Escapes can spell either an NLS import or registerColor, so keep those files on the parser path.
		if (!/nls\.js|registerColor|\\/u.test(input.text)) { continue; }
		const source = ts.createSourceFile(input.path, input.text, ts.ScriptTarget.Latest, true);
		const names = new Map<string, string>();
		const namespaces = new Set<string>();
		const colorDeclarations = new Map<string, number>();
		for (const statement of source.statements) {
			if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !/\/nls\.js$/u.test(statement.moduleSpecifier.text)) { continue; }
			const imports = statement.importClause?.namedBindings;
			if (imports && ts.isNamedImports(imports)) {
				for (const item of imports.elements) { names.set(item.name.text, item.propertyName?.text ?? item.name.text); }
			} else if (imports && ts.isNamespaceImport(imports)) { namespaces.add(imports.name.text); }
		}
		// Color descriptions are declared by the theme owner and translated by its registry.
		if (input.text.includes('registerColor')) {
			const inspect = (node: ts.Node): void => {
				if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isArrowFunction(node.initializer)) {
					const parameters = node.initializer.parameters.map(parameter => parameter.name.getText(source));
					const inspectBody = (body: ts.Node): void => {
						if (ts.isCallExpression(body) && body.expression.getText(source) === 'registerColor' && body.arguments[2] && ts.isObjectLiteralExpression(body.arguments[2])) {
							const description = body.arguments[2].properties.find(property => (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && property.name.getText(source) === 'description');
							if (description && (ts.isPropertyAssignment(description) || ts.isShorthandPropertyAssignment(description))) {
								const name = ts.isPropertyAssignment(description) ? description.initializer.getText(source) : description.name.text;
								const index = parameters.indexOf(name);
								if (index >= 0) { colorDeclarations.set(node.name.getText(source), index); }
							}
						}
						ts.forEachChild(body, inspectBody);
					};
					inspectBody(node.initializer.body);
				}
				ts.forEachChild(node, inspect);
			};
			inspect(source);
		}
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node)) {
				const expression = node.expression;
				if (ts.isIdentifier(expression)) {
					const id = literal(node.arguments[0]);
					let description: string | undefined;
					const index = colorDeclarations.get(expression.text);
					if (index !== undefined) { description = literal(node.arguments[index]); }
					if (expression.text === 'registerColor' && node.arguments[2] && ts.isObjectLiteralExpression(node.arguments[2])) {
						const property = node.arguments[2].properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source) === 'description');
						if (property && ts.isPropertyAssignment(property)) { description = literal(property.initializer); }
					}
					if (id && description !== undefined) { addMessage(bundles, 'ash', `color.${id}`, description, input.path); }
				}
				const name = ts.isIdentifier(expression) ? names.get(expression.text)
					: ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && namespaces.has(expression.expression.text) ? expression.name.text : undefined;
				if (name === 'localize' || name === 'localize2') {
					let bundle = 'ash';
					let key = literal(node.arguments[0]);
					const info = node.arguments[0];
					if (info && ts.isObjectLiteralExpression(info)) {
						for (const property of info.properties) {
							if (!ts.isPropertyAssignment(property)) { continue; }
							if (property.name.getText(source) === 'key') { key = literal(property.initializer); }
							if (property.name.getText(source) === 'bundle') { bundle = literal(property.initializer) ?? ''; }
						}
					}
					const message = literal(node.arguments[1]);
					if (bundle && key && message !== undefined) { addMessage(bundles, bundle, key, message, input.path); }
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return bundles;
}

export function validateLocalizationTranslation(english: Bundles, translations: Bundles, locale: string): { missing: readonly string[]; unchanged: number; } {
	let unchanged = 0;
	for (const [bundle, messages] of Object.entries(translations)) {
		for (const [key, message] of Object.entries(messages)) {
			const original = english[bundle]?.[key];
			if (original === undefined) { throw new Error(`Unknown translation: ${locale}/${bundle}/${key}`); }
			if (placeholders(original) !== placeholders(message)) { throw new Error(`Translation parameters differ: ${locale}/${bundle}/${key}`); }
			if (original === message) { unchanged++; }
		}
	}
	const missing = Object.entries(english).flatMap(([bundle, messages]) => Object.keys(messages).filter(key => translations[bundle]?.[key] === undefined).map(key => `${bundle}/${key}`));
	return { missing, unchanged };
}

/** Validates sources; check mode does not require or write build outputs. */
export async function generateLocalization(check = false): Promise<boolean> {
	if (check) { return generate(true); }
	return localizationInputs.prepare(localizationFingerprint,
		() => fingerprintPaths([resolve(repository, '.build/desktop/localization')]), () => generate(false));
}

async function generate(check: boolean): Promise<boolean> {
	// Load only after protocol preparation, including a changed contract in a long-lived dev server.
	const approvalModes = resolve(repository, '.build/protocol/typescript/ApprovalModes.ts');
	const { APPROVAL_MODE_DEFINITIONS } = await import(`${pathToFileURL(approvalModes).href}?v=${await fingerprintPaths([approvalModes])}`) as typeof import('../../.build/protocol/typescript/ApprovalModes.ts');
	const sourceRoot = resolve(repository, 'src/ash');
	const resourceRoot = resolve(repository, 'localization');
	const sources = await readSources(sourceRoot);
	const english = extractLocalizationMessages(sources);
	merge(english, await readDomains(resolve(resourceRoot, 'en')), 'English declarations');
	for (const definition of APPROVAL_MODE_DEFINITIONS) {
		addMessage(english, 'ash', definition.label.key, definition.label.english, 'ApprovalModes');
		addMessage(english, 'ash', definition.description.key, definition.description.english, 'ApprovalModes');
	}
	const languages: LanguageMetadata[] = JSON.parse(await readFile(resolve(resourceRoot, 'languages.json'), 'utf8'));
	if (languages.length !== 1 || languages[0]?.locale !== 'en') throw new Error('Core localization must contain only English');
	const preinstalled: LanguagePackSource[] = [];
	for (const entry of (await readdir(resolve(repository, 'extensions'), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory()) continue;
		const packageRoot = resolve(repository, 'extensions', entry.name);
		const source = await readFile(resolve(packageRoot, 'package.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
		if (!source) continue;
		const manifest = JSON.parse(source);
		if (!manifest?.contributes || manifest.contributes.localizations === undefined) continue;
		const language = validateLanguagePackManifest(manifest, entry.name);
		if ([...languages, ...preinstalled.map(extension => extension.language)].some(value => value.locale.toLowerCase() === language.locale.toLowerCase())) {
			throw new Error(`Duplicate preinstalled language: ${language.locale}`);
		}
		preinstalled.push({ id: `${manifest.publisher}.${manifest.name}`, packageRoot, manifest, language });
	}
	const catalogs: LanguagePackCatalog[] = [];
	for (const language of [...languages, ...preinstalled.map(extension => extension.language)]) {
		const extension = preinstalled.find(value => value.language.locale === language.locale);
		const bundles = extension ? await readDomains(resolve(extension.packageRoot, 'translations')) : english;
		if (language.locale === 'zh-CN') {
			for (const definition of APPROVAL_MODE_DEFINITIONS) {
				addMessage(bundles, 'ash', definition.label.key, definition.label.chinese, 'ApprovalModes');
				addMessage(bundles, 'ash', definition.description.key, definition.description.chinese, 'ApprovalModes');
			}
		}
		if (extension) {
			const { missing, unchanged } = validateLocalizationTranslation(english, bundles, language.locale);
			console.log(`Localization ${language.locale}: ${missing.length} missing locale entries; ${unchanged} entries unchanged from source.`);
			if (process.argv.includes('--report-missing')) console.log(missing.join('\n'));
		}
		const extensionTranslations: Record<string, { package: Record<string, string>; bundle: Record<string, string>; }> = {};
		for (const target of extension?.manifest.contributes.localizations[0].translations ?? []) {
			if (target.id === 'ash') continue;
			const translation = JSON.parse(await readFile(resolve(extension!.packageRoot, target.path), 'utf8'));
			const contents = translation.contents;
			if (!isRecord(contents) || ![contents.package, contents.bundle].every(messages => isRecord(messages) && Object.values(messages).every(message => typeof message === 'string'))) { throw new Error(`Invalid extension translation: ${target.path}`); }
			extensionTranslations[target.id] = { package: contents.package as Record<string, string>, bundle: contents.bundle as Record<string, string> };
		}
		catalogs.push({ schemaVersion: 1, ...language, catalogVersion: ASH_LOCALIZATION_CATALOG_VERSION, bundles: sortBundles(bundles), ...(extension && Object.keys(extensionTranslations).length ? { extensionTranslations } : {}) });
	}
	if (check) { return false; }
	const directory = resolve(repository, '.build/desktop/localization');
	const header = `// Generated by build/resources/localization.ts. Edit feature NLS declarations or language pack extensions instead.\nimport type { LanguagePackCatalog, PreinstalledLanguagePack } from '../../../src/ash/platform/languagePacks/common/languagePackContract.js';\n`;
	// Separate data modules let the renderer emit one bounded chunk per language.
	const outputs = catalogs.map(catalog => ({
		file: `localizationCatalog.${catalog.locale}.ts`,
		text: `${header}\nexport const languagePackCatalog: LanguagePackCatalog = ${JSON.stringify(catalog, null, '\t')};\n`,
	}));
	const extensionDescriptors = preinstalled.map(extension => {
		const { version, displayName, description } = extension.manifest;
		return `{ ...${JSON.stringify({ id: `${extension.manifest.publisher}/${extension.manifest.name}`, version, displayName, description })}, catalog: catalog${catalogs.findIndex(catalog => catalog.locale === extension.language.locale)} }`;
	});
	outputs.push({
		file: 'localizationCatalogs.ts',
		text: `${header}${catalogs.map((catalog, index) => `import { languagePackCatalog as catalog${index} } from './localizationCatalog.${catalog.locale}.js';`).join('\n')}\n\nexport const builtinLanguagePackCatalogs: readonly LanguagePackCatalog[] = [catalog0];\nexport const preinstalledLanguagePacks: readonly PreinstalledLanguagePack[] = [${extensionDescriptors.join(', ')}];\nexport const productLanguagePackCatalogs: readonly LanguagePackCatalog[] = [...builtinLanguagePackCatalogs, ...preinstalledLanguagePacks.map(extension => extension.catalog)];\n`,
	});
	for (const extension of preinstalled) {
		const { manifest, language } = extension;
		const packageRoot = `extensions/${extension.id}`;
		const distribution = {
			schemaVersion: 2, packageType: 'localization', source: 'thirdParty', id: `${manifest.publisher}/${manifest.name}`,
			version: manifest.version, displayName: manifest.displayName, description: manifest.description, license: manifest.license,
			capabilities: [{ kind: 'asset', id: language.locale, path: 'localization' }], localizations: [language],
		};
		for (const target of manifest.contributes.localizations[0].translations) {
			if (target.id !== 'ash') { outputs.push({ file: `${packageRoot}/${target.path}`, text: await readFile(resolve(extension.packageRoot, target.path), 'utf8') }); }
		}
		for (const [file, value] of [
			['package.json', manifest],
			['localization/package.json', catalogs.find(catalog => catalog.locale === language.locale)],
			['manifest.json', distribution],
		] as const) {
			outputs.push({ file: `${packageRoot}/${file}`, text: JSON.stringify(value, null, 2) + '\n' });
		}
	}
	let changed = false;
	for (const output of outputs) {
		const target = resolve(directory, output.file);
		const current = await readFile(target, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
		if (current === output.text) continue;
		await mkdir(resolve(target, '..'), { recursive: true });
		await writeFile(target, output.text);
		changed = true;
	}
	return changed;
}

interface LanguageMetadata { readonly locale: string; readonly languageName: string; readonly localizedLanguageName: string; }
interface LanguagePackManifest {
	readonly name: string; readonly publisher: string; readonly version: string;
	readonly displayName: string; readonly description: string; readonly license: string;
	readonly contributes: { readonly localizations: readonly { readonly translations: readonly { readonly id: string; readonly path: string; }[]; }[]; };
}
interface LanguagePackSource {
	readonly id: string; readonly packageRoot: string; readonly manifest: LanguagePackManifest; readonly language: LanguageMetadata;
}

function validateLanguagePackManifest(manifest: unknown, directory: string): LanguageMetadata {
	const invalid = (): never => { throw new Error(`Invalid Ash language pack: ${directory}`); };
	if (!isRecord(manifest) || !isRecord(manifest.contributes) || !Array.isArray(manifest.contributes.localizations)
		|| manifest.contributes.localizations.length !== 1) return invalid();
	const language = manifest.contributes.localizations[0];
	if (!['publisher', 'name'].every(key => typeof manifest[key] === 'string' && /^[a-z0-9][a-z0-9-]*$/u.test(manifest[key] as string))
		|| !['version', 'displayName', 'description', 'license'].every(key => typeof manifest[key] === 'string' && manifest[key])
		|| !isRecord(manifest.engines) || typeof manifest.engines.ash !== 'string'
		|| manifest.main !== undefined || manifest.browser !== undefined || manifest.ashRuntime !== undefined
		|| !isRecord(language) || typeof language.languageId !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(language.languageId)
		|| typeof language.languageName !== 'string' || !language.languageName || typeof language.localizedLanguageName !== 'string' || !language.localizedLanguageName
		|| !Array.isArray(language.translations) || !language.translations.length || language.translations.length > 2048) return invalid();
	const targets = new Set<string>();
	for (const target of language.translations) {
		if (!isRecord(target) || typeof target.id !== 'string' || (target.id !== 'ash' && !/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/u.test(target.id))
			|| targets.has(target.id) || typeof target.path !== 'string' || !target.path.endsWith('.json')
			|| target.path.includes('\\') || target.path.includes(':') || target.path.split('/').some(segment => !segment || segment === '.' || segment === '..')) return invalid();
		targets.add(target.id);
		if (target.id === 'ash' && target.path !== 'localization/package.json') return invalid();
	}
	if (!targets.has('ash')) return invalid();
	return { locale: language.languageId, languageName: language.languageName, localizedLanguageName: language.localizedLanguageName };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rebuild the startup resource when a feature declaration or translation changes. */
export function localizationPlugin(options: { watch?: boolean; } = {}): Plugin {
	let stopWatching: (() => Promise<void>) | undefined;
	return {
		name: 'ash-localization',
		async buildStart() { await generateLocalization(); },
		async closeBundle() { await stopWatching?.(); },
		configureServer(server) {
			if (options.watch === false) { return; }
			server.watcher.add(localizationWatchRoots);
			stopWatching = watchRebuild(server, isLocalizationInput, generateLocalization);
		},
	};
}

function validateJsonProperties(path: string, text: string): void {
	const source = ts.parseJsonText(path, text);
	const visit = (node: ts.Node): void => {
		if (ts.isObjectLiteralExpression(node)) {
			const names = new Set<string>();
			for (const property of node.properties) {
				if (!ts.isPropertyAssignment(property)) continue;
				const key = literal(property.name)!;
				if (names.has(key)) throw new Error(`Duplicate translation property: ${path}/${key}`);
				names.add(key);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
}

function literal(node: ts.Node | undefined): string | undefined {
	return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

function addMessage(bundles: Bundles, bundle: string, key: string, message: string, source: string): void {
	const messages = bundles[bundle] ??= {};
	if (Object.hasOwn(messages, key) && messages[key] !== message) { throw new Error(`Conflicting English declaration: ${bundle}/${key} in ${source}`); }
	messages[key] = message;
}

function merge(target: Bundles, source: Bundles, path: string): void {
	for (const [bundle, messages] of Object.entries(source)) {
		for (const [key, message] of Object.entries(messages)) { addMessage(target, bundle, key, message, path); }
	}
}

function placeholders(message: string): string {
	return [...new Set([...message.matchAll(/\{([\w.-]+)\}/gu)].map(match => match[1]))].sort().join(',');
}

function sortBundles(bundles: Bundles): Bundles {
	return Object.fromEntries(Object.entries(bundles).sort(([a], [b]) => a.localeCompare(b)).map(([bundle, messages]) => [bundle, Object.fromEntries(Object.entries(messages).sort(([a], [b]) => a.localeCompare(b)))]));
}

async function readDomains(directory: string): Promise<Bundles> {
	const bundles: Bundles = {};
	for (const name of (await readdir(directory)).filter(name => name.endsWith('.json')).sort()) {
		const path = resolve(directory, name);
		const text = await readFile(path, 'utf8');
		validateJsonProperties(path, text);
		const value = JSON.parse(text);
		for (const [bundle, messages] of Object.entries(value)) {
			if (!messages || typeof messages !== 'object' || Array.isArray(messages)) { throw new Error(`Invalid translation bundle: ${path}/${bundle}`); }
			for (const [key, message] of Object.entries(messages)) {
				if (typeof message !== 'string' || !key) { throw new Error(`Invalid translation: ${path}/${bundle}/${key}`); }
				if (Object.hasOwn(bundles[bundle] ?? {}, key)) { throw new Error(`Duplicate translation: ${path}/${bundle}/${key}`); }
				addMessage(bundles, bundle, key, message, path);
			}
		}
	}
	return bundles;
}

async function readSources(sourceRoot: string): Promise<LocalizationSource[]> {
	const files: string[] = [];
	async function collect(directory: string): Promise<void> {
		for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
			const path = resolve(directory, entry.name);
			if (entry.isDirectory()) {
				if (sourceInput(path, true)) { await collect(path); }
			} else if (sourceInput(path, false)) {
				files.push(path);
			}
		}
	}
	await collect(sourceRoot);
	const sources: LocalizationSource[] = [];
	// Bound open files while preserving traversal order for conflict diagnostics and generated catalogs.
	for (let offset = 0; offset < files.length; offset += 32) {
		sources.push(...await Promise.all(files.slice(offset, offset + 32).map(async path => ({ path: relative(sourceRoot, path), text: await readFile(path, 'utf8') }))));
	}
	return sources;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	await generateLocalization(process.argv.includes('--check'));
}
