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
	editorCursorForeground: editorColors.cursorForeground,
	editorCursorBackground: editorColors.cursorBackground,
	editorMultiCursorPrimaryForeground: editorColors.multiCursorPrimaryForeground,
	editorMultiCursorPrimaryBackground: editorColors.multiCursorPrimaryBackground,
	editorMultiCursorSecondaryForeground: editorColors.multiCursorSecondaryForeground,
	editorMultiCursorSecondaryBackground: editorColors.multiCursorSecondaryBackground,
	editorOverviewRulerBorder: editorColors.overviewRulerBorder,
	editorOverviewRulerBackground: editorColors.overviewRulerBackground,
	editorLineHighlightBackground: editorColors.lineHighlightBackground,
	editorInactiveLineHighlightBackground: editorColors.inactiveLineHighlightBackground,
	editorLineHighlightBorder: editorColors.lineHighlightBorder,
	editorRulerForeground: editorColors.editorRulerForeground,
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

export const colorIdentifiers: readonly ColorIdentifier[] = Object.freeze(Colors.getColors().map(({ id }) => id));
export const sizeIdentifiers: readonly string[] = Object.freeze(Sizes.getSizes().map(({ id }) => id));
export type ThemeColors = Readonly<Record<ColorIdentifier, string>>;

/** Immutable, fully resolved theme snapshot selected for one frontend host. */
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
}

/** Compiles registry contributions and overrides into an immutable snapshot. */
export function createColorTheme(options: IColorThemeOptions): IColorTheme {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.id)) throw new TypeError(`Invalid color theme ID '${options.id}'`);
	Colors.seal();
	Sizes.seal();
	const colorEntries = Colors.resolve(options.colorScheme, options.colorOverrides);
	const colorMap = new Map(colorEntries.map(({ id, value }) => [id, value] as const));
	const colors = Object.freeze(Object.fromEntries(colorEntries.filter(({ value }) => value !== null).map(({ id, value }) => [id, Color.Format.CSS.formatHexA(value!, true)])));
	const sizeEntries = Object.freeze(Sizes.getSizes().map((entry) => Object.freeze({ ...entry, value: Object.freeze({ ...entry.value }) })));
	const sizeMap = new Map(sizeEntries.map(({ id, value }) => [id, value] as const));
	return Object.freeze({
		id: options.id,
		label: options.label,
		colorScheme: options.colorScheme,
		colors,
		colorEntries,
		sizeEntries,
		getColor: (id: ColorIdentifier) => colorMap.get(id) ?? undefined,
		getColorCss: (id: ColorIdentifier) => {
			const color = colorMap.get(id);
			return color ? Color.Format.CSS.formatHexA(color, true) : undefined;
		},
		getSize: (id: string) => sizeMap.get(id),
	});
}

export const darkColorTheme = createColorTheme({ id: "ash-dark", label: "Ash Dark", colorScheme: ColorScheme.Dark });
export const lightColorTheme = createColorTheme({ id: "ash-light", label: "Ash Light", colorScheme: ColorScheme.Light });
export const highContrastDarkColorTheme = createColorTheme({ id: "ash-high-contrast-dark", label: "Ash High Contrast Dark", colorScheme: ColorScheme.HighContrastDark });
export const highContrastLightColorTheme = createColorTheme({ id: "ash-high-contrast-light", label: "Ash High Contrast Light", colorScheme: ColorScheme.HighContrastLight });
