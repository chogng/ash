import { Color } from "../../../base/common/color.js";
import { Colors, type ColorIdentifier, type ColorValue, type ResolvedColorContribution } from "./colorRegistry.js";
import { colorCssVariable } from "./colorUtils.js";
import * as baseColors from "./colors/baseColors.js";
import "./colors/chartsColors.js";
import * as chatColors from "./colors/chatColors.js";
import "./colors/collaborationColors.js";
import * as componentColors from "./colors/componentColors.js";
import * as editorColors from "./colors/editorColors.js";
import * as filesColors from "./colors/filesColors.js";
import * as inputColors from "./colors/inputColors.js";
import * as listColors from "./colors/listColors.js";
import * as menuColors from "./colors/menuColors.js";
import "./colors/minimapColors.js";
import * as miscColors from "./colors/miscColors.js";
import * as quickpickColors from "./colors/quickpickColors.js";
import * as searchColors from "./colors/searchColors.js";
import * as settingsColors from "./colors/settingsColors.js";
import * as terminalColors from "./colors/terminalColors.js";
import { Sizes, sizeCssVariable, sizeToCss, type SizeContribution, type SizeValue } from "./sizeRegistry.js";
import "./sizes/baseSizes.js";
import { ColorScheme } from "./theme.js";

/** Named compatibility facade. New token domains should export their registered identifiers directly. */
export const ColorId = Object.freeze({
	foreground: baseColors.foreground,
	descriptionForeground: baseColors.descriptionForeground,
	mutedForeground: baseColors.mutedForeground,
	accentForeground: baseColors.accentForeground,
	accentBackground: baseColors.accentBackground,
	errorForeground: baseColors.errorForeground,
	warningForeground: baseColors.warningForeground,
	successForeground: baseColors.successForeground,
	focusBorder: baseColors.focusBorder,
	border: baseColors.border,
	widgetBorder: baseColors.widgetBorder,
	widgetShadow: baseColors.widgetShadow,
	inputForeground: inputColors.inputForeground,
	inputBackground: inputColors.inputBackground,
	inputBorder: inputColors.inputBorder,
	inputPlaceholderForeground: inputColors.inputPlaceholderForeground,
	selectionForeground: baseColors.selectionForeground,
	selectionBackground: baseColors.selectionBackground,
	hoverForeground: componentColors.hoverForeground,
	hoverBackground: componentColors.hoverBackground,
	hoverBorder: componentColors.hoverBorder,
	hoverShadow: componentColors.hoverShadow,
	listHoverBackground: listColors.listHoverBackground,
	listActiveSelectionForeground: listColors.listActiveSelectionForeground,
	listActiveSelectionBackground: listColors.listActiveSelectionBackground,
	treeIndentGuidesStroke: listColors.treeIndentGuidesStroke,
	menuForeground: menuColors.menuForeground,
	menuSelectionForeground: menuColors.menuSelectionForeground,
	menuSelectionBackground: menuColors.menuSelectionBackground,
	menuBackground: menuColors.menuBackground,
	menuHoverBackground: menuColors.menuHoverBackground,
	buttonForeground: inputColors.buttonForeground,
	buttonBackground: inputColors.buttonBackground,
	buttonHoverBackground: inputColors.buttonHoverBackground,
	buttonActiveBackground: inputColors.buttonActiveBackground,
	actionBarBackground: componentColors.actionBarBackground,
	actionBarToggledBackground: componentColors.actionBarToggledBackground,
	tabListHoverBackground: componentColors.tabListHoverBackground,
	tabListActiveBackground: componentColors.tabListActiveBackground,
	buttonSecondaryBackground: inputColors.buttonSecondaryBackground,
	primaryButtonForeground: inputColors.primaryButtonForeground,
	primaryButtonBackground: inputColors.primaryButtonBackground,
	primaryButtonHoverBackground: inputColors.primaryButtonHoverBackground,
	toolbarHoverBackground: componentColors.toolbarHoverBackground,
	keybindingLabelForeground: inputColors.keybindingLabelForeground,
	keybindingLabelBackground: inputColors.keybindingLabelBackground,
	keybindingLabelBorder: inputColors.keybindingLabelBorder,
	keybindingLabelBottomBorder: inputColors.keybindingLabelBottomBorder,
	scrollbarShadow: miscColors.scrollbarShadow,
	scrollbarSliderBackground: miscColors.scrollbarSliderBackground,
	scrollbarSliderHoverBackground: miscColors.scrollbarSliderHoverBackground,
	scrollbarSliderActiveBackground: miscColors.scrollbarSliderActiveBackground,
	dialogBackground: componentColors.dialogBackground,
	dialogBorder: componentColors.dialogBorder,
	dialogBackdropBackground: componentColors.dialogBackdropBackground,
	dialogShadow: componentColors.dialogShadow,
	quickInputBackground: quickpickColors.quickInputBackground,
	quickInputBackdropBackground: quickpickColors.quickInputBackdropBackground,
	textCodeBlockBackground: componentColors.textCodeBlockBackground,
	searchMatchBackground: searchColors.searchMatchBackground,
	settingsItemBackground: settingsColors.itemBackground,
	settingsItemSeparator: settingsColors.itemSeparator,
	chatTabBackground: chatColors.chatTabBackground,
	emptyExplorerOpenFolderBackground: filesColors.emptyExplorerOpenFolderBackground,
	emptyExplorerOpenFolderHoverBackground: filesColors.emptyExplorerOpenFolderHoverBackground,
	editorBackground: editorColors.editorBackground,
	editorForeground: editorColors.editorForeground,
	editorTokenCommentForeground: editorColors.tokenCommentForeground,
	editorTokenKeywordForeground: editorColors.tokenKeywordForeground,
	editorTokenStringForeground: editorColors.tokenStringForeground,
	editorTokenNumberForeground: editorColors.tokenNumberForeground,
	editorTokenRegexpForeground: editorColors.tokenRegexpForeground,
	editorTokenTypeForeground: editorColors.tokenTypeForeground,
	editorTokenFunctionForeground: editorColors.tokenFunctionForeground,
	editorTokenVariableForeground: editorColors.tokenVariableForeground,
	editorTokenOperatorForeground: editorColors.tokenOperatorForeground,
	editorFoldBackground: editorColors.foldBackground,
	editorFoldPlaceholderForeground: editorColors.foldPlaceholderForeground,
	editorGutterFoldingControlForeground: editorColors.foldingControlForeground,
	diffEditorRemovedLineBackground: editorColors.diffRemovedLineBackground,
	diffEditorInsertedLineBackground: editorColors.diffInsertedLineBackground,
	diffEditorRemovedTextBackground: editorColors.diffRemovedTextBackground,
	diffEditorInsertedTextBackground: editorColors.diffInsertedTextBackground,
	diffEditorMissingLineBackground: editorColors.diffMissingLineBackground,
	diffEditorUnchangedRegionBackground: editorColors.diffUnchangedRegionBackground,
	diffEditorUnchangedRegionForeground: editorColors.diffUnchangedRegionForeground,
	diffEditorRemovedLineMarker: editorColors.diffRemovedLineMarker,
	diffEditorInsertedLineMarker: editorColors.diffInsertedLineMarker,
	terminalBackground: terminalColors.terminalBackground,
	terminalForeground: terminalColors.terminalForeground,
	terminalCursorForeground: terminalColors.terminalCursorForeground,
	terminalAnsiBlack: terminalColors.terminalAnsiBlack,
	terminalAnsiRed: terminalColors.terminalAnsiRed,
	terminalAnsiGreen: terminalColors.terminalAnsiGreen,
	terminalAnsiYellow: terminalColors.terminalAnsiYellow,
	terminalAnsiBlue: terminalColors.terminalAnsiBlue,
	terminalAnsiMagenta: terminalColors.terminalAnsiMagenta,
	terminalAnsiCyan: terminalColors.terminalAnsiCyan,
	terminalAnsiWhite: terminalColors.terminalAnsiWhite,
	terminalAnsiBrightBlack: terminalColors.terminalAnsiBrightBlack,
	terminalAnsiBrightRed: terminalColors.terminalAnsiBrightRed,
	terminalAnsiBrightGreen: terminalColors.terminalAnsiBrightGreen,
	terminalAnsiBrightYellow: terminalColors.terminalAnsiBrightYellow,
	terminalAnsiBrightBlue: terminalColors.terminalAnsiBrightBlue,
	terminalAnsiBrightMagenta: terminalColors.terminalAnsiBrightMagenta,
	terminalAnsiBrightCyan: terminalColors.terminalAnsiBrightCyan,
	terminalAnsiBrightWhite: terminalColors.terminalAnsiBrightWhite,
});

export { colorCssVariable, sizeCssVariable };
export type { ColorIdentifier };

export const sizeIdentifiers: readonly string[] = Object.freeze(Sizes.getSizes().map(({ id }) => id));
export type ThemeColors = Readonly<Record<ColorIdentifier, string>>;

/** Fixed theme settings with resolved colors that include newly registered contributions. */
export interface IColorTheme {
	readonly tokenColors?: readonly {
		readonly scopes: readonly string[];
		readonly settings: { readonly foreground?: string; readonly background?: string; readonly fontStyle?: string };
	}[];
	readonly id: string;
	readonly label: string;
	readonly colorScheme: ColorScheme;
	readonly colors: ThemeColors;
	readonly colorEntries: readonly ResolvedColorContribution[];
	readonly sizeEntries: readonly SizeContribution[];
	getColor(id: ColorIdentifier): Color | undefined;
	getColorCss(id: ColorIdentifier): string | undefined;
	getSize(id: string): SizeValue | undefined;
}

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
