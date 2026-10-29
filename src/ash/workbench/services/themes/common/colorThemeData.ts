import { Color } from '../../../../base/common/color.js';
import { parseJsonDocument } from '../../../../base/common/json.js';
import { parseJsonc } from '../../../../base/common/jsonc.js';
import { validateJsonSchema } from '../../../../base/common/jsonSchema.js';
import { createColorTheme, getColorThemeOverrides } from '../../../../platform/theme/common/colorTheme.js';
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
	readonly semanticHighlighting?: boolean;
	readonly semanticTokenColors?: Readonly<
		Record<
			string,
			| string
			| {
					readonly foreground?: string;
					readonly fontStyle?: string;
					readonly bold?: boolean;
					readonly italic?: boolean;
					readonly underline?: boolean;
					readonly strikethrough?: boolean;
			  }
		>
	>;
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
		const document = parseColorThemeDocument(read(resource));
		const inherited = document.include ? visit(resolveColorThemeInclude(resource, document.include), [...ancestors, resource]) : undefined;
		return mergeColorThemeDocuments(inherited, document);
	};
	return visit(resolveColorThemeInclude('', path), []);
}

/** Loads the same document format through a resource owner that performs asynchronous reads. */
export async function loadColorThemeDocument(path: string, read: (path: string) => Promise<unknown>): Promise<ColorThemeDocument> {
	const visit = async (resource: string, ancestors: readonly string[]): Promise<ColorThemeDocument> => {
		if (ancestors.includes(resource)) throw new Error(`Color theme include cycle: ${[...ancestors, resource].join(' -> ')}`);
		if (ancestors.length >= 16) throw new Error('Color theme include depth exceeds 16');
		const document = parseColorThemeDocument(await read(resource));
		const inherited = document.include ? await visit(resolveColorThemeInclude(resource, document.include), [...ancestors, resource]) : undefined;
		return mergeColorThemeDocuments(inherited, document);
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
		semanticTokenColors: { ...inherited.semanticTokenColors, ...own.semanticTokenColors },
		semanticHighlighting: inherited.semanticHighlighting === true || own.semanticHighlighting === true ? true : (own.semanticHighlighting ?? inherited.semanticHighlighting),
	};
}

function resolveColorThemeInclude(from: string, include: string): string {
	if (!/\.json$/iu.test(include) || include.startsWith('/') || include.includes('\\') || include.includes(':') || include.includes('?') || include.includes('#')) {
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
		return parseJsonc(source, `Color theme '${resource}'`);
	});
	const label = document.name ?? id ?? 'Untitled Theme';
	return createDocumentColorTheme(document, id ?? userThemeId(label), label, colorThemeType(document.type));
}

export function userThemeId(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, '-')
		.replace(/^-+|-+$/gu, '');
	return (
		slug ||
		`user-${Array.from(name)
			.map(character => character.codePointAt(0)!.toString(16))
			.join('-')}`
	);
}

export function colorThemeType(type: ColorThemeDocument['type']): ColorScheme {
	switch (type) {
		case 'light':
			return ColorScheme.Light;
		case 'hcDark':
			return ColorScheme.HighContrastDark;
		case 'hcLight':
			return ColorScheme.HighContrastLight;
		default:
			return ColorScheme.Dark;
	}
}

export function createDocumentColorTheme(document: ColorThemeDocument, id: string, label: string, colorScheme: ColorScheme): IColorTheme {
	return createColorTheme({
		id,
		label,
		colorScheme,
		colorOverrides: document.colors,
		allowUnregisteredColorOverrides: true,
		semanticHighlighting: document.semanticHighlighting,
		semanticTokenRules: parseSemanticTokenRules(document.semanticTokenColors),
	});
}

export function parseSemanticTokenRules(colors: ColorThemeDocument['semanticTokenColors']): readonly ISemanticTokenThemeRule[] {
	if (!colors) return Object.freeze([]);
	if (Object.keys(colors).length > 1024) throw new Error('Theme exceeds 1024 semantic token rules');
	return Object.freeze(
		Object.entries(colors).map(([selector, value]) => {
			const match = /^(\*|[A-Za-z][A-Za-z0-9_]*)(\.[A-Za-z][A-Za-z0-9_]*)*(?::[A-Za-z][A-Za-z0-9_-]*)?$/u.exec(selector);
			if (!match) throw new Error(`Invalid semantic token selector: ${selector}`);
			const [typeAndModifiers, language] = selector.split(':');
			const [type, ...modifiers] = typeAndModifiers!.split('.');
			const style = typeof value === 'string' ? { foreground: value } : value;
			return Object.freeze({
				selector,
				type: type!,
				modifiers: Object.freeze(modifiers),
				...(language ? { language } : {}),
				...style,
			});
		}),
	);
}

/** Keep registry defaults implicit so copies still follow their design tokens. Explicit overrides export as resolved hex colors. */
export function serializeUserColorThemeDraft(theme: IColorTheme, label: string): string {
	const colors: Record<string, string> = {};
	for (const [id, authored] of Object.entries(getColorThemeOverrides(theme))) {
		const resolved = theme.getColor(id);
		if (resolved) {
			colors[id] = Color.Format.CSS.formatHexA(resolved, true);
		} else if (typeof authored === 'string' && authored.startsWith('#')) {
			// Theme documents already validate literal colors. Keep them even while their extension is unavailable.
			colors[id] = authored;
		}
	}
	const document: ColorThemeDocument = {
		$schema: colorThemeSchemaId,
		name: label,
		type: theme.colorScheme,
		colors,
		...(theme.semanticHighlighting === undefined ? {} : { semanticHighlighting: theme.semanticHighlighting }),
		...(theme.semanticTokenRules?.length
			? {
					semanticTokenColors: Object.fromEntries(
						theme.semanticTokenRules.map(rule => [
							rule.selector,
							{
								foreground: rule.foreground,
								fontStyle: rule.fontStyle,
								bold: rule.bold,
								italic: rule.italic,
								underline: rule.underline,
								strikethrough: rule.strikethrough,
							},
						]),
					),
				}
			: {}),
	};
	parseColorThemeDocument(document);
	return `${JSON.stringify(document, null, 2)}\n`;
}
