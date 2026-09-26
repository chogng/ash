import { Color } from '../../../../base/common/color.js';
import * as textMateNamespace from 'vscode-textmate';
import { parseJsonDocument } from '../../../../base/common/json.js';
import { parseJsonc } from '../../../../base/common/jsonc.js';
import { validateJsonSchema } from '../../../../base/common/jsonSchema.js';
import { createColorTheme } from '../../../../platform/theme/common/colorTheme.js';
import type { IColorTheme, ISemanticTokenThemeRule } from '../../../../platform/theme/common/themeService.js';
import { ColorScheme } from '../../../../platform/theme/common/theme.js';
import { colorThemeSchema, colorThemeSchemaId } from './colorThemeSchema.js';

const textMateRuntime = (textMateNamespace as unknown as { readonly default?: typeof textMateNamespace }).default ?? textMateNamespace;

export interface ColorThemeDocument {
	readonly $schema?: string;
	readonly include?: string;
	readonly name?: string;
	readonly type?: 'dark' | 'light' | 'hcDark' | 'hcLight';
	readonly colors?: Readonly<Record<string, string>>;
	readonly tokenColors?: string | readonly {
		readonly name?: string;
		readonly scope?: string | readonly string[];
		readonly settings: { readonly foreground?: string; readonly background?: string; readonly fontStyle?: string };
	}[];
	readonly semanticHighlighting?: boolean;
	readonly semanticTokenColors?: Readonly<Record<string, string | {
		readonly foreground?: string;
		readonly fontStyle?: string;
		readonly bold?: boolean;
		readonly italic?: boolean;
		readonly underline?: boolean;
		readonly strikethrough?: boolean;
	}>>;
}

export function parseColorThemeDocument(value: unknown): ColorThemeDocument {
	const source = JSON.stringify(value);
	if (!source || source.length > 1_048_576) throw new Error('Theme exceeds the 1 MiB document limit');
	const issues = validateJsonSchema(parseJsonDocument(source), colorThemeSchema);
	if (issues.length) throw new Error(`Invalid color theme: ${issues.map(issue => issue.message).join('; ')}`);
	return value as ColorThemeDocument;
}

/** Resolves package-relative includes before a document becomes a selectable theme. */
export function resolveColorThemeDocument(path: string, read: (path: string) => unknown): ColorThemeDocument {
	const visit = (resource: string, ancestors: readonly string[]): ColorThemeDocument => {
		if (ancestors.includes(resource)) throw new Error(`Color theme include cycle: ${[...ancestors, resource].join(' -> ')}`);
		if (ancestors.length >= 16) throw new Error('Color theme include depth exceeds 16');
		const document = readThemeDocument(resource, read(resource));
		const inherited = document.include ? visit(resolveColorThemeInclude(resource, document.include), [...ancestors, resource]) : undefined;
		const syntaxResource = typeof document.tokenColors === 'string' ? resolveColorThemeInclude(resource, document.tokenColors) : undefined;
		const tokenColors = syntaxResource ? readSyntaxTokenRules(syntaxResource, read(syntaxResource)) : document.tokenColors;
		return mergeColorThemeDocuments(inherited, { ...document, tokenColors });
	};
	return visit(resolveColorThemeInclude('', path), []);
}

/** Loads the same document format through a resource owner that performs asynchronous reads. */
export async function loadColorThemeDocument(path: string, read: (path: string) => Promise<unknown>): Promise<ColorThemeDocument> {
	const visit = async (resource: string, ancestors: readonly string[]): Promise<ColorThemeDocument> => {
		if (ancestors.includes(resource)) throw new Error(`Color theme include cycle: ${[...ancestors, resource].join(' -> ')}`);
		if (ancestors.length >= 16) throw new Error('Color theme include depth exceeds 16');
		const document = readThemeDocument(resource, await read(resource));
		const inherited = document.include ? await visit(resolveColorThemeInclude(resource, document.include), [...ancestors, resource]) : undefined;
		const syntaxResource = typeof document.tokenColors === 'string' ? resolveColorThemeInclude(resource, document.tokenColors) : undefined;
		const tokenColors = syntaxResource ? readSyntaxTokenRules(syntaxResource, await read(syntaxResource)) : document.tokenColors;
		return mergeColorThemeDocuments(inherited, { ...document, tokenColors });
	};
	return visit(resolveColorThemeInclude('', path), []);
}

function mergeColorThemeDocuments(inherited: ColorThemeDocument | undefined, document: ColorThemeDocument): ColorThemeDocument {
	const { include: _include, ...own } = document;
	if (!inherited) return own;
	return {
		...inherited,
		...own,
		colors: { ...inherited.colors, ...own.colors },
		tokenColors: [...asTokenColorRules(inherited.tokenColors), ...asTokenColorRules(own.tokenColors)],
		semanticTokenColors: { ...inherited.semanticTokenColors, ...own.semanticTokenColors },
		semanticHighlighting: inherited.semanticHighlighting === true || own.semanticHighlighting === true
			? true : own.semanticHighlighting ?? inherited.semanticHighlighting,
	};
}

function resolveColorThemeInclude(from: string, include: string): string {
	if (!/\.(?:json|tmTheme)$/iu.test(include) || include.startsWith('/') || include.includes('\\') || include.includes(':') || include.includes('?') || include.includes('#')) {
		throw new TypeError(`Invalid color theme include: ${include}`);
	}
	const segments = from ? from.split('/').slice(0, -1) : [];
	for (const segment of include.split('/')) {
		if (segment === '.') continue;
		if (segment === '..') {
			if (segments.length === 0) throw new TypeError(`Color theme include escapes its package: ${include}`);
			segments.pop();
		} else if (!segment || segment.includes('\0')) {
			throw new TypeError(`Invalid color theme include: ${include}`);
		} else {
			segments.push(segment);
		}
	}
	return segments.join('/');
}

function readThemeDocument(resource: string, value: unknown): ColorThemeDocument {
	return /\.tmTheme$/iu.test(resource) ? { tokenColors: readSyntaxTokenRules(resource, value) } : parseColorThemeDocument(value);
}

function readSyntaxTokenRules(resource: string, value: unknown): Exclude<ColorThemeDocument['tokenColors'], string | undefined> {
	const content = typeof value === 'string' ? textMateRuntime.parseRawGrammar(value, resource) : value;
	if (typeof content !== 'object' || content === null || !('settings' in content)) throw new Error(`Invalid TextMate theme: ${resource}`);
	const document = parseColorThemeDocument({ tokenColors: content.settings });
	return asTokenColorRules(document.tokenColors);
}

function asTokenColorRules(value: ColorThemeDocument['tokenColors']): Exclude<ColorThemeDocument['tokenColors'], string | undefined> {
	if (typeof value === 'string') throw new Error('Theme token colors must be resolved before compilation');
	return value ?? [];
}

/** Compiles file contents; resource identity is supplied by the caller, never by the document. */
export function parseUserColorTheme(source: string, id?: string): IColorTheme {
	if (source.length > 1_048_576) throw new Error('Theme exceeds the 1 MiB document limit');
	const document = parseColorThemeDocument(parseJsonc(source, 'Color theme'));
	if (document.include) throw new Error('Standalone user theme requires a resource loader to resolve include');
	const label = document.name ?? id ?? 'Untitled Theme';
	return createDocumentColorTheme(document, id ?? userThemeId(label), label, colorThemeType(document.type));
}

export async function loadUserColorTheme(path: string, read: (path: string) => Promise<string>, id?: string): Promise<IColorTheme> {
	const document = await loadColorThemeDocument(path, async resource => {
		const source = await read(resource);
		return /\.tmTheme$/iu.test(resource) ? source : parseJsonc(source, `Color theme '${resource}'`);
	});
	const label = document.name ?? id ?? 'Untitled Theme';
	return createDocumentColorTheme(document, id ?? userThemeId(label), label, colorThemeType(document.type));
}

export function userThemeId(name: string): string {
	const slug = name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
	return slug || `user-${Array.from(name).map(character => character.codePointAt(0)!.toString(16)).join('-')}`;
}

export function colorThemeType(type: ColorThemeDocument['type']): ColorScheme {
	switch (type) {
		case 'light': return ColorScheme.Light;
		case 'hcDark': return ColorScheme.HighContrastDark;
		case 'hcLight': return ColorScheme.HighContrastLight;
		default: return ColorScheme.Dark;
	}
}

export function createDocumentColorTheme(document: ColorThemeDocument, id: string, label: string, colorScheme: ColorScheme): IColorTheme {
	const tokenColors = Object.freeze(asTokenColorRules(document.tokenColors).map(rule => Object.freeze({
		scopes: Object.freeze((typeof rule.scope === 'string' ? [rule.scope] : rule.scope ?? []).flatMap(scope => scope.split(',')).map(scope => scope.trim()).filter(Boolean)),
		settings: Object.freeze({ ...rule.settings }),
	})));
	if (tokenColors.reduce((count, rule) => count + rule.scopes.length, 0) > 1024) throw new Error('Theme exceeds 1024 token scopes');
	return createColorTheme({
		id, label, colorScheme, colorOverrides: document.colors, allowUnregisteredColorOverrides: true, tokenColors,
		semanticHighlighting: document.semanticHighlighting,
		semanticTokenRules: parseSemanticTokenRules(document.semanticTokenColors),
	});
}

function parseSemanticTokenRules(colors: ColorThemeDocument['semanticTokenColors']): readonly ISemanticTokenThemeRule[] {
	if (!colors) return Object.freeze([]);
	if (Object.keys(colors).length > 1024) throw new Error('Theme exceeds 1024 semantic token rules');
	return Object.freeze(Object.entries(colors).map(([selector, value]) => {
		const match = /^(\*|[A-Za-z][A-Za-z0-9_]*)(\.[A-Za-z][A-Za-z0-9_]*)*(?::[A-Za-z][A-Za-z0-9_-]*)?$/u.exec(selector);
		if (!match) throw new Error(`Invalid semantic token selector: ${selector}`);
		const [typeAndModifiers, language] = selector.split(':');
		const [type, ...modifiers] = typeAndModifiers!.split('.');
		const style = typeof value === 'string' ? { foreground: value } : value;
		const fontStyle = style.fontStyle ?? [style.italic && 'italic', style.bold && 'bold', style.underline && 'underline', style.strikethrough && 'strikethrough'].filter(Boolean).join(' ');
		const hasFontFlags = 'italic' in style || 'bold' in style || 'underline' in style || 'strikethrough' in style;
		return Object.freeze({ selector, type: type!, modifiers: Object.freeze(modifiers), ...(language ? { language } : {}),
			...(style.foreground ? { foreground: style.foreground } : {}), ...(style.fontStyle !== undefined || hasFontFlags ? { fontStyle } : {}) });
	}));
}

/** Exports resolved colors, so user documents contain no aliases or transform expressions. */
export function serializeUserColorThemeDraft(theme: IColorTheme, label: string): string {
	const type = theme.colorScheme === ColorScheme.HighContrastDark ? 'hcDark' : theme.colorScheme === ColorScheme.HighContrastLight ? 'hcLight' : theme.colorScheme;
	const document: ColorThemeDocument = {
		$schema: colorThemeSchemaId,
		name: label,
		type,
		colors: Object.fromEntries(theme.colorEntries.flatMap(({ id, value }) => value ? [[id, Color.Format.CSS.formatHexA(value, true)]] : [])),
		tokenColors: theme.tokenColors?.map(rule => ({ scope: rule.scopes, settings: rule.settings })) ?? [],
		...(theme.semanticHighlighting === undefined ? {} : { semanticHighlighting: theme.semanticHighlighting }),
		...(theme.semanticTokenRules?.length ? { semanticTokenColors: Object.fromEntries(theme.semanticTokenRules.map(rule => [rule.selector, { foreground: rule.foreground, fontStyle: rule.fontStyle }])) } : {}),
	};
	parseColorThemeDocument(document);
	return `${JSON.stringify(document, null, 2)}\n`;
}
