import { Color } from '../../../../base/common/color.js';
import { parseJsonDocument } from '../../../../base/common/json.js';
import { parseJsonc } from '../../../../base/common/jsonc.js';
import { validateJsonSchema } from '../../../../base/common/jsonSchema.js';
import { colorIdentifiers, createColorTheme, type IColorTheme } from '../../../../platform/theme/common/colorTheme.js';
import { ColorScheme } from '../../../../platform/theme/common/theme.js';
import { colorThemeSchema, colorThemeSchemaId } from './colorThemeSchema.js';

export interface ColorThemeDocument {
	readonly $schema?: string;
	readonly name?: string;
	readonly type?: 'dark' | 'light' | 'hcDark' | 'hcLight';
	readonly colors?: Readonly<Record<string, string>>;
	readonly tokenColors?: readonly {
		readonly name?: string;
		readonly scope?: string | readonly string[];
		readonly settings: { readonly foreground?: string; readonly background?: string; readonly fontStyle?: string };
	}[];
	readonly semanticHighlighting?: boolean;
}

export function parseColorThemeDocument(value: unknown): ColorThemeDocument {
	const source = JSON.stringify(value);
	if (!source || source.length > 1_048_576) throw new Error('Theme exceeds the 1 MiB document limit');
	const issues = validateJsonSchema(parseJsonDocument(source), colorThemeSchema);
	if (issues.length) throw new Error(`Invalid color theme: ${issues.map(issue => issue.message).join('; ')}`);
	return value as ColorThemeDocument;
}

/** Compiles file contents; resource identity is supplied by the caller, never by the document. */
export function parseUserColorTheme(source: string, id?: string): IColorTheme {
	if (source.length > 1_048_576) throw new Error('Theme exceeds the 1 MiB document limit');
	const document = parseColorThemeDocument(parseJsonc(source, 'Color theme'));
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
	const known = new Set(colorIdentifiers);
	const colors = Object.fromEntries(Object.entries(document.colors ?? {}).filter(([key]) => known.has(key)));
	const tokenColors = Object.freeze((document.tokenColors ?? []).map(rule => Object.freeze({
		scopes: Object.freeze((typeof rule.scope === 'string' ? [rule.scope] : rule.scope ?? []).flatMap(scope => scope.split(',')).map(scope => scope.trim()).filter(Boolean)),
		settings: Object.freeze({ ...rule.settings }),
	})));
	if (tokenColors.reduce((count, rule) => count + rule.scopes.length, 0) > 1024) throw new Error('Theme exceeds 1024 token scopes');
	return Object.freeze({ ...createColorTheme({ id, label, colorScheme, colorOverrides: colors }), tokenColors });
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
	};
	parseColorThemeDocument(document);
	return `${JSON.stringify(document, null, 2)}\n`;
}
