import { Color } from "../../../base/common/color.js";
import { Colors, type ColorIdentifier, type ColorValue, type ResolvedColorContribution } from "./colorRegistry.js";
import "./colors/baseColors.js";
import "./colors/chartsColors.js";
import "./colors/componentColors.js";
import "./colors/editorColors.js";
import "./colors/inputColors.js";
import "./colors/listColors.js";
import "./colors/menuColors.js";
import "./colors/minimapColors.js";
import "./colors/miscColors.js";
import "./colors/quickpickColors.js";
import "./colors/searchColors.js";
import { getTokenClassificationRegistry, type TokenStyleData } from './tokenClassificationRegistry.js';
import { Sizes } from "./sizeRegistry.js";
import "./sizes/baseSizes.js";
import { ColorScheme } from "./theme.js";
import type { IColorTheme, ITokenStyle, ThemeColors } from "./themeService.js";

export interface IColorThemeOptions {
	readonly id: string;
	readonly label: string;
	readonly colorScheme: ColorScheme;
	readonly colorOverrides?: Readonly<Record<string, ColorValue>>;
	readonly baseTheme?: IColorTheme;
	readonly resetColorOverrides?: readonly string[];
	readonly allowUnregisteredColorOverrides?: boolean;
	readonly tokenColors?: IColorTheme['tokenColors'];
	readonly semanticHighlighting?: boolean;
	readonly semanticTokenRules?: IColorTheme['semanticTokenRules'];
	readonly resolveTokenScopes?: (rules: NonNullable<IColorTheme['tokenColors']>, scopes: readonly string[]) => TokenStyleData | undefined;
}

// Retain authored values so layered overrides re-resolve aliases instead of freezing resolved defaults.
const themeScopeResolvers = new WeakMap<IColorTheme, NonNullable<IColorThemeOptions['resolveTokenScopes']>>();
const themeColorOverrides = new WeakMap<IColorTheme, Readonly<Record<string, ColorValue>>>();

/** Keeps color resolution current without giving each theme its own registry listener. */
export function createColorTheme(options: IColorThemeOptions): IColorTheme {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.id)) throw new TypeError(`Invalid color theme ID '${options.id}'`);
	Sizes.seal();
	const colorScheme = options.colorScheme;
	const baseOverrides = options.baseTheme ? themeColorOverrides.get(options.baseTheme) : undefined;
	if (options.baseTheme && !baseOverrides) throw new TypeError('Base themes must be created by the color theme factory');
	const authored = { ...baseOverrides };
	for (const id of options.resetColorOverrides ?? []) { delete authored[id]; }
	const overrides = Object.freeze({ ...authored, ...options.colorOverrides });
	let catalog = Colors.getColors();
	let resolved = resolveThemeColors(colorScheme, overrides, options.allowUnregisteredColorOverrides === true);
	const currentColors = (): typeof resolved => {
		if (catalog !== Colors.getColors()) {
			resolved = resolveThemeColors(colorScheme, overrides, options.allowUnregisteredColorOverrides === true);
			catalog = Colors.getColors();
		}
		return resolved;
	};
	const sizeEntries = Object.freeze(Sizes.getSizes().map((entry) => Object.freeze({ ...entry, value: Object.freeze({ ...entry.value }) })));
	const sizeMap = new Map(sizeEntries.map(({ id, value }) => [id, value] as const));
	const classifications = getTokenClassificationRegistry();
	const scopeResolver = options.resolveTokenScopes ?? (options.baseTheme ? themeScopeResolvers.get(options.baseTheme) : undefined);
	const colorMap = [''];
	const styleCache = new Map<string, ITokenStyle | undefined>();
	let classificationRevision = classifications.revision;
	const rules = (options.semanticTokenRules ?? []).map(rule => ({ rule, selector: classifications.parseTokenSelector(rule.selector) }));
	const resolveStyle = (type: string, modifiers: readonly string[], language: string): ITokenStyle | undefined => {
		if (classificationRevision !== classifications.revision) { styleCache.clear(); classificationRevision = classifications.revision; }
		const key = JSON.stringify([type, modifiers, language]);
		if (styleCache.has(key)) { return styleCache.get(key); }
		const style: { foreground?: string; bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean; } = {};
		const scores = new Map<string, number>();
		const apply = (candidate: TokenStyleData, score: number): void => {
			for (const property of ['foreground', 'bold', 'italic', 'underline', 'strikethrough'] as const) {
				if (candidate[property] !== undefined && score >= (scores.get(property) ?? -1)) { Object.assign(style, { [property]: candidate[property] }); scores.set(property, score); }
			}
		};
		for (const { selector, defaults } of classifications.getTokenStylingDefaultRules()) {
			const score = selector.match(type, modifiers, language);
			if (score < 0 || !scopeResolver) { continue; }
			for (const scope of defaults.scopesToProbe) {
				const candidate = scopeResolver(options.tokenColors ?? [], scope);
				if (candidate) { apply(candidate, score); break; }
			}
		}
		for (const { rule, selector } of rules) {
			const score = selector.match(type, modifiers, language);
			if (score < 0) { continue; }
			const candidate: TokenStyleData = { foreground: rule.foreground };
			if (rule.fontStyle !== undefined) {
				const flags = new Set(rule.fontStyle.split(/\s+/u));
				Object.assign(candidate, { bold: flags.has('bold'), italic: flags.has('italic'), underline: flags.has('underline'), strikethrough: flags.has('strikethrough') });
			}
			// Individual flags override fontStyle, including explicit false.
			for (const flag of ['bold', 'italic', 'underline', 'strikethrough'] as const) {
				if (rule[flag] !== undefined) { Object.assign(candidate, { [flag]: rule[flag] }); }
			}
			apply(candidate, 100_000 + score);
		}
		if (Object.keys(style).length === 0) { styleCache.set(key, undefined); return undefined; }
		let foreground: number | undefined;
		if (style.foreground !== undefined) {
			foreground = colorMap.indexOf(style.foreground);
			if (foreground < 0) { foreground = colorMap.push(style.foreground) - 1; }
		}
		const result = Object.freeze({ ...style, foreground });
		styleCache.set(key, result);
		return result;
	};
	const theme = {
		id: options.id,
		label: options.label,
		colorScheme: options.colorScheme,
		get colors() { return currentColors().colors; },
		get colorEntries() { return currentColors().entries; },
		sizeEntries,
		tokenColorMap: colorMap,
		getTokenStyleMetadata: resolveStyle,
		defines: (id: ColorIdentifier) => Object.hasOwn(overrides, id),
		getColor: (id: ColorIdentifier, useDefault = true) => useDefault || Object.hasOwn(overrides, id) ? currentColors().map.get(id) ?? undefined : undefined,
		getColorCss: (id: ColorIdentifier) => {
			const color = currentColors().map.get(id);
			return color ? Color.Format.CSS.formatHexA(color, true) : undefined;
		},
		getSize: (id: string) => sizeMap.get(id),
	};
	if (options.tokenColors) {
		Object.assign(theme, { tokenColors: options.tokenColors });
	}
	if (options.semanticHighlighting !== undefined) Object.assign(theme, { semanticHighlighting: options.semanticHighlighting });
	if (options.semanticTokenRules) Object.assign(theme, { semanticTokenRules: options.semanticTokenRules });
	themeColorOverrides.set(theme, overrides);
	if (scopeResolver) { themeScopeResolvers.set(theme, scopeResolver); }
	return Object.freeze(theme);
}

function resolveThemeColors(scheme: ColorScheme, overrides: Readonly<Record<string, ColorValue>>, allowUnregisteredColorOverrides: boolean): {
	readonly entries: readonly ResolvedColorContribution[];
	readonly map: ReadonlyMap<ColorIdentifier, Color | null>;
	readonly colors: ThemeColors;
} {
	const registeredIds = allowUnregisteredColorOverrides ? new Set(Colors.getColors().map(color => color.id)) : undefined;
	const registeredOverrides = registeredIds
		? Object.fromEntries(Object.entries(overrides).filter(([id]) => registeredIds.has(id)))
		: overrides;
	const entries = Colors.resolve(scheme, registeredOverrides);
	const map = new Map(entries.map(({ id, value }) => [id, value] as const));
	const colors = Object.freeze(Object.fromEntries(entries.flatMap(({ id, value }) => value ? [[id, Color.Format.CSS.formatHexA(value, true)]] : [])));
	return { entries, map, colors };
}

export const darkColorTheme = createColorTheme({ id: "ash-dark", label: "Ash Dark", colorScheme: ColorScheme.Dark });
export const lightColorTheme = createColorTheme({ id: "ash-light", label: "Ash Light", colorScheme: ColorScheme.Light });
export const highContrastDarkColorTheme = createColorTheme({ id: "ash-high-contrast-dark", label: "Ash High Contrast Dark", colorScheme: ColorScheme.HighContrastDark });
export const highContrastLightColorTheme = createColorTheme({ id: "ash-high-contrast-light", label: "Ash High Contrast Light", colorScheme: ColorScheme.HighContrastLight });
