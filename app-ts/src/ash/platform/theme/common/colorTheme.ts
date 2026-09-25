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
import { Sizes } from "./sizeRegistry.js";
import "./sizes/baseSizes.js";
import { ColorScheme } from "./theme.js";
import type { IColorTheme, ThemeColors } from "./themeService.js";

export interface IColorThemeOptions {
	readonly id: string;
	readonly label: string;
	readonly colorScheme: ColorScheme;
	readonly colorOverrides?: Readonly<Record<string, ColorValue>>;
	readonly tokenColors?: IColorTheme['tokenColors'];
}

/** Keeps color resolution current without giving each theme its own registry listener. */
export function createColorTheme(options: IColorThemeOptions): IColorTheme {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.id)) throw new TypeError(`Invalid color theme ID '${options.id}'`);
	Sizes.seal();
	const colorScheme = options.colorScheme;
	const overrides = Object.freeze({ ...options.colorOverrides });
	let catalog = Colors.getColors();
	let resolved = resolveThemeColors(colorScheme, overrides);
	const currentColors = (): typeof resolved => {
		if (catalog !== Colors.getColors()) {
			resolved = resolveThemeColors(colorScheme, overrides);
			catalog = Colors.getColors();
		}
		return resolved;
	};
	const sizeEntries = Object.freeze(Sizes.getSizes().map((entry) => Object.freeze({ ...entry, value: Object.freeze({ ...entry.value }) })));
	const sizeMap = new Map(sizeEntries.map(({ id, value }) => [id, value] as const));
	const theme = {
		id: options.id,
		label: options.label,
		colorScheme: options.colorScheme,
		get colors() { return currentColors().colors; },
		get colorEntries() { return currentColors().entries; },
		sizeEntries,
		getColor: (id: ColorIdentifier) => currentColors().map.get(id) ?? undefined,
		getColorCss: (id: ColorIdentifier) => {
			const color = currentColors().map.get(id);
			return color ? Color.Format.CSS.formatHexA(color, true) : undefined;
		},
		getSize: (id: string) => sizeMap.get(id),
	};
	if (options.tokenColors) {
		Object.assign(theme, { tokenColors: options.tokenColors });
	}
	return Object.freeze(theme);
}

function resolveThemeColors(scheme: ColorScheme, overrides: Readonly<Record<string, ColorValue>>): {
	readonly entries: readonly ResolvedColorContribution[];
	readonly map: ReadonlyMap<ColorIdentifier, Color | null>;
	readonly colors: ThemeColors;
} {
	const entries = Colors.resolve(scheme, overrides);
	const map = new Map(entries.map(({ id, value }) => [id, value] as const));
	const colors = Object.freeze(Object.fromEntries(entries.flatMap(({ id, value }) => value ? [[id, Color.Format.CSS.formatHexA(value, true)]] : [])));
	return { entries, map, colors };
}

export const darkColorTheme = createColorTheme({ id: "ash-dark", label: "Ash Dark", colorScheme: ColorScheme.Dark });
export const lightColorTheme = createColorTheme({ id: "ash-light", label: "Ash Light", colorScheme: ColorScheme.Light });
export const highContrastDarkColorTheme = createColorTheme({ id: "ash-high-contrast-dark", label: "Ash High Contrast Dark", colorScheme: ColorScheme.HighContrastDark });
export const highContrastLightColorTheme = createColorTheme({ id: "ash-high-contrast-light", label: "Ash High Contrast Light", colorScheme: ColorScheme.HighContrastLight });
