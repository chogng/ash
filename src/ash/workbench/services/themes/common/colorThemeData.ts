import { resolveTextMateTokenStyle } from '../../textMate/common/textMateThemeProjection.js';
import { Color } from '../../../../base/common/color.js';
import { parseJsonDocument } from '../../../../base/common/json.js';
import { parseJsonc } from '../../../../base/common/jsonc.js';
import { validateJsonSchema } from '../../../../base/common/jsonSchema.js';
import { createColorTheme } from '../../../../platform/theme/common/colorTheme.js';
import type { IColorTheme, ISemanticTokenThemeRule } from '../../../../platform/theme/common/themeService.js';
import { ColorScheme } from '../../../../platform/theme/common/theme.js';
import { colorThemeSchema, colorThemeSchemaId } from './colorThemeSchema.js';
import { localize } from '../../../../nls.js';


export interface ColorThemeDocument {
	readonly $schema?: string;
	readonly include?: string;
	readonly name?: string;
	readonly type?: 'dark' | 'light' | 'hcDark' | 'hcLight';
	readonly colors?: Readonly<Record<string, string>>;
	readonly tokenColors?: string | readonly {
		readonly name?: string;
		readonly scope?: string | readonly string[];
		readonly settings: { readonly foreground?: string; readonly background?: string; readonly fontStyle?: string; };
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
	if (!source || source.length > 1_048_576) throw new Error(localize('theme.documentTooLarge', 'Theme exceeds the 1 MiB document limit'));
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
	const content = typeof value === 'string'
		? /\.tmTheme$/iu.test(resource) ? parseSyntaxTheme(value) : parseJsonc(value, `Token theme '${resource}'`)
		: value;
	if (typeof content !== 'object' || content === null || !('settings' in content)) throw new Error(`Invalid TextMate theme: ${resource}`);
	const document = parseColorThemeDocument({ tokenColors: content.settings });
	return asTokenColorRules(document.tokenColors);
}

/** Reads the property-list data used by .tmTheme without a tokenizer runtime or XML I/O. */
function parseSyntaxTheme(source: string): unknown {
	if (source.length > 1_048_576) throw new Error(localize('theme.documentTooLarge', 'Theme exceeds the 1 MiB document limit'));
	let offset = 0;
	let elements = 0;
	const tag = /<(\/?)([A-Za-z][\w-]*)(?:\s+[A-Za-z_:][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*\s*(\/?)>/y;
	const whitespace = /\s*/y;
	const fail = (): never => { throw new Error(localize('theme.invalidPropertyList', 'Invalid property-list theme at offset {0}', offset)); };
	const skip = (): void => {
		while (true) {
			whitespace.lastIndex = offset;
			offset += whitespace.exec(source)![0].length;
			let end: number;
			if (source.startsWith('<!--', offset)) {
				end = source.indexOf('-->', offset + 4);
				if (end < 0) fail();
				offset = end + 3;
			} else if (source.startsWith('<?', offset)) {
				end = source.indexOf('?>', offset + 2);
				if (end < 0) fail();
				offset = end + 2;
			} else if (source.startsWith('<!DOCTYPE', offset)) {
				end = source.indexOf('>', offset + 9);
				// External declarations are inert; custom entity declarations are unsupported.
				if (end < 0 || source.slice(offset, end).includes('[')) fail();
				offset = end + 1;
			} else return;
		}
	};
	const takeTag = (): { name: string; closing: boolean; empty: boolean; } => {
		skip();
		tag.lastIndex = offset;
		const match = tag.exec(source);
		if (!match || ++elements > 100_000) return fail();
		offset = tag.lastIndex;
		return { name: match[2]!, closing: match[1] === '/', empty: match[3] === '/' };
	};
	const close = (name: string): void => {
		const end = takeTag();
		if (end.name !== name || !end.closing || end.empty) fail();
	};
	const decode = (value: string): string => value.replace(/&(?:#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);|&/giu, entity => {
		const named: Readonly<Record<string, string>> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
		if (entity in named) return named[entity]!;
		if (!entity.startsWith('&#')) return fail();
		const point = entity.toLowerCase().startsWith('&#x') ? Number.parseInt(entity.slice(3, -1), 16) : Number.parseInt(entity.slice(2, -1), 10);
		if (!(point === 9 || point === 10 || point === 13 || point >= 0x20 && point <= 0xd7ff || point >= 0xe000 && point <= 0xfffd || point >= 0x10000 && point <= 0x10ffff)) return fail();
		return String.fromCodePoint(point);
	});
	const read = (depth: number): unknown => {
		if (depth > 128) return fail();
		const start = takeTag();
		if (start.closing) return fail();
		const { name, empty } = start;
		if (name === 'dict' || name === 'array') {
			const value: Record<string, unknown> | unknown[] = name === 'dict' ? Object.create(null) : [];
			if (empty) return value;
			while (true) {
				skip();
				if (source.startsWith('</', offset)) break;
				if (Array.isArray(value)) value.push(read(depth + 1));
				else {
					const keyOffset = offset;
					const keyTag = takeTag();
					if (keyTag.name !== 'key' || keyTag.closing) return fail();
					offset = keyOffset;
					const key = read(depth + 1) as string;
					if (Object.hasOwn(value, key)) return fail();
					value[key] = read(depth + 1);
				}
			}
			close(name);
			return value;
		}
		if (!['key', 'string', 'integer', 'real', 'date', 'data', 'true', 'false'].includes(name)) return fail();
		let value = '';
		if (!empty) {
			while (!source.startsWith('</', offset)) {
				if (source.startsWith('<![CDATA[', offset)) {
					const end = source.indexOf(']]>', offset + 9);
					if (end < 0) return fail();
					value += source.slice(offset + 9, end);
					offset = end + 3;
				} else if (source.startsWith('<!--', offset)) {
					const end = source.indexOf('-->', offset + 4);
					if (end < 0) return fail();
					offset = end + 3;
				}
				else {
					const end = source.indexOf('<', offset);
					if (end <= offset) return fail();
					value += decode(source.slice(offset, end));
					offset = end;
				}
			}
			close(name);
		}
		if (name === 'true' || name === 'false') {
			if (value.trim()) return fail();
			return name === 'true';
		}
		if (name === 'integer' || name === 'real') {
			const number = Number(value);
			if (!value.trim() || !Number.isFinite(number) || name === 'integer' && !Number.isInteger(number)) return fail();
			return number;
		}
		return value;
	};
	const root = takeTag();
	if (root.name !== 'plist' || root.closing || root.empty) return fail();
	const value = read(0);
	close('plist');
	skip();
	if (offset !== source.length) return fail();
	return value;
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
		scopes: Object.freeze((typeof rule.scope === 'string' ? [rule.scope] : rule.scope ?? []).map(scope => scope.trim()).filter(Boolean)),
		settings: Object.freeze({ ...rule.settings }),
	})));
	if (tokenColors.reduce((count, rule) => count + rule.scopes.length, 0) > 1024) throw new Error('Theme exceeds 1024 token scopes');
	return createColorTheme({
		id, label, colorScheme, resolveTokenScopes: resolveTextMateTokenStyle, colorOverrides: document.colors, allowUnregisteredColorOverrides: true, tokenColors,
		semanticHighlighting: document.semanticHighlighting,
		semanticTokenRules: parseSemanticTokenRules(document.semanticTokenColors),
	});
}

export function parseSemanticTokenRules(colors: ColorThemeDocument['semanticTokenColors']): readonly ISemanticTokenThemeRule[] {
	if (!colors) return Object.freeze([]);
	if (Object.keys(colors).length > 1024) throw new Error('Theme exceeds 1024 semantic token rules');
	return Object.freeze(Object.entries(colors).map(([selector, value]) => {
		const match = /^(\*|[A-Za-z][A-Za-z0-9_]*)(\.[A-Za-z][A-Za-z0-9_]*)*(?::[A-Za-z][A-Za-z0-9_-]*)?$/u.exec(selector);
		if (!match) throw new Error(`Invalid semantic token selector: ${selector}`);
		const [typeAndModifiers, language] = selector.split(':');
		const [type, ...modifiers] = typeAndModifiers!.split('.');
		const style = typeof value === 'string' ? { foreground: value } : value;
		return Object.freeze({
			selector, type: type!, modifiers: Object.freeze(modifiers), ...(language ? { language } : {}),
			...style
		});
	}));
}

/** Keep registry defaults implicit so copies still follow their design tokens. Explicit overrides export as resolved hex colors. */
export function serializeUserColorThemeDraft(theme: IColorTheme, label: string): string {
	const document: ColorThemeDocument = {
		$schema: colorThemeSchemaId,
		name: label,
		type: theme.colorScheme,
		colors: Object.fromEntries(theme.colorEntries.flatMap(({ id, value }) => theme.defines(id) && value ? [[id, Color.Format.CSS.formatHexA(value, true)]] : [])),
		tokenColors: theme.tokenColors?.map(rule => ({ scope: rule.scopes, settings: rule.settings })) ?? [],
		...(theme.semanticHighlighting === undefined ? {} : { semanticHighlighting: theme.semanticHighlighting }),
		...(theme.semanticTokenRules?.length ? { semanticTokenColors: Object.fromEntries(theme.semanticTokenRules.map(rule => [rule.selector, { foreground: rule.foreground, fontStyle: rule.fontStyle, bold: rule.bold, italic: rule.italic, underline: rule.underline, strikethrough: rule.strikethrough }])) } : {}),
	};
	parseColorThemeDocument(document);
	return `${JSON.stringify(document, null, 2)}\n`;
}
