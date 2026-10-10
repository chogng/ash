import { localize } from '../../../../nls.js';
import { validateJsonValue } from '../../../../base/common/jsonValue.js';
import { ConfigurationScope, type IConfigurationNode, type IConfigurationPropertySchema } from '../../../../platform/configuration/common/configurationRegistry.js';
import { URI } from '../../../../base/common/uri.js';
import { posix, win32 } from '../../../../base/common/path.js';
import { validateTokenId, type ColorContribution } from '../../../../platform/theme/common/colorRegistry.js';
import { getTokenClassificationRegistry, type TokenTypeOrModifierContribution } from '../../../../platform/theme/common/tokenClassificationRegistry.js';
import type { SemanticTokenScopeContribution } from '../../themes/common/tokenClassificationExtensionPoint.js';

export interface ExtensionIconContribution { readonly id: string; readonly description: string; readonly defaults: string | { readonly fontPath: string; readonly fontCharacter: string; }; }
export interface ExtensionGrammarContribution {
	readonly language?: string;
	readonly scopeName: string;
	readonly path: string;
	readonly injectTo: readonly string[];
	readonly embeddedLanguages?: Readonly<Record<string, string>>;
	readonly tokenTypes?: Readonly<Record<string, "string" | "other" | "comment" | "regex">>;
	readonly balancedBracketScopes?: readonly string[];
	readonly unbalancedBracketScopes?: readonly string[];
}

export interface ExtensionLanguageContribution {
	readonly id: string;
	readonly aliases: readonly string[];
	readonly extensions: readonly string[];
	readonly filenames: readonly string[];
	readonly filenamePatterns: readonly string[];
	readonly mimetypes: readonly string[];
	readonly firstLine?: string;
	readonly configuration?: string;
}

export interface ExtensionSnippetContribution {
	readonly language: readonly string[];
	readonly path: string;
}

export interface ExtensionThemeContribution {
	readonly id?: string;
	readonly label: string;
	readonly path: string;
	readonly uiTheme?: string;
}

export interface ExtensionDebugAdapterContribution {
	readonly type: string;
	readonly label: string;
	readonly program?: string;
	readonly arguments: readonly string[];
	readonly variables?: Readonly<Record<string, string>>;
}

export interface ExtensionCustomEditorContribution {
	readonly viewType: string;
	readonly displayName: string;
	readonly priority: 'default' | 'option' | 'explicit';
	readonly selector: readonly { readonly filenamePattern: string; readonly mimeType?: string; }[];
}

export interface ExtensionManifest {
	readonly name: string;
	readonly publisher: string;
	readonly version: string;
	readonly displayName: string;
	readonly contributes: {
		readonly configuration: readonly IConfigurationNode[];
		readonly languages: readonly ExtensionLanguageContribution[];
		readonly grammars: readonly ExtensionGrammarContribution[];
		readonly snippets: readonly ExtensionSnippetContribution[];
		readonly themes: readonly ExtensionThemeContribution[];
		readonly iconThemes: readonly ExtensionThemeContribution[];
		readonly productIconThemes: readonly ExtensionThemeContribution[];
		readonly debuggers: readonly ExtensionDebugAdapterContribution[];
		readonly colors: readonly ColorContribution[];
		readonly semanticTokenTypes: readonly TokenTypeOrModifierContribution[];
		readonly semanticTokenModifiers: readonly TokenTypeOrModifierContribution[];
		readonly semanticTokenScopes: readonly SemanticTokenScopeContribution[];
		readonly icons: readonly ExtensionIconContribution[];
		readonly customEditors: readonly ExtensionCustomEditorContribution[];
		readonly problemMatchers: readonly Readonly<Record<string, unknown>>[];
		readonly problemPatterns: readonly Readonly<Record<string, unknown>>[];
	};
}

export interface ExtensionManifestDescriptor {
	readonly id: string;
	readonly name: string;
	readonly publisher: string;
	readonly version: string;
	readonly displayName?: string;
	readonly extensionLocation?: string;
	readonly targetPlatform?: string;
}

export async function verifyExtensionManifestDigest(extension: { readonly id: string; readonly manifestJson: string; readonly manifestSha256: string; }): Promise<void> {
	const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(extension.manifestJson));
	const actual = `sha256:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
	if (actual !== extension.manifestSha256) throw new Error(`Extension '${extension.id}' manifest digest does not match its catalog descriptor`);
}

/** Parses and validates the declarative contribution subset owned by Workbench. */
export function parseExtensionManifest(manifestJson: string, descriptor: ExtensionManifestDescriptor): ExtensionManifest {
	let value: unknown;
	try {
		value = JSON.parse(manifestJson);
	} catch {
		throw new TypeError(`Extension '${descriptor.id}' manifest is not valid JSON`);
	}
	const manifest = record(value, `Extension '${descriptor.id}' manifest`);
	const name = requiredString(manifest.name, "name", 256);
	const publisher = requiredString(manifest.publisher, "publisher", 256);
	const version = requiredString(manifest.version, "version", 256);
	if (name !== descriptor.name || publisher !== descriptor.publisher || version !== descriptor.version) {
		throw new TypeError(`Extension '${descriptor.id}' manifest identity does not match its catalog entry`);
	}
	const displayName = typeof manifest.displayName === "string" && manifest.displayName.trim().length > 0
		? boundedText(manifest.displayName, "displayName", 256)
		: descriptor.displayName ?? name;
	const contributes = manifest.contributes === undefined ? {} : record(manifest.contributes, "Extension contributes");
	let themes: readonly ExtensionThemeContribution[] = [];
	if (manifest.themes !== undefined) { themes = parsePortableThemes(manifest); }
	else if (contributes.themes !== undefined) { themes = parseThemes(contributes.themes, descriptor.id); }
	return Object.freeze({
		name,
		publisher,
		version,
		displayName,
		contributes: Object.freeze({
			configuration: parseConfigurations(contributes.configuration),
			languages: Object.freeze(contributes.languages === undefined ? [] : parseLanguages(contributes.languages, descriptor.id)),
			grammars: Object.freeze(contributes.grammars === undefined ? [] : parseGrammars(contributes.grammars, descriptor.id)),
			snippets: Object.freeze(contributes.snippets === undefined ? [] : parseSnippets(contributes.snippets, descriptor.id)),
			themes: Object.freeze(themes),
			iconThemes: Object.freeze(contributes.iconThemes === undefined ? [] : parseThemes(contributes.iconThemes, descriptor.id)),
			productIconThemes: Object.freeze(contributes.productIconThemes === undefined ? [] : parseThemes(contributes.productIconThemes, descriptor.id)),
			colors: parseColors(contributes.colors, descriptor.id),
			semanticTokenTypes: parseClassifications(contributes.semanticTokenTypes, true),
			semanticTokenModifiers: parseClassifications(contributes.semanticTokenModifiers, false),
			semanticTokenScopes: parseSemanticScopes(contributes.semanticTokenScopes),
			icons: parseIcons(contributes.icons),
			customEditors: parseCustomEditors(contributes.customEditors, descriptor.id),
			problemMatchers: parseProblemContributions(contributes.problemMatchers, 'problemMatchers'),
			problemPatterns: parseProblemContributions(contributes.problemPatterns, 'problemPatterns'),
			debuggers: Object.freeze(contributes.debuggers === undefined ? [] : parseDebuggers(contributes.debuggers, descriptor)),
		}),
	});
}

function parseConfigurations(value: unknown): readonly IConfigurationNode[] {
	if (value === undefined) return Object.freeze([]);
	const scopes: Readonly<Record<string, ConfigurationScope>> = { application: ConfigurationScope.APPLICATION, machine: ConfigurationScope.MACHINE, window: ConfigurationScope.WINDOW, resource: ConfigurationScope.RESOURCE, 'language-overridable': ConfigurationScope.LANGUAGE_OVERRIDABLE, 'machine-overridable': ConfigurationScope.MACHINE_OVERRIDABLE };
	const parseNode = (value: unknown): IConfigurationNode => {
		const node = record(validateJsonValue(value), 'contributes.configuration');
		const properties: Record<string, IConfigurationPropertySchema> = Object.create(null);
		for (const [key, value] of Object.entries(node.properties === undefined ? {} : record(node.properties, 'contributes.configuration.properties'))) {
			const schema = record(value, `contributes.configuration.properties.${key}`);
			const scope = schema.scope === undefined ? ConfigurationScope.WINDOW : typeof schema.scope === 'string' ? scopes[schema.scope] : undefined;
			if (scope === undefined) throw new TypeError(localize('configuration.contributedValue', "Setting '{0}' does not match its declared schema.", key));
			properties[key] = Object.freeze({ ...schema, scope }) as IConfigurationPropertySchema;
		}
		if (node.allOf !== undefined && !Array.isArray(node.allOf)) throw new TypeError(localize('configuration.contributedValue', "Setting '{0}' does not match its declared schema.", 'allOf'));
		return Object.freeze({ ...(typeof node.id === 'string' ? { id: node.id } : {}), ...(typeof node.title === 'string' ? { title: node.title } : {}), properties: Object.freeze(properties), ...(Array.isArray(node.allOf) ? { allOf: Object.freeze(node.allOf.map(parseNode)) } : {}) });
	};
	const nodes = Array.isArray(value) ? value : [value];
	if (nodes.length > 64) throw new RangeError(localize('configuration.contributionLimit', 'An extension may contribute at most {0} configuration sections.', 64));
	return Object.freeze(nodes.map(parseNode));
}

function parseProblemContributions(value: unknown, field: string): readonly Readonly<Record<string, unknown>>[] {
	if (value === undefined) return Object.freeze([]);
	if (!Array.isArray(value) || value.length > 256) throw new TypeError(localize('extensions.problemContributionArray', '{0} must be an array of at most 256 entries', field));
	return Object.freeze(value.map(item => {
		const contribution = record(item, field);
		if (typeof contribution.name !== 'string' || !contribution.name.trim() || contribution.name.length > 128 || contribution.name.startsWith('$') || /[\x00-\x1f\x7f]/.test(contribution.name)) throw new TypeError(localize('extensions.problemContributionName', 'Invalid {0} name', field));
		return Object.freeze(contribution);
	}));
}

function parseCustomEditors(value: unknown, extensionId: string): readonly ExtensionCustomEditorContribution[] {
	if (value === undefined) {
		return Object.freeze([]);
	}
	if (!Array.isArray(value) || value.length > 64) {
		throw new TypeError(`Extension '${extensionId}' custom editors must be an array of at most 64 entries`);
	}
	const editors = value.map(candidate => {
		const editor = record(candidate, 'Custom editor');
		const priorities = typeof editor.priority === 'object' && editor.priority !== null ? record(editor.priority, 'Custom editor priorities') : undefined;
		const priority = priorities ? priorities.textEditor : editor.priority ?? 'default';
		if (priority !== 'default' && priority !== 'option' && priority !== 'explicit') {
			throw new TypeError('Invalid custom editor priority');
		}
		if (!Array.isArray(editor.selector) || editor.selector.length === 0 || editor.selector.length > 64) {
			throw new TypeError('Custom editor selectors must be a non-empty array of at most 64 entries');
		}
		const selector = editor.selector.map(candidate => {
			const selector = record(candidate, 'Custom editor selector');
			const mimeType = selector.mimeType === undefined ? undefined : requiredString(selector.mimeType, 'Custom editor MIME type', 256);
			if (mimeType !== undefined && !/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)) {
				throw new TypeError('Invalid custom editor MIME type');
			}
			return Object.freeze({
				filenamePattern: requiredString(selector.filenamePattern, 'Custom editor filename pattern', 1024),
				...(mimeType === undefined ? {} : { mimeType: mimeType.toLowerCase() }),
			});
		});
		return Object.freeze({ viewType: requiredString(editor.viewType, 'Custom editor view type', 256), displayName: requiredString(editor.displayName, 'Custom editor display name', 256), priority, selector: Object.freeze(selector) });
	});
	if (new Set(editors.map(editor => editor.viewType)).size !== editors.length) {
		throw new TypeError(`Extension '${extensionId}' custom editor IDs must be unique`);
	}
	return Object.freeze(editors);
}

function parseLanguages(value: unknown, extensionId: string): readonly ExtensionLanguageContribution[] {
	if (!Array.isArray(value)) throw new TypeError(`Extension '${extensionId}' language contributions must be an array`);
	return value.map((candidate, index) => {
		const language = record(candidate, `Extension '${extensionId}' language ${index}`);
		const id = languageId(language.id, `Extension '${extensionId}' language ${index} id`);
		return Object.freeze({
			id,
			aliases: parseTextList(language.aliases, `Extension '${extensionId}' language ${index} aliases`),
			extensions: parseExtensions(language.extensions, extensionId, index),
			filenames: parseTextList(language.filenames, `Extension '${extensionId}' language ${index} filenames`, true),
			filenamePatterns: parseTextList(language.filenamePatterns, `Extension '${extensionId}' language ${index} filename patterns`, true),
			mimetypes: parseTextList(language.mimetypes, `Extension '${extensionId}' language ${index} MIME types`, true),
			...(language.firstLine === undefined ? {} : { firstLine: boundedText(language.firstLine, `Extension '${extensionId}' language ${index} first-line pattern`, 1024) }),
			...(language.configuration === undefined ? {} : { configuration: normalizeResourcePath(language.configuration, `Extension '${extensionId}' language ${index} configuration`) }),
		});
	});
}

function parseExtensions(value: unknown, extensionId: string, index: number): readonly string[] {
	const extensions = parseTextList(value, `Extension '${extensionId}' language ${index} extensions`, true, false);
	if (extensions.some(extension => !extension.startsWith("."))) {
		throw new TypeError(`Extension '${extensionId}' language ${index} extensions must start with a dot`);
	}
	return Object.freeze([...new Set(extensions)]);
}

function parseGrammars(value: unknown, extensionId: string): readonly ExtensionGrammarContribution[] {
	if (!Array.isArray(value)) throw new TypeError(`Extension '${extensionId}' grammar contributions must be an array`);
	return value.map((candidate, index) => {
		const grammar = record(candidate, `Extension '${extensionId}' grammar ${index}`);
		const scopeName = scopeNameValue(grammar.scopeName, `Extension '${extensionId}' grammar ${index} scopeName`);
		const language = grammar.language === undefined ? undefined : languageId(grammar.language, `Extension '${extensionId}' grammar ${index} language`);
		const injectTo = grammar.injectTo === undefined ? Object.freeze([]) : parseScopes(grammar.injectTo, `Extension '${extensionId}' grammar ${index} injectTo`);
		const embeddedLanguages = grammar.embeddedLanguages === undefined ? undefined : parseScopeMap(grammar.embeddedLanguages, extensionId, index, "embeddedLanguages", languageId);
		const tokenTypes = grammar.tokenTypes === undefined ? undefined : parseScopeMap(grammar.tokenTypes, extensionId, index, "tokenTypes", tokenTypeValue, selectorValue);
		const balancedBracketScopes = grammar.balancedBracketScopes === undefined ? undefined : parseBracketScopes(grammar.balancedBracketScopes, `Extension '${extensionId}' grammar ${index} balancedBracketScopes`);
		const unbalancedBracketScopes = grammar.unbalancedBracketScopes === undefined ? undefined : parseBracketScopes(grammar.unbalancedBracketScopes, `Extension '${extensionId}' grammar ${index} unbalancedBracketScopes`);
		return Object.freeze({
			...(language === undefined ? {} : { language }),
			scopeName,
			path: normalizeResourcePath(grammar.path, `Extension '${extensionId}' grammar ${index} path`),
			injectTo,
			...(embeddedLanguages === undefined ? {} : { embeddedLanguages }),
			...(tokenTypes === undefined ? {} : { tokenTypes }),
			...(balancedBracketScopes === undefined ? {} : { balancedBracketScopes }),
			...(unbalancedBracketScopes === undefined ? {} : { unbalancedBracketScopes }),
		});
	});
}

function parseSnippets(value: unknown, extensionId: string): readonly ExtensionSnippetContribution[] {
	if (!Array.isArray(value)) throw new TypeError(`Extension '${extensionId}' snippet contributions must be an array`);
	return value.map((candidate, index) => {
		const snippet = record(candidate, `Extension '${extensionId}' snippet ${index}`);
		const language = snippet.language === undefined ? snippet.languageIds : snippet.language;
		const languages = typeof language === "string" ? [language] : parseTextList(language, `Extension '${extensionId}' snippet ${index} language`, false);
		if (languages.length === 0) throw new TypeError(`Extension '${extensionId}' snippet ${index} must declare a language`);
		return Object.freeze({
			language: Object.freeze(languages.map((value, languageIndex) => languageId(value, `Extension '${extensionId}' snippet ${index} language ${languageIndex}`))),
			path: normalizeResourcePath(snippet.path, `Extension '${extensionId}' snippet ${index} path`),
		});
	});
}

/** Portable Marketplace themes share the same renderer-owned theme registration path. */
function parsePortableThemes(manifest: Record<string, unknown>): readonly ExtensionThemeContribution[] {
	const invalid = (): TypeError => new TypeError(localize('extensions.themes.invalidPortableManifest', 'The Marketplace theme manifest is invalid.'));
	if (manifest.schemaVersion !== 1 || manifest.contributes !== undefined || !Array.isArray(manifest.themes) || !manifest.themes.length || manifest.themes.length > 128 || Object.keys(manifest).some(key => !['schemaVersion', 'themes', 'name', 'publisher', 'version', 'displayName'].includes(key))) { throw invalid(); }
	const ids = new Set<string>();
	const paths = new Set<string>();
	return manifest.themes.map((candidate, index) => {
		const theme = record(candidate, `Marketplace theme ${index}`);
		const id = requiredString(theme.id, 'Theme ID', 256);
		const label = requiredString(theme.displayName, 'Theme display name', 256);
		const path = normalizeResourcePath(theme.path, 'Theme path');
		if (!path.startsWith('themes/') || ids.has(id) || paths.has(path) || (theme.appearance !== 'dark' && theme.appearance !== 'light') || Object.keys(theme).some(key => !['id', 'displayName', 'appearance', 'path'].includes(key))) { throw invalid(); }
		ids.add(id);
		paths.add(path);
		return Object.freeze({ id, label, path, uiTheme: theme.appearance === 'dark' ? 'vs-dark' : 'vs' });
	});
}

function parseThemes(value: unknown, extensionId: string): readonly ExtensionThemeContribution[] {
	if (!Array.isArray(value)) throw new TypeError(`Extension '${extensionId}' theme contributions must be an array`);
	return value.map((candidate, index) => {
		const theme = record(candidate, `Extension '${extensionId}' theme ${index}`);
		const uiTheme = theme.uiTheme === undefined ? undefined : extensionUiTheme(theme.uiTheme, `Extension '${extensionId}' theme ${index} uiTheme`);
		return Object.freeze({
			...(theme.id === undefined ? {} : { id: boundedText(theme.id, `Extension '${extensionId}' theme ${index} id`, 256) }),
			label: requiredString(theme.label, `Extension '${extensionId}' theme ${index} label`, 256),
			path: normalizeResourcePath(theme.path, `Extension '${extensionId}' theme ${index} path`),
			...(uiTheme === undefined ? {} : { uiTheme }),
		});
	});
}

function extensionUiTheme(value: unknown, owner: string): string {
	const uiTheme = boundedText(value, owner, 32);
	if (uiTheme !== "vs" && uiTheme !== "vs-dark" && uiTheme !== "hc-black" && uiTheme !== "hc-light") throw new TypeError(`${owner} is invalid`);
	return uiTheme;
}

function parseDebuggers(value: unknown, descriptor: ExtensionManifestDescriptor): readonly ExtensionDebugAdapterContribution[] {
	const extensionId = descriptor.id;
	if (!Array.isArray(value)) throw new TypeError(`Extension '${extensionId}' debugger contributions must be an array`);
	if (value.length > 64) throw new RangeError(`Extension '${extensionId}' cannot contribute more than 64 debuggers`);
	const debuggers = value.map((candidate, index) => {
		const debuggerContribution = record(candidate, `Extension '${extensionId}' debugger ${index}`);
		const adapter = debuggerContribution.debugAdapter === undefined ? undefined : record(debuggerContribution.debugAdapter, `Extension '${extensionId}' debugger ${index} debugAdapter`);
		const type = languageId(debuggerContribution.type, `Extension '${extensionId}' debugger ${index} type`);
		const label = debuggerContribution.label === undefined ? type : requiredString(debuggerContribution.label, `Extension '${extensionId}' debugger ${index} label`, 256);
		const variables = debuggerContribution.variables === undefined ? undefined : parseDebuggerVariables(debuggerContribution.variables, type);
		if (adapter) {
			const argumentsList = adapter.args === undefined ? [] : parseDebuggerArguments(adapter.args, extensionId, index);
			return Object.freeze({ type, label, program: requiredString(adapter.program, `Extension '${extensionId}' debugger ${index} debugAdapter program`, 4096), arguments: Object.freeze(argumentsList), ...(variables === undefined ? {} : { variables }) });
		}
		const platform = descriptor.targetPlatform?.split('-')[0];
		const overrides: Record<string, unknown> = {};
		for (const key of ['win', 'windows', 'winx86', 'osx', 'linux']) {
			if (debuggerContribution[key] === undefined) continue;
			const values = record(debuggerContribution[key], `Debugger ${key}`);
			if (Object.keys(values).length && platform === undefined) throw new Error(localize('extensions.debugAdapterPlatformUnavailable', "The execution platform for debug adapter '{0}' is unavailable.", type));
			const selected = platform === 'darwin' && key === 'osx' || platform === 'linux' && key === 'linux'
				|| platform === 'win32' && (key === 'win' || key === 'windows' || key === 'winx86' && descriptor.targetPlatform === 'win32-ia32');
			if (selected) Object.assign(overrides, values);
		}
		const executable = { ...debuggerContribution, ...overrides };
		const program = executable.program === undefined ? undefined : requiredString(executable.program, 'Debugger program', 4096);
		const runtime = executable.runtime === undefined ? undefined : requiredString(executable.runtime, 'Debugger runtime', 4096);
		const args = executable.args === undefined ? [] : parseDebuggerArguments(executable.args, extensionId, index);
		const runtimeArgs = executable.runtimeArgs === undefined ? [] : parseDebuggerArguments(executable.runtimeArgs, extensionId, index);
		const resolvedProgram = program === undefined ? undefined : debuggerPath(program, descriptor, type, false);
		return Object.freeze({
			type, label,
			...(variables === undefined ? {} : { variables }),
			program: runtime === undefined ? resolvedProgram : debuggerPath(runtime, descriptor, type, true),
			arguments: Object.freeze(runtime === undefined ? args : [...runtimeArgs, ...(resolvedProgram === undefined ? [] : [resolvedProgram]), ...args]),
		});
	});
	if (new Set(debuggers.map(debuggerContribution => debuggerContribution.type)).size !== debuggers.length) throw new RangeError(`Extension '${extensionId}' debugger types must be unique`);
	return Object.freeze(debuggers);
}

function parseDebuggerVariables(value: unknown, type: string): Readonly<Record<string, string>> {
	const invalid = () => new TypeError(localize('extensions.invalidDebuggerVariables', "The command variable mapping for debug adapter '{0}' is invalid.", type));
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
	const entries = Object.entries(value);
	if (entries.length > 64 || entries.some(([name, command]) => !name.trim() || name.length > 256 || /[\0\r\n{}]/.test(name)
		|| typeof command !== 'string' || !command.trim() || command.length > 256 || /[\0\r\n]/.test(command))) throw invalid();
	return Object.freeze(Object.fromEntries(entries));
}

function debuggerPath(value: string, descriptor: ExtensionManifestDescriptor, type: string, runtime: boolean): string {
	// A runtime command may come from PATH. A program names an installed package
	// file, even when its relative path has no separator.
	if (runtime && !/[\\/]/.test(value)) return value;
	const location = descriptor.extensionLocation === undefined ? undefined : URI.parse(descriptor.extensionLocation);
	const windows = descriptor.targetPlatform?.startsWith('win32-') || location?.authority || /^\/[a-z]:\//i.test(location?.path ?? '');
	const paths = windows ? win32 : posix;
	if (paths.isAbsolute(value)) return paths.normalize(value);
	if (!location || location.scheme !== 'file' || !location.path.startsWith('/') || location.query || location.fragment) {
		throw new Error(localize('extensions.debugAdapterLocationUnavailable', "The installed location for debug adapter '{0}' is unavailable.", type));
	}
	let directory = location.path;
	if (windows) {
		directory = location.authority ? `\\\\${location.authority}${location.path.replaceAll('/', '\\')}` : location.path.replace(/^\/(?=[a-z]:)/i, '').replaceAll('/', '\\');
	}
	return paths.normalize(directory + paths.sep + value);
}

function parseDebuggerArguments(value: unknown, extensionId: string, index: number): readonly string[] {
	if (!Array.isArray(value)) throw new TypeError(`Extension '${extensionId}' debugger ${index} debugAdapter args must be an array`);
	if (value.length > 128) throw new RangeError(`Extension '${extensionId}' debugger ${index} debugAdapter args cannot contain more than 128 values`);
	return value.map((argument, argumentIndex) => {
		if (typeof argument !== 'string' || argument.length > 4096 || argument.includes('\0')) {
			throw new TypeError(`Extension '${extensionId}' debugger ${index} debugAdapter arg ${argumentIndex} is invalid`);
		}
		return argument;
	});
}

function parseScopeMap<T>(value: unknown, extensionId: string, index: number, field: string, parseValue: (value: unknown, owner: string, maximum?: number) => T, parseKey: (value: string, owner: string) => string = scopeNameValue): Readonly<Record<string, T>> {
	const object = record(value, `Extension '${extensionId}' grammar ${index} ${field}`);
	const entries = Object.entries(object).map(([scope, mapped]) => [
		parseKey(scope, `Extension '${extensionId}' grammar ${index} ${field} scope`),
		parseValue(mapped, `Extension '${extensionId}' grammar ${index} ${field} value`, 128),
	] as const);
	return Object.freeze(Object.fromEntries(entries));
}

function tokenTypeValue(value: unknown, owner: string): "string" | "other" | "comment" | "regex" {
	const tokenType = boundedText(value, owner, 32);
	if (tokenType !== "string" && tokenType !== "other" && tokenType !== "comment" && tokenType !== "regex") {
		throw new TypeError(`${owner} is invalid`);
	}
	return tokenType;
}

function selectorValue(value: string, owner: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\r\n]/u.test(value) || value.trim() !== value) {
		throw new TypeError(`${owner} is invalid`);
	}
	return value;
}

function parseScopes(value: unknown, owner: string): readonly string[] {
	const scopes = parseTextList(value, owner);
	const normalized = scopes.map(scope => scopeNameValue(scope, owner));
	if (new Set(normalized).size !== normalized.length) throw new RangeError(`${owner} must be unique`);
	return Object.freeze(normalized);
}

function parseBracketScopes(value: unknown, owner: string): readonly string[] {
	const scopes = parseTextList(value, owner);
	const normalized = scopes.map(scope => {
		if (scope === "*") return scope;
		if (!/^[A-Za-z0-9][A-Za-z0-9._+*-]*$/u.test(scope)) throw new TypeError(`${owner} contains an invalid scope selector`);
		return scope;
	});
	if (new Set(normalized).size !== normalized.length) throw new RangeError(`${owner} must be unique`);
	return Object.freeze(normalized);
}

function parseTextList(value: unknown, owner: string, caseInsensitive = false, requireUnique = true): readonly string[] {
	if (value === undefined) return Object.freeze([]);
	if (!Array.isArray(value)) throw new TypeError(`${owner} must be an array`);
	const values = value.map(candidate => {
		const text = boundedText(candidate, owner, 256);
		return caseInsensitive ? text.toLowerCase() : text;
	});
	if (requireUnique && new Set(values).size !== values.length) throw new RangeError(`${owner} must be unique`);
	return Object.freeze(values);
}

function languageId(value: unknown, owner: string): string {
	const id = boundedText(value, owner, 128);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)) throw new TypeError(`${owner} is invalid`);
	return id;
}

function scopeNameValue(value: unknown, owner: string): string {
	const scope = boundedText(value, owner, 256);
	if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(scope)) throw new TypeError(`${owner} is invalid`);
	return scope;
}

function normalizeResourcePath(value: unknown, owner: string): string {
	let path = boundedText(value, owner, 1024);
	while (path.startsWith("./")) path = path.slice(2);
	if (path.length === 0 || path.includes("\\") || path.startsWith("/") || path.includes(":") || path.split("/").some(segment => segment.length === 0 || segment === "." || segment === "..")) {
		throw new TypeError(`${owner} must be a safe relative path`);
	}
	return path;
}

function record(value: unknown, owner: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${owner} must be an object`);
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, owner: string, maximum: number): string {
	return boundedText(value, owner, maximum);
}

function boundedText(value: unknown, owner: string, maximum = 256): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || /[\0\r\n]/u.test(value)) throw new TypeError(`${owner} is invalid`);
	return value;
}

function parseColors(value: unknown, extensionId: string): readonly ColorContribution[] {
	if (value === undefined) { return []; }
	if (!Array.isArray(value) || value.length > 512) { throw new TypeError('Extension colors must be an array of up to 512 contributions'); }
	return value.map(candidate => {
		const color = record(candidate, 'Extension color');
		const id = requiredString(color.id, 'Color ID', 256);
		validateTokenId(id, 'color');
		const defaults = record(color.defaults, 'Color defaults');
		const parse = (value: unknown): string => {
			const text = requiredString(value, 'Color default', 256);
			if (text.startsWith('#')) {
				if (!/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/iu.test(text)) { throw new TypeError('Invalid color default'); }
			} else { validateTokenId(text, 'color'); }
			return text;
		};
		return {
			id, description: requiredString(color.description, 'Color description', 1024), owner: extensionId, defaults: {
				light: parse(defaults.light), dark: parse(defaults.dark),
				hcDark: parse(defaults.highContrast ?? defaults.dark), hcLight: parse(defaults.highContrastLight ?? defaults.light),
			}
		};
	});
}

function parseClassifications(value: unknown, allowSuperType: boolean): readonly TokenTypeOrModifierContribution[] {
	if (value === undefined) { return []; }
	if (!Array.isArray(value) || value.length > 512) { throw new TypeError('Semantic classifications must be an array of up to 512 contributions'); }
	return value.map(candidate => {
		const source = record(candidate, 'Semantic classification');
		const id = requiredString(source.id, 'Semantic classification ID', 128);
		if (!/^[A-Za-z][\w]*$/u.test(id)) { throw new TypeError('Invalid semantic classification ID'); }
		const superType = allowSuperType && source.superType !== undefined ? requiredString(source.superType, 'Semantic super type', 128) : undefined;
		if (superType && !/^[A-Za-z][\w]*$/u.test(superType)) { throw new TypeError('Invalid semantic super type'); }
		return { id, description: requiredString(source.description, 'Semantic classification description', 1024), ...(superType ? { superType } : {}) };
	});
}

function parseSemanticScopes(value: unknown): readonly SemanticTokenScopeContribution[] {
	if (value === undefined) { return []; }
	if (!Array.isArray(value) || value.length > 512) { throw new TypeError('Semantic token scopes must be an array of up to 512 contributions'); }
	return value.map(candidate => {
		const source = record(candidate, 'Semantic token scopes');
		const language = source.language === undefined ? undefined : languageId(source.language, 'Semantic token language');
		const scopes = Object.fromEntries(Object.entries(record(source.scopes, 'Semantic token scopes')).map(([selector, mapping]) => {
			getTokenClassificationRegistry().parseTokenSelector(selector, language);
			const values = parseTextList(mapping, 'Semantic token scope mappings');
			if (values.some(value => !/^[A-Za-z0-9_.+*-]+(?: [A-Za-z0-9_.+*-]+)*$/u.test(value))) { throw new TypeError('Invalid semantic token scope mapping'); }
			return [selector, values];
		}));
		return { ...(language ? { language } : {}), scopes };
	});
}

function parseIcons(value: unknown): readonly ExtensionIconContribution[] {
	if (value === undefined) { return []; }
	const icons = Object.entries(record(value, 'Extension icons'));
	if (icons.length > 512) { throw new RangeError('Extension has too many icons'); }
	return icons.map(([id, candidate]) => {
		if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/u.test(id)) { throw new TypeError('Invalid contributed icon ID'); }
		const icon = record(candidate, 'Extension icon');
		const description = requiredString(icon.description, 'Icon description', 1024);
		if (typeof icon.default === 'string') {
			if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u.test(icon.default)) { throw new TypeError('Invalid icon reference'); }
			return { id, description, defaults: icon.default };
		}
		const defaults = record(icon.default, 'Icon default');
		const fontPath = normalizeResourcePath(defaults.fontPath, 'Icon font path');
		if (!/\.(?:woff2?|ttf|otf)$/iu.test(fontPath)) { throw new TypeError('Unsupported icon font'); }
		const fontCharacter = requiredString(defaults.fontCharacter, 'Icon font character', 16);
		if (!/^(?:\\[\da-f]{1,6}|[^\\])$/iu.test(fontCharacter)) { throw new TypeError('Invalid icon font character'); }
		return { id, description, defaults: { fontPath, fontCharacter } };
	});
}
