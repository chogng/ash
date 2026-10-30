import ts from 'typescript';
import type { Plugin } from 'vite';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { LanguagePackCatalog } from '../../src/ash/platform/languagePacks/common/languagePackContract.ts';
import { ASH_LOCALIZATION_CATALOG_VERSION } from '../../src/ash/platform/languagePacks/common/languagePackContract.ts';
import { watchRebuild } from '../lib/watchRebuild.ts';
import { fingerprintPaths, PreparedInputs } from '../lib/preparedInputs.ts';
import { readPreinstalledLanguagePackIds } from './languagePacks.ts';
import { readExtensionUiTargets } from '../builtin/extensionManifest.ts';

const repository = resolve(import.meta.dirname, '../..');
const localizationInputs = new PreparedInputs(resolve(repository, '.build/localization-inputs.json'));
export const localizationWatchRoots = ['src/ash', 'localization', 'extensions'].map(path => resolve(repository, path));

export function isLocalizationInput(path: string): boolean {
	const file = resolve(path);
	const [sources, translations, extensions] = localizationWatchRoots;
	return file.startsWith(`${translations}${sep}`) && file.endsWith('.json')
		|| file.startsWith(`${extensions}${sep}`) && (file.endsWith('.json') || clientEditorSource(file)) && !relative(extensions, file).split(sep).some(part => ['node_modules', 'test', 'generated', '.git', 'target'].includes(part))
		|| file.startsWith(`${sources}${sep}`) && sourceInput(file, false);
}

/** Product-compiled client components keep their existing NLS keys after package extraction. */
function clientEditorSource(path: string): boolean {
	return /^[^/]+\/(?:browser|common)\//u.test(relative(resolve(repository, 'extensions'), path).split(sep).join('/'))
		&& sourceInput(path, false);
}

function sourceInput(path: string, directory: boolean): boolean {
	return !relative(resolve(repository, 'src/ash'), path).split(sep).some(part => part === 'test' || part === 'generated')
		&& (directory || path.endsWith('.ts') && !path.endsWith('.test.ts'));
}

async function localizationFingerprint(): Promise<string> {
	return (await fingerprintPaths([resolve(repository, 'src/ash')], sourceInput)) + await fingerprintPaths([
		resolve(repository, 'localization'), resolve(repository, 'extensions'),
		resolve(repository, '.build/protocol/typescript/ApprovalModes.ts'),
		resolve(repository, '.build/protocol/typescript/ProductSlashCommands.ts'),
		fileURLToPath(import.meta.url), resolve(repository, 'build/resources/languagePacks.ts'), resolve(repository, 'build/builtin/extensionManifest.ts'), resolve(repository, 'build/lib/preparedInputs.ts'), resolve(repository, 'pnpm-lock.yaml'),
	], (path, directory) => directory ? !['node_modules', 'test', 'generated', '.git', 'target'].includes(path.split(sep).at(-1)!) : path.startsWith(`${resolve(repository, 'extensions')}${sep}`) ? path.endsWith('.json') || clientEditorSource(path) : /\.(json|ts|yaml)$/.test(path));
}

type Bundles = Record<string, Record<string, string>>;
export interface LocalizationSource { readonly path: string; readonly text: string; }

/** Stable bundle/key IDs are retained when source files move between domains. */
export function extractLocalizationMessages(sources: readonly LocalizationSource[]): Bundles {
	const bundles: Bundles = {};
	for (const input of sources) {
		// Escapes can spell either an NLS import or registerColor, so keep those files on the parser path.
		if (!/nls\.js|localizationService\.js|localizationKey|ariaLabelKey|registerColor|\\/u.test(input.text)) { continue; }
		const source = ts.createSourceFile(input.path, input.text, ts.ScriptTarget.Latest, true);
		const names = new Map<string, string>();
		const namespaces = new Set<string>();
		const serviceTypes = new Set<string>();
		const colorDeclarations = new Map<string, number>();
		for (const statement of source.statements) {
			if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) { continue; }
			const serviceImport = /\/localization\/common\/localizationService\.js$/u.test(statement.moduleSpecifier.text);
			if (!serviceImport && !/\/nls\.js$/u.test(statement.moduleSpecifier.text)) { continue; }
			const imports = statement.importClause?.namedBindings;
			if (imports && ts.isNamedImports(imports)) {
				for (const item of imports.elements) {
					const name = item.propertyName?.text ?? item.name.text;
					if (serviceImport) {
						if (name === 'ILocalizationService') serviceTypes.add(item.name.text);
						if (name === 'localize') names.set(item.name.text, 'serviceLocalize');
					} else names.set(item.name.text, name);
				}
			} else if (!serviceImport && imports && ts.isNamespaceImport(imports)) { namespaces.add(imports.name.text); }
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
		interface MessageCall { readonly bundle: string; readonly key: ts.Expression; readonly message: ts.Expression; }
		const keyReference = (key: ts.Expression): { prefix: string; parameter: string; } | undefined => {
			if (ts.isIdentifier(key)) return { prefix: '', parameter: key.text };
			if (ts.isTemplateExpression(key) && key.templateSpans.length === 1 && ts.isIdentifier(key.templateSpans[0].expression) && !key.templateSpans[0].literal.text) {
				return { prefix: key.head.text, parameter: key.templateSpans[0].expression.text };
			}
			return undefined;
		};
		const messageCall = (node: ts.CallExpression, services: ReadonlySet<string>): MessageCall | undefined => {
			const expression = node.expression;
			if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'translate' && services.has(expression.expression.getText(source))) {
				const bundle = literal(node.arguments[0]);
				if (bundle && node.arguments[1] && node.arguments[2]) return { bundle, key: node.arguments[1], message: node.arguments[2] };
			}
			const name = ts.isIdentifier(expression) ? names.get(expression.text)
				: ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && namespaces.has(expression.expression.text) ? expression.name.text : undefined;
			const offset = name === 'serviceLocalize' ? 1 : 0;
			if (!['localize', 'localize2', 'serviceLocalize'].includes(name ?? '')) return undefined;
			const info = node.arguments[offset];
			const message = node.arguments[offset + 1];
			if (!info || !message) return undefined;
			if (!ts.isObjectLiteralExpression(info)) return name === 'serviceLocalize' ? undefined : { bundle: 'ash', key: info, message };
			const property = (name: string) => info.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source) === name) as ts.PropertyAssignment | undefined;
			const key = property('key')?.initializer;
			const bundleProperty = property('bundle');
			const bundle = bundleProperty ? literal(bundleProperty.initializer) : 'ash';
			return bundle && key ? { bundle, key, message } : undefined;
		};
		interface ForwardedCall { readonly bundle: string; readonly prefix: string; readonly key: number; readonly message: number; }
		// Only follow same-class methods that forward parameters to the NLS API or a
		// typed localization service. Unrelated methods with the same name are ignored.
		const visit = (node: ts.Node, services: ReadonlySet<string> = new Set(), wrappers: ReadonlyMap<string, readonly ForwardedCall[]> = new Map()): void => {
			if (ts.isObjectLiteralExpression(node)) {
				const property = (name: string) => node.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source) === name) as ts.PropertyAssignment | undefined;
				// View and region descriptors already own both a stable NLS key and
				// its English fallback; extract that contract without evaluating UI code.
				for (const [keyProperty, textProperty] of [['localizationKey', 'title'], ['ariaLabelKey', 'ariaLabel'], ['viewsAriaLabelKey', 'viewsAriaLabel']] as const) {
					const info = property(keyProperty)?.initializer;
					const message = literal(property(textProperty)?.initializer);
					if (!info || !ts.isObjectLiteralExpression(info) || message === undefined) continue;
					const fields = info.properties.filter(ts.isPropertyAssignment);
					const bundle = literal(fields.find(field => field.name.getText(source) === 'bundle')?.initializer);
					const key = literal(fields.find(field => field.name.getText(source) === 'key')?.initializer);
					if (bundle && key) addMessage(bundles, bundle, key, message, input.path);
				}
			}
			if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
				const classServices = new Set<string>();
				const isService = (type: ts.TypeNode | undefined): boolean => !!type && (ts.isTypeReferenceNode(type) && serviceTypes.has(type.typeName.getText(source)) || ts.isUnionTypeNode(type) && type.types.some(isService));
				for (const member of node.members) {
					if (ts.isPropertyDeclaration(member) && isService(member.type)) classServices.add(`this.${member.name.getText(source)}`);
					if (ts.isConstructorDeclaration(member)) {
						for (const parameter of member.parameters) {
							if (isService(parameter.type) && ts.isIdentifier(parameter.name)) {
								classServices.add(parameter.name.text);
								if (parameter.modifiers?.some(modifier => [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.ReadonlyKeyword].includes(modifier.kind))) classServices.add(`this.${parameter.name.text}`);
							}
						}
					}
				}
				const classWrappers = new Map<string, ForwardedCall[]>();
				const methods: { name: string; parameters: string[]; calls: ts.CallExpression[]; }[] = [];
				for (const member of node.members) {
					if (!ts.isMethodDeclaration(member) || !member.body || !ts.isIdentifier(member.name)) continue;
					const method = { name: member.name.text, parameters: member.parameters.map(parameter => parameter.name.getText(source)), calls: [] as ts.CallExpression[] };
					const inspect = (body: ts.Node): void => {
						if (ts.isFunctionLike(body) || ts.isClassDeclaration(body) || ts.isClassExpression(body)) return;
						if (ts.isCallExpression(body)) method.calls.push(body);
						ts.forEachChild(body, inspect);
					};
					inspect(member.body);
					methods.push(method);
				}
				// Resolve forwarding chains such as setStatus → label → translate,
				// independent of declaration order, with a bound on traversal depth.
				for (let depth = 0; depth < methods.length; depth++) {
					let changed = false;
					for (const method of methods) {
						for (const node of method.calls) {
							const direct = messageCall(node, classServices);
							const calls: (MessageCall & { prefix: string; })[] = direct ? [{ ...direct, prefix: '' }] : [];
							if (!direct && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
								for (const wrapper of classWrappers.get(node.expression.name.text) ?? []) {
									if (node.arguments[wrapper.key] && node.arguments[wrapper.message]) calls.push({ bundle: wrapper.bundle, prefix: wrapper.prefix, key: node.arguments[wrapper.key], message: node.arguments[wrapper.message] });
								}
							}
							for (const call of calls) {
								const reference = keyReference(call.key);
								if (!reference || !ts.isIdentifier(call.message)) continue;
								const key = method.parameters.indexOf(reference.parameter), message = method.parameters.indexOf(call.message.text);
								if (key < 0 || message < 0) continue;
								const declaration = { bundle: call.bundle, prefix: call.prefix + reference.prefix, key, message };
								const declarations = classWrappers.get(method.name) ?? [];
								if (declarations.some(value => value.bundle === declaration.bundle && value.prefix === declaration.prefix && value.key === key && value.message === message)) continue;
								declarations.push(declaration);
								classWrappers.set(method.name, declarations);
								changed = true;
							}
						}
					}
					if (!changed) break;
				}
				for (const member of node.members) visit(member, classServices, classWrappers);
				return;
			}
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
				const call = messageCall(node, services);
				if (!call && ts.isPropertyAccessExpression(expression) && expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
					for (const wrapper of wrappers.get(expression.name.text) ?? []) {
						const key = literal(node.arguments[wrapper.key]), message = literal(node.arguments[wrapper.message]);
						if (key && message !== undefined) addMessage(bundles, wrapper.bundle, wrapper.prefix + key, message, input.path);
					}
				}
				if (call) {
					const key = literal(call.key), message = literal(call.message);
					if (key && message !== undefined) addMessage(bundles, call.bundle, key, message, input.path);
				}
			}
			ts.forEachChild(node, child => visit(child, services, wrappers));
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
	const slashCommands = resolve(repository, '.build/protocol/typescript/ProductSlashCommands.ts');
	const { PRODUCT_SLASH_COMMANDS } = await import(`${pathToFileURL(slashCommands).href}?v=${await fingerprintPaths([slashCommands])}`) as typeof import('../../.build/protocol/typescript/ProductSlashCommands.ts');
	const sourceRoot = resolve(repository, 'src/ash');
	const resourceRoot = resolve(repository, 'localization');
	const sources = await readSources(sourceRoot);
	for (const entry of await readdir(resolve(repository, 'extensions'), { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const packageRoot = resolve(repository, 'extensions', entry.name);
		const manifest = await readFile(resolve(packageRoot, 'package.json'), 'utf8').catch(error => {
			if (error.code === 'ENOENT') return undefined;
			throw error;
		});
		// Independent Browser extensions own their SDK l10n bundles; only product-compiled
		// editor clients contribute messages to the host's language catalogs.
		if (manifest !== undefined && typeof JSON.parse(manifest).browser === 'string') continue;
		const client = await readFile(resolve(packageRoot, 'browser/editor.ts'), 'utf8').catch(error => {
			if (error.code === 'ENOENT') return undefined;
			throw error;
		});
		if (client === undefined) continue;
		for (const directory of ['browser', 'common']) {
			sources.push(...await readSources(resolve(packageRoot, directory)).catch(error => {
				if (error.code === 'ENOENT') return [];
				throw error;
			}));
		}
	}
	const english = extractLocalizationMessages(sources);
	const declarations = await readDomains(resolve(resourceRoot, 'en')).catch(error => {
		if (error.code === 'ENOENT') return {};
		throw error;
	});
	for (const [bundle, messages] of Object.entries(declarations)) {
		for (const key of Object.keys(messages)) {
			throw new Error(`English declaration must live in its owning source module: ${bundle}/${key}`);
		}
	}
	for (const definition of APPROVAL_MODE_DEFINITIONS) {
		addMessage(english, 'ash', definition.label.key, definition.label.english, 'ApprovalModes');
		addMessage(english, 'ash', definition.description.key, definition.description.english, 'ApprovalModes');
	}
	// The clients translate these shared product descriptions; their English
	// originals are owned by protocol metadata and follow its generation lifecycle.
	for (const id of ['permission', 'guardian'] as const) {
		addMessage(english, 'ash', `slash.${id}.description`, PRODUCT_SLASH_COMMANDS[id].description, 'ProductSlashCommands');
	}
	const languages: LanguageMetadata[] = JSON.parse(await readFile(resolve(resourceRoot, 'languages.json'), 'utf8'));
	if (languages.length !== 1 || languages[0]?.locale !== 'en') throw new Error('Core localization must contain only English');
	const preinstalledIds = await readPreinstalledLanguagePackIds();
	const languagePacks: LanguagePackSource[] = [];
	for (const entry of (await readdir(resolve(repository, 'extensions'), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory()) continue;
		const packageRoot = resolve(repository, 'extensions', entry.name);
		const source = await readFile(resolve(packageRoot, 'package.json'), 'utf8').catch(error => {
			if (error.code === 'ENOENT') return undefined;
			throw error;
		});
		if (!source) continue;
		const manifest = JSON.parse(source);
		if (!manifest?.contributes || manifest.contributes.localizations === undefined) continue;
		const language = validateLanguagePackManifest(manifest, entry.name);
		if ([...languages, ...languagePacks.map(extension => extension.language)].some(value => value.locale.toLowerCase() === language.locale.toLowerCase())) {
			throw new Error(`Duplicate language pack: ${language.locale}`);
		}
		languagePacks.push({ id: `${manifest.publisher}.${manifest.name}`, packageRoot, manifest, language });
	}
	const preinstalled = languagePacks.filter(extension => preinstalledIds.has(`${extension.manifest.publisher}/${extension.manifest.name}`));
	if (preinstalled.length !== preinstalledIds.size) { throw new Error('A preinstalled language pack is missing'); }
	const catalogs: LanguagePackCatalog[] = [];
	for (const language of [...languages, ...languagePacks.map(extension => extension.language)]) {
		const extension = languagePacks.find(value => value.language.locale === language.locale);
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
	// Optional catalogs are standalone packages only; hosts import the explicit product defaults.
	const startupCatalogs = catalogs.filter(catalog => catalog.locale === 'en' || preinstalled.some(extension => extension.language.locale === catalog.locale));
	const outputs: { file: string; text: string; }[] = [];
	for (const catalog of startupCatalogs) {
		const serialized = JSON.stringify(catalog, null, '\t');
		if (Buffer.byteLength(serialized) <= 200_000) {
			outputs.push({ file: `localizationCatalog.${catalog.locale}.ts`, text: `${header}\nexport const languagePackCatalog: LanguagePackCatalog = ${serialized};\n` });
			continue;
		}
		// Message data grows independently of catalog metadata. Bound each module in UTF-8 bytes,
		// then let the renderer keep those modules separate instead of merging a whole locale.
		const imports: string[] = [], bundles: string[] = [];
		let part = 0;
		for (const [bundle, messages] of Object.entries(catalog.bundles)) {
			const names: string[] = [];
			let chunk: Record<string, string> = {}, bytes = 0;
			const emit = () => {
				const name = `messages${part}`, file = `localizationMessages.${catalog.locale}.${part++}`;
				outputs.push({ file: `${file}.ts`, text: `// Generated localization messages.\nexport const messages: Record<string, string> = ${JSON.stringify(chunk, null, '\t')};\n` });
				imports.push(`import { messages as ${name} } from './${file}.js';`); names.push(`...${name}`);
				chunk = {}; bytes = 0;
			};
			for (const [key, message] of Object.entries(messages)) {
				const size = Buffer.byteLength(JSON.stringify({ [key]: message })) + 8;
				if (bytes && bytes + size > 160_000) { emit(); }
				chunk[key] = message; bytes += size;
			}
			if (bytes) { emit(); }
			bundles.push(`${JSON.stringify(bundle)}: { ${names.join(', ')} }`);
		}
		const { bundles: _bundles, ...metadata } = catalog;
		outputs.push({ file: `localizationCatalog.${catalog.locale}.ts`, text: `${header}${imports.join('\n')}\nexport const languagePackCatalog: LanguagePackCatalog = { ...${JSON.stringify(metadata)}, bundles: { ${bundles.join(', ')} } };\n` });
	}
	const extensionDescriptors = preinstalled.map(extension => {
		const { version, displayName, description } = extension.manifest;
		return `{ ...${JSON.stringify({ id: `${extension.manifest.publisher}/${extension.manifest.name}`, version, displayName, description })}, catalog: catalog${startupCatalogs.findIndex(catalog => catalog.locale === extension.language.locale)} }`;
	});
	outputs.push({
		file: 'localizationCatalogs.ts',
		text: `${header}${startupCatalogs.map((catalog, index) => `import { languagePackCatalog as catalog${index} } from './localizationCatalog.${catalog.locale}.js';`).join('\n')}\n\nexport const builtinLanguagePackCatalogs: readonly LanguagePackCatalog[] = [catalog0];\nexport const preinstalledLanguagePacks: readonly PreinstalledLanguagePack[] = [${extensionDescriptors.join(', ')}];\nexport const productLanguagePackCatalogs: readonly LanguagePackCatalog[] = [...builtinLanguagePackCatalogs, ...preinstalledLanguagePacks.map(extension => extension.catalog)];\n`,
	});
	// Main has one startup locale. Keep unused catalog modules out of its heap;
	// renderer catalog discovery continues to use the existing complete collection.
	const { bundles: _sourceBundles, ...sourceMetadata } = startupCatalogs.find(catalog => catalog.locale === 'en')!;
	outputs.push({
		file: 'localizationLanguages.ts',
		text: `// Generated language metadata; configuration does not need message catalogs.\nexport const productLanguages = ${JSON.stringify(startupCatalogs.map(({ locale, localizedLanguageName }) => ({ locale, localizedLanguageName })))};\n`,
	});
	outputs.push({
		file: 'localizationCatalogLoader.ts',
		text: `${header}\nexport const fallbackLanguagePackCatalog: LanguagePackCatalog = { ...${JSON.stringify(sourceMetadata)}, bundles: {} };\n\nexport async function loadProductLanguagePackCatalog(locale: unknown): Promise<LanguagePackCatalog> {\n\tswitch (locale) {\n${startupCatalogs.filter(catalog => catalog.locale !== 'en').map(catalog => `\t\tcase ${JSON.stringify(catalog.locale)}: return (await import('./localizationCatalog.${catalog.locale}.js')).languagePackCatalog;`).join('\n')}\n\t\tdefault: return (await import('./localizationCatalog.en.js')).languagePackCatalog;\n\t}\n}\n`,
	});
	for (const extension of languagePacks) {
		const { manifest, language } = extension;
		const packageRoot = `extensions/${extension.id}`;
		const distribution = {
			schemaVersion: 2, packageType: 'localization', source: 'thirdParty', id: `${manifest.publisher}/${manifest.name}`,
			version: manifest.version, displayName: manifest.displayName, description: manifest.description, license: manifest.license,
			uiTargets: readExtensionUiTargets(manifest.ashUiTargets),
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
	for (const file of await readdir(directory).catch(error => {
		if (error.code === 'ENOENT') return [];
		throw error;
	})) {
		if (/^localization(?:Catalog|Messages)\..+\.ts$/u.test(file) && !outputs.some(output => output.file === file)) {
			await rm(resolve(directory, file));
			changed = true;
		}
	}
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
	readonly ashUiTargets?: readonly ('ide' | 'agents')[];
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
	readExtensionUiTargets(manifest.ashUiTargets);
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
