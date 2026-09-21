import { Color } from "../../../base/common/color.js";
import { Colors, colorCssVariable, type ColorIdentifier, type ColorValue, type ResolvedColorContribution } from "./colorRegistry.js";
import * as baseColors from "./colors/baseColors.js";
import * as chatColors from "./colors/chatColors.js";
import "./colors/collaborationColors.js";
import * as componentColors from "./colors/componentColors.js";
import * as editorColors from "./colors/editorColors.js";
import * as filesColors from "./colors/filesColors.js";
import * as settingsColors from "./colors/settingsColors.js";
import * as terminalColors from "./colors/terminalColors.js";
import * as workbenchColors from "./colors/workbenchColors.js";
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
	inputForeground: componentColors.inputForeground,
	inputBackground: componentColors.inputBackground,
	inputBorder: componentColors.inputBorder,
	inputPlaceholderForeground: componentColors.inputPlaceholderForeground,
	selectionForeground: componentColors.selectionForeground,
	selectionBackground: componentColors.selectionBackground,
	hoverForeground: componentColors.hoverForeground,
	hoverBackground: componentColors.hoverBackground,
	hoverBorder: componentColors.hoverBorder,
	hoverShadow: componentColors.hoverShadow,
	listHoverBackground: componentColors.listHoverBackground,
	listActiveSelectionForeground: componentColors.listActiveSelectionForeground,
	listActiveSelectionBackground: componentColors.listActiveSelectionBackground,
	treeIndentGuidesStroke: componentColors.treeIndentGuidesStroke,
	menuForeground: componentColors.menuForeground,
	menuSelectionForeground: componentColors.menuSelectionForeground,
	menuSelectionBackground: componentColors.menuSelectionBackground,
	menuBackground: componentColors.menuBackground,
	menuHoverBackground: componentColors.menuHoverBackground,
	buttonForeground: componentColors.buttonForeground,
	buttonBackground: componentColors.buttonBackground,
	buttonHoverBackground: componentColors.buttonHoverBackground,
	buttonActiveBackground: componentColors.buttonActiveBackground,
	actionBarBackground: componentColors.actionBarBackground,
	actionBarToggledBackground: componentColors.actionBarToggledBackground,
	tabListHoverBackground: componentColors.tabListHoverBackground,
	tabListActiveBackground: componentColors.tabListActiveBackground,
	buttonSecondaryBackground: componentColors.buttonSecondaryBackground,
	primaryButtonForeground: componentColors.primaryButtonForeground,
	primaryButtonBackground: componentColors.primaryButtonBackground,
	primaryButtonHoverBackground: componentColors.primaryButtonHoverBackground,
	toolbarHoverBackground: componentColors.toolbarHoverBackground,
	keybindingLabelForeground: componentColors.keybindingLabelForeground,
	keybindingLabelBackground: componentColors.keybindingLabelBackground,
	keybindingLabelBorder: componentColors.keybindingLabelBorder,
	keybindingLabelBottomBorder: componentColors.keybindingLabelBottomBorder,
	scrollbarShadow: componentColors.scrollbarShadow,
	scrollbarSliderBackground: componentColors.scrollbarSliderBackground,
	scrollbarSliderHoverBackground: componentColors.scrollbarSliderHoverBackground,
	scrollbarSliderActiveBackground: componentColors.scrollbarSliderActiveBackground,
	dialogBackground: componentColors.dialogBackground,
	dialogBorder: componentColors.dialogBorder,
	dialogBackdropBackground: componentColors.dialogBackdropBackground,
	dialogShadow: componentColors.dialogShadow,
	quickInputBackground: componentColors.quickInputBackground,
	quickInputBackdropBackground: componentColors.quickInputBackdropBackground,
	textCodeBlockBackground: componentColors.textCodeBlockBackground,
	searchMatchBackground: componentColors.searchMatchBackground,
	settingsItemBackground: settingsColors.itemBackground,
	settingsItemSeparator: settingsColors.itemSeparator,
	chatTabBackground: chatColors.chatTabBackground,
	emptyExplorerOpenFolderBackground: filesColors.emptyExplorerOpenFolderBackground,
	emptyExplorerOpenFolderHoverBackground: filesColors.emptyExplorerOpenFolderHoverBackground,
	sectionHeaderForeground: workbenchColors.sectionHeaderForeground,
	workbenchBackground: workbenchColors.workbenchBackground,
	editorBackground: workbenchColors.editorBackground,
	editorForeground: workbenchColors.editorForeground,
	editorTabBackground: workbenchColors.editorTabBackground,
	titleBarBackground: workbenchColors.titleBarBackground,
	titleBarForeground: workbenchColors.titleBarForeground,
	titleBarActionForeground: workbenchColors.titleBarActionForeground,
	titleBarHoverBackground: workbenchColors.titleBarHoverBackground,
	sideBarBackground: workbenchColors.sideBarBackground,
	auxiliaryBarBackground: workbenchColors.auxiliaryBarBackground,
	panelBackground: workbenchColors.panelBackground,
	compositeBarForeground: workbenchColors.compositeBarForeground,
	compositeBarInactiveForeground: workbenchColors.compositeBarInactiveForeground,
	statusBarForeground: workbenchColors.statusBarForeground,
	statusBarBackground: workbenchColors.statusBarBackground,
	statusBarItemHoverForeground: workbenchColors.statusBarItemHoverForeground,
	statusBarItemHoverBackground: workbenchColors.statusBarItemHoverBackground,
	statusBarItemActiveBackground: workbenchColors.statusBarItemActiveBackground,
	statusBarItemRemoteForeground: workbenchColors.statusBarItemRemoteForeground,
	statusBarItemRemoteBackground: workbenchColors.statusBarItemRemoteBackground,
	statusBarItemRemoteHoverForeground: workbenchColors.statusBarItemRemoteHoverForeground,
	statusBarItemRemoteHoverBackground: workbenchColors.statusBarItemRemoteHoverBackground,
	sashHoverBackground: workbenchColors.sashHoverBackground,
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
