import ts from 'typescript';
import type { Plugin } from 'vite';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASH_LOCALIZATION_CATALOG_VERSION } from '../../src/ash/platform/languagePacks/common/languagePackContract.ts';
import { APPROVAL_MODE_DEFINITIONS } from '../../src/ash/platform/app-server/common/generated/ApprovalModes.ts';

type Bundles = Record<string, Record<string, string>>;
export interface LocalizationSource { readonly path: string; readonly text: string; }

/** Stable bundle/key IDs are retained when source files move between domains. */
export function extractLocalizationMessages(sources: readonly LocalizationSource[]): Bundles {
	const bundles: Bundles = {};
	for (const input of sources) {
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

export async function generateLocalization(check = false): Promise<boolean> {
	const repository = resolve(import.meta.dirname, '../..');
	const sourceRoot = resolve(repository, 'src/ash');
	const resourceRoot = resolve(repository, 'localization');
	const sources = await readSources(sourceRoot);
	const english = extractLocalizationMessages(sources);
	merge(english, await readDomains(resolve(resourceRoot, 'en')), 'English declarations');
	for (const definition of APPROVAL_MODE_DEFINITIONS) {
		addMessage(english, 'ash', definition.label.key, definition.label.english, 'ApprovalModes');
		addMessage(english, 'ash', definition.description.key, definition.description.english, 'ApprovalModes');
	}
	const languages: { locale: string; languageName: string; localizedLanguageName: string; }[] = JSON.parse(await readFile(resolve(resourceRoot, 'languages.json'), 'utf8'));
	const catalogs = [];
	for (const language of languages) {
		const bundles = language.locale === 'en' ? english : await readDomains(resolve(resourceRoot, language.locale));
		if (language.locale === 'zh-CN') {
			for (const definition of APPROVAL_MODE_DEFINITIONS) {
				addMessage(bundles, 'ash', definition.label.key, definition.label.chinese, 'ApprovalModes');
				addMessage(bundles, 'ash', definition.description.key, definition.description.chinese, 'ApprovalModes');
			}
		}
		if (language.locale !== 'en') {
			const { missing, unchanged } = validateLocalizationTranslation(english, bundles, language.locale);
			console.log(`Localization ${language.locale}: ${missing.length} missing locale entries; ${unchanged} entries unchanged from source.`);
			if (process.argv.includes('--report-missing')) console.log(missing.join('\n'));
		}
		catalogs.push({ schemaVersion: 1, ...language, catalogVersion: ASH_LOCALIZATION_CATALOG_VERSION, bundles: sortBundles(bundles) });
	}
	const directory = resolve(sourceRoot, 'workbench/services/localization/common');
	const header = `// Generated by build/resources/localization.ts. Edit feature NLS declarations or localization instead.\nimport type { LanguagePackCatalog } from '../../../../platform/languagePacks/common/languagePacksService.js';\n`;
	// Separate data modules let the renderer emit one bounded chunk per language.
	const outputs = catalogs.map(catalog => ({
		file: `localizationCatalog.${catalog.locale}.ts`,
		text: `${header}\nexport const languagePackCatalog: LanguagePackCatalog = ${JSON.stringify(catalog, null, '\t')};\n`,
	}));
	outputs.push({
		file: 'localizationCatalogs.ts',
		text: `${header}${catalogs.map((catalog, index) => `import { languagePackCatalog as catalog${index} } from './localizationCatalog.${catalog.locale}.js';`).join('\n')}\n\nexport const builtinLanguagePackCatalogs: readonly LanguagePackCatalog[] = [${catalogs.map((_, index) => `catalog${index}`).join(', ')}];\n`,
	});
	let changed = false;
	for (const output of outputs) {
		const target = resolve(directory, output.file);
		const current = await readFile(target, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
		if (current === output.text) continue;
		if (check) throw new Error('Localization catalogs are stale. Run pnpm localization:generate.');
		await writeFile(target, output.text);
		changed = true;
	}
	return changed;
}

/** Rebuild the startup resource when a feature declaration or translation changes. */
export function localizationPlugin(): Plugin {
	const repository = resolve(import.meta.dirname, '../..');
	const sources = resolve(repository, 'src/ash');
	const translations = resolve(repository, 'localization');
	let pending: Promise<unknown> = Promise.resolve();
	let timer: NodeJS.Timeout | undefined;
	return {
		name: 'ash-localization',
		async buildStart() { await generateLocalization(); },
		configureServer(server) {
			server.watcher.add(translations);
			server.watcher.on('all', (event, path) => {
				const file = resolve(path);
				if (!['add', 'change', 'unlink'].includes(event) || isGeneratedCatalog(file)) return;
				if (!(file.startsWith(`${translations}${sep}`) || file.startsWith(`${sources}${sep}`) && file.endsWith('.ts'))) return;
				clearTimeout(timer);
				timer = setTimeout(() => {
					pending = pending.then(() => generateLocalization()).then(changed => {
						if (changed) server.ws.send({ type: 'full-reload' });
					}).catch(error => server.config.logger.error(String(error), { error }));
				}, 50);
			});
			server.httpServer?.once('close', () => clearTimeout(timer));
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

function isGeneratedCatalog(path: string): boolean {
	return /\/localization\/common\/localizationCatalog(?:s|\.[^/]+)\.ts$/u.test(path.replaceAll('\\', '/'));
}

async function readSources(directory: string, sourceRoot = directory): Promise<LocalizationSource[]> {
	const sources: LocalizationSource[] = [];
	for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			if (!['test', 'generated'].includes(entry.name)) { sources.push(...await readSources(path, sourceRoot)); }
		} else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !isGeneratedCatalog(path)) {
			sources.push({ path: relative(sourceRoot, path), text: await readFile(path, 'utf8') });
		}
	}
	return sources;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	await generateLocalization(process.argv.includes('--check'));
}
