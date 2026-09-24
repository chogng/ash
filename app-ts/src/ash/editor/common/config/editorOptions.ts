import type { IMarkdownString } from '../../../base/common/htmlContent.js';
import { ScrollbarVisibility } from '../../../base/common/scrollable.js';
import { EDITOR_MODEL_DEFAULTS } from '../core/misc/textModelDefaults.js';
import { AccessibilitySupport } from '../../../platform/accessibility/common/accessibility.js';
import type { IConfigurationPropertySchema } from '../../../platform/configuration/common/configurationRegistry.js';
import { isMacintosh } from '../../../base/common/platform.js';
import { EDITOR_FONT_DEFAULTS, FONT_VARIATION_OFF, FONT_VARIATION_TRANSLATE, FontInfo, GOLDEN_LINE_HEIGHT_RATIO, MINIMUM_LINE_HEIGHT } from './fontInfo.js';

function createDefaultFontInfo(): FontInfo {
	return new FontInfo({
		pixelRatio: 1,
		fontFamily: EDITOR_FONT_DEFAULTS.fontFamily,
		fontWeight: EDITOR_FONT_DEFAULTS.fontWeight,
		fontSize: EDITOR_FONT_DEFAULTS.fontSize,
		fontFeatureSettings: 'normal',
		fontVariationSettings: FONT_VARIATION_OFF,
		lineHeight: Math.max(MINIMUM_LINE_HEIGHT, Math.round(GOLDEN_LINE_HEIGHT_RATIO * EDITOR_FONT_DEFAULTS.fontSize)),
		letterSpacing: EDITOR_FONT_DEFAULTS.letterSpacing,
		isMonospace: true,
		typicalHalfwidthCharacterWidth: 0,
		typicalFullwidthCharacterWidth: 0,
		canUseHalfwidthRightwardsArrow: false,
		spaceWidth: 0,
		middotWidth: 0,
		wsmiddotWidth: 0,
		maxDigitWidth: 0,
	}, false);
}

/** The editor's supported automatic-closing strategies. */
export type EditorAutoClosingStrategy = 'always' | 'languageDefined' | 'beforeWhitespace' | 'never';

/** The editor's supported automatic-surround strategies. */
export type EditorAutoSurroundStrategy = 'languageDefined' | 'quotes' | 'brackets' | 'never';

/** The editor's supported typing-over-closing-pair strategies. */
export type EditorAutoClosingEditStrategy = 'always' | 'auto' | 'never';

/** Controls whether long lines are projected as one row or wrapped rows. */
export enum EditorLineWrapping {
	Off = 'off',
	On = 'on',
}

/** Word-wrap values exposed by the VS Code editor option contract. */
type EditorWordWrap = 'off' | 'on' | 'wordWrapColumn' | 'bounded';

/** The levels supported by the editor's automatic indentation controller. */
export enum EditorAutoIndentStrategy {
	None = 0,
	Keep = 1,
	Brackets = 2,
	Advanced = 3,
	Full = 4,
}

/** User-facing accessibility policy before it is resolved by a host service. */
type EditorAccessibilitySupport = 'auto' | 'off' | 'on';

/** Line-number presentation accepted by the common editor configuration. */
export type LineNumbersType = 'on' | 'off' | 'relative' | 'interval' | ((lineNumber: number) => string);

/** Internal rendering modes used after resolving line-number settings. */
export enum RenderLineNumbersType {
	Off = 0,
	On = 1,
	Relative = 2,
	Interval = 3,
	Custom = 4,
}

export interface InternalEditorRenderLineNumbersOptions {
	readonly renderType: RenderLineNumbersType;
	readonly renderFn: ((lineNumber: number) => string) | null;
}

/** Cursor shapes accepted by the common editor configuration. */
export enum TextEditorCursorStyle {
	Line = 1,
	Block = 2,
	Underline = 3,
	LineThin = 4,
	BlockOutline = 5,
	UnderlineThin = 6,
}

/** Converts the public cursor style string to the internal numeric value. */
export function cursorStyleFromString(cursorStyle: 'line' | 'block' | 'underline' | 'line-thin' | 'block-outline' | 'underline-thin'): TextEditorCursorStyle {
	switch (cursorStyle) {
		case 'line': return TextEditorCursorStyle.Line;
		case 'block': return TextEditorCursorStyle.Block;
		case 'underline': return TextEditorCursorStyle.Underline;
		case 'line-thin': return TextEditorCursorStyle.LineThin;
		case 'block-outline': return TextEditorCursorStyle.BlockOutline;
		case 'underline-thin': return TextEditorCursorStyle.UnderlineThin;
	}
	return TextEditorCursorStyle.Line;
}

/** Converts the internal cursor style to the public configuration string. */
export function cursorStyleToString(cursorStyle: TextEditorCursorStyle): 'line' | 'block' | 'underline' | 'line-thin' | 'block-outline' | 'underline-thin' {
	switch (cursorStyle) {
		case TextEditorCursorStyle.Line: return 'line';
		case TextEditorCursorStyle.Block: return 'block';
		case TextEditorCursorStyle.Underline: return 'underline';
		case TextEditorCursorStyle.LineThin: return 'line-thin';
		case TextEditorCursorStyle.BlockOutline: return 'block-outline';
		case TextEditorCursorStyle.UnderlineThin: return 'underline-thin';
	}
}

/** Converts the public cursor blinking string to the internal numeric value. */
export function cursorBlinkingStyleFromString(cursorBlinkingStyle: 'blink' | 'smooth' | 'phase' | 'expand' | 'solid'): TextEditorCursorBlinkingStyle {
	switch (cursorBlinkingStyle) {
		case 'blink': return TextEditorCursorBlinkingStyle.Blink;
		case 'smooth': return TextEditorCursorBlinkingStyle.Smooth;
		case 'phase': return TextEditorCursorBlinkingStyle.Phase;
		case 'expand': return TextEditorCursorBlinkingStyle.Expand;
		case 'solid': return TextEditorCursorBlinkingStyle.Solid;
	}
	return TextEditorCursorBlinkingStyle.Blink;
}

/** Cursor animation modes used by the VS Code editor option contract. */
export enum TextEditorCursorBlinkingStyle {
	Hidden = 0,
	Blink = 1,
	Smooth = 2,
	Phase = 3,
	Expand = 4,
	Solid = 5,
}

/** Minimap rendering modes used by layout consumers. */
export enum RenderMinimap {
	None = 0,
	Text = 1,
	Blocks = 2,
}

/** Width of the minimap gutter in pixels. */
export const MINIMAP_GUTTER_WIDTH = 8;

/** Position and size of the overview ruler. */
export interface OverviewRulerPosition {
	readonly width: number;
	readonly height: number;
	readonly top: number;
	readonly right: number;
}

/** Calculated minimap geometry. */
export interface EditorMinimapLayoutInfo {
	readonly renderMinimap: RenderMinimap;
	readonly minimapLeft: number;
	readonly minimapWidth: number;
	readonly minimapHeightIsEditorHeight: boolean;
	readonly minimapIsSampling: boolean;
	readonly minimapScale: number;
	readonly minimapLineHeight: number;
	readonly minimapCanvasInnerWidth: number;
	readonly minimapCanvasInnerHeight: number;
	readonly minimapCanvasOuterWidth: number;
	readonly minimapCanvasOuterHeight: number;
}

/** Calculated editor column and viewport geometry. */
export interface EditorLayoutInfo {
	readonly width: number;
	readonly height: number;
	readonly glyphMarginLeft: number;
	readonly glyphMarginWidth: number;
	readonly glyphMarginDecorationLaneCount: number;
	readonly lineNumbersLeft: number;
	readonly lineNumbersWidth: number;
	readonly decorationsLeft: number;
	readonly decorationsWidth: number;
	readonly contentLeft: number;
	readonly contentWidth: number;
	readonly minimap: EditorMinimapLayoutInfo;
	readonly viewportColumn: number;
	readonly isWordWrapMinified: boolean;
	readonly isViewportWrapping: boolean;
	readonly wrappingColumn: number;
	readonly verticalScrollbarWidth: number;
	readonly horizontalScrollbarHeight: number;
	readonly overviewRuler: OverviewRulerPosition;
}

/** Inputs used by the layout computer and its host adapter. */
export interface EditorLayoutInfoComputerEnv {
	readonly memory: ComputeOptionsMemory | null;
	readonly outerWidth: number;
	readonly outerHeight: number;
	readonly isDominatedByLongLines: boolean;
	readonly lineHeight: number;
	readonly viewLineCount: number;
	readonly lineNumbersDigitCount: number;
	readonly typicalHalfwidthCharacterWidth: number;
	readonly maxDigitWidth: number;
	readonly pixelRatio: number;
	readonly glyphMarginDecorationLaneCount: number;
}

export interface IEditorLayoutComputerInput {
	readonly outerWidth: number;
	readonly outerHeight: number;
	readonly isDominatedByLongLines: boolean;
	readonly lineHeight: number;
	readonly lineNumbersDigitCount: number;
	readonly typicalHalfwidthCharacterWidth: number;
	readonly maxDigitWidth: number;
	readonly pixelRatio: number;
	readonly glyphMargin: boolean;
	readonly lineDecorationsWidth: string | number;
	readonly folding: boolean;
	readonly minimap: Readonly<Required<IEditorMinimapOptions>>;
	readonly scrollbar: InternalEditorScrollbarOptions;
	readonly lineNumbers: InternalEditorRenderLineNumbersOptions;
	readonly lineNumbersMinChars: number;
	readonly scrollBeyondLastLine: boolean;
	readonly wordWrap: 'wordWrapColumn' | 'on' | 'off' | 'bounded';
	readonly wordWrapColumn: number;
	readonly wordWrapMinified: boolean;
	readonly accessibilitySupport: AccessibilitySupport;
}

export interface IMinimapLayoutInput {
	readonly outerWidth: number;
	readonly outerHeight: number;
	readonly lineHeight: number;
	readonly typicalHalfwidthCharacterWidth: number;
	readonly pixelRatio: number;
	readonly scrollBeyondLastLine: boolean;
	readonly paddingTop: number;
	readonly paddingBottom: number;
	readonly minimap: Readonly<Required<IEditorMinimapOptions>>;
	readonly verticalScrollbarWidth: number;
	readonly viewLineCount: number;
	readonly remainingWidth: number;
	readonly isViewportWrapping: boolean;
}

/** Calculated wrapping state shared by viewport consumers. */
export interface EditorWrappingInfo {
	readonly isDominatedByLongLines: boolean;
	readonly isWordWrapMinified: boolean;
	readonly isViewportWrapping: boolean;
	readonly wrappingColumn: number;
}

/** Indentation applied to continuation rows created by word wrapping. */
export enum WrappingIndent {
	None = 0,
	Same = 1,
	Indent = 2,
	DeepIndent = 3,
}

export function isWrappingIndent(value: unknown): value is WrappingIndent {
	return value === WrappingIndent.None
		|| value === WrappingIndent.Same
		|| value === WrappingIndent.Indent
		|| value === WrappingIndent.DeepIndent;
}

/** Code-action lightbulb presentation modes. */
export enum ShowLightbulbIconMode {
	Off = 'off',
	OnCode = 'onCode',
	On = 'on',
}

/** Quick-suggestion policy accepted by the editor options contract. */
export type QuickSuggestionsValue = 'on' | 'inline' | 'off' | 'offWhenInlineCompletions';

/** Mouse action used for opening links from the editor. */
export type MouseMiddleClickAction = 'default' | 'openLink' | 'ctrlLeftClick';

/** Resolved modifier used by the editor's multi-cursor mouse gestures. */
export type EditorMultiCursorModifier = 'altKey' | 'metaKey' | 'ctrlKey';

/** Navigation behavior when a language feature returns multiple locations. */
export type GoToLocationValues = 'peek' | 'gotoAndPeek' | 'goto';

/** Raw options for the editor's Find widget. */
export interface IEditorFindOptions {
	readonly cursorMoveOnType?: boolean;
	readonly findOnType?: boolean;
	readonly seedSearchStringFromSelection?: 'never' | 'always' | 'selection';
	readonly autoFindInSelection?: 'never' | 'always' | 'multiline';
	readonly addExtraSpaceOnTop?: boolean;
	readonly globalFindClipboard?: boolean;
	readonly loop?: boolean;
	readonly closeOnResult?: boolean;
	readonly history?: 'never' | 'workspace';
	readonly replaceHistory?: 'never' | 'workspace';
}

/** Normalized options for the editor's Find widget. */
export type EditorFindOptions = Readonly<Required<IEditorFindOptions>>;

/** Raw minimap options understood by the common editor configuration. */
export interface IEditorMinimapOptions {
	readonly enabled?: boolean;
	readonly autohide?: 'none' | 'mouseover' | 'scroll';
	readonly side?: 'right' | 'left';
	readonly size?: 'proportional' | 'fill' | 'fit';
	readonly renderCharacters?: boolean;
	readonly showSlider?: 'always' | 'mouseover';
	readonly maxColumn?: number;
	readonly scale?: number;
	readonly showRegionSectionHeaders?: boolean;
	readonly showMarkSectionHeaders?: boolean;
	readonly markSectionHeaderRegex?: string;
	readonly sectionHeaderFontSize?: number;
	readonly sectionHeaderLetterSpacing?: number;
}

/** Normalized minimap options. */
export type EditorMinimapOptions = Readonly<Required<IEditorMinimapOptions>>;

/** Raw scrollbar options understood by the common editor configuration. */
export interface IEditorScrollbarOptions {
	readonly arrowSize?: number;
	readonly vertical?: 'auto' | 'visible' | 'hidden';
	readonly horizontal?: 'auto' | 'visible' | 'hidden';
	readonly useShadows?: boolean;
	readonly verticalHasArrows?: boolean;
	readonly horizontalHasArrows?: boolean;
	readonly handleMouseWheel?: boolean;
	readonly alwaysConsumeMouseWheel?: boolean;
	readonly verticalScrollbarSize?: number;
	readonly horizontalScrollbarSize?: number;
	readonly verticalSliderSize?: number;
	readonly horizontalSliderSize?: number;
	readonly scrollByPage?: boolean;
	readonly ignoreHorizontalScrollbarInContentHeight?: boolean;
}

/** Normalized scrollbar options. */
type EditorScrollbarOptions = InternalEditorScrollbarOptions;

/** Resolved scrollbar options used by layout calculations. */
export interface InternalEditorScrollbarOptions {
	readonly arrowSize: number;
	readonly vertical: ScrollbarVisibility;
	readonly horizontal: ScrollbarVisibility;
	readonly useShadows: boolean;
	readonly verticalHasArrows: boolean;
	readonly horizontalHasArrows: boolean;
	readonly handleMouseWheel: boolean;
	readonly alwaysConsumeMouseWheel: boolean;
	readonly horizontalScrollbarSize: number;
	readonly horizontalSliderSize: number;
	readonly verticalScrollbarSize: number;
	readonly verticalSliderSize: number;
	readonly scrollByPage: boolean;
	readonly ignoreHorizontalScrollbarInContentHeight: boolean;
}

/** Raw sticky-scroll options understood by the common editor configuration. */
export interface IEditorStickyScrollOptions {
	readonly enabled?: boolean;
	readonly defaultModel?: 'outlineModel' | 'foldingProviderModel' | 'indentationModel';
	readonly maxLineCount?: number;
	readonly scrollWithEditor?: boolean;
}

/** Normalized sticky-scroll options. */
export type EditorStickyScrollOptions = Readonly<Required<IEditorStickyScrollOptions>>;

/** Raw bracket-pair colorization options. */
export interface IBracketPairColorizationOptions {
	readonly enabled?: boolean;
	readonly independentColorPoolPerBracketType?: boolean;
}

/** Normalized bracket-pair colorization options. */
type BracketPairColorizationOptions = Readonly<Required<IBracketPairColorizationOptions>>;

export type InternalBracketPairColorizationOptions = Readonly<Required<IBracketPairColorizationOptions>>;

/** A vertical ruler declaration. */
export interface IRulerOption {
	readonly column: number;
	readonly color: string | null;
}

/** Configuration options for editor comments. */
export interface IEditorCommentsOptions {
	readonly insertSpace?: boolean;
	readonly ignoreEmptyLines?: boolean;
}

export type EditorCommentsOptions = Readonly<Required<IEditorCommentsOptions>>;

/** Configuration options for editor hover behavior. */
export interface IEditorHoverOptions {
	readonly enabled?: 'on' | 'off' | 'onKeyboardModifier';
	readonly delay?: number;
	readonly sticky?: boolean;
	readonly hidingDelay?: number;
	readonly above?: boolean;
	readonly showLongLineWarning?: boolean;
}

export type EditorHoverOptions = Readonly<Required<IEditorHoverOptions>>;

/** Configuration options for the editor code-action lightbulb. */
export interface IEditorLightbulbOptions {
	readonly enabled?: ShowLightbulbIconMode;
}

export type EditorLightbulbOptions = Readonly<Required<IEditorLightbulbOptions>>;

/** Configuration options for inline hints. */
export interface IEditorInlayHintsOptions {
	readonly enabled?: 'on' | 'off' | 'offUnlessPressed' | 'onUnlessPressed';
	readonly fontSize?: number;
	readonly fontFamily?: string;
	readonly padding?: boolean;
	readonly maximumLength?: number;
}

export type EditorInlayHintsOptions = Readonly<Required<IEditorInlayHintsOptions>>;

/** Spacing between the editor viewport and its first/last line. */
export interface IEditorPaddingOptions {
	readonly top?: number;
	readonly bottom?: number;
}

export type InternalEditorPaddingOptions = Readonly<Required<IEditorPaddingOptions>>;

/** Parameter-hint widget options. */
export interface IEditorParameterHintOptions {
	readonly enabled?: boolean;
	readonly cycle?: boolean;
}

export type InternalParameterHintOptions = Readonly<Required<IEditorParameterHintOptions>>;

/** Quick-suggestion policy for normal text, comments, and strings. */
export interface IQuickSuggestionsOptions {
	readonly other?: boolean | QuickSuggestionsValue;
	readonly comments?: boolean | QuickSuggestionsValue;
	readonly strings?: boolean | QuickSuggestionsValue;
}

export interface InternalQuickSuggestionsOptions {
	readonly other: QuickSuggestionsValue;
	readonly comments: QuickSuggestionsValue;
	readonly strings: QuickSuggestionsValue;
}

/** Navigation behavior when a language feature returns multiple locations. */
export interface IGotoLocationOptions {
	readonly multiple?: GoToLocationValues;
	readonly multipleDefinitions?: GoToLocationValues;
	readonly multipleTypeDefinitions?: GoToLocationValues;
	readonly multipleDeclarations?: GoToLocationValues;
	readonly multipleImplementations?: GoToLocationValues;
	readonly multipleReferences?: GoToLocationValues;
	readonly multipleTests?: GoToLocationValues;
	readonly alternativeDefinitionCommand?: string;
	readonly alternativeTypeDefinitionCommand?: string;
	readonly alternativeDeclarationCommand?: string;
	readonly alternativeImplementationCommand?: string;
	readonly alternativeReferenceCommand?: string;
	readonly alternativeTestsCommand?: string;
}

export type GoToLocationOptions = Readonly<Required<IGotoLocationOptions>>;

/** Editor guide rendering options. */
export interface IGuidesOptions {
	readonly bracketPairs?: boolean | 'active';
	readonly bracketPairsHorizontal?: boolean | 'active';
	readonly highlightActiveBracketPair?: boolean;
	readonly indentation?: boolean;
	readonly highlightActiveIndentation?: boolean | 'always';
}

export type InternalGuidesOptions = Readonly<Required<IGuidesOptions>>;

/** Unicode-confusable and invisible-character highlighting options. */
export interface IUnicodeHighlightOptions {
	readonly nonBasicASCII?: boolean | ForUntrustedContent;
	readonly invisibleCharacters?: boolean;
	readonly ambiguousCharacters?: boolean;
	readonly includeComments?: boolean | ForUntrustedContent;
	readonly includeStrings?: boolean | ForUntrustedContent;
	readonly allowedCharacters?: Record<string, true>;
	readonly allowedLocales?: Record<string | '_os' | '_vscode', true>;
}

export type InternalUnicodeHighlightOptions = Required<Readonly<IUnicodeHighlightOptions>>;

export type ForUntrustedContent = 'forUntrustedContent';
export const forUntrustedContent: ForUntrustedContent = 'forUntrustedContent';

/** Stable configuration keys used by Unicode highlighting consumers. */
export const unicodeHighlightConfigKeys = Object.freeze({
	allowedCharacters: 'editor.unicodeHighlight.allowedCharacters',
	invisibleCharacters: 'editor.unicodeHighlight.invisibleCharacters',
	nonBasicASCII: 'editor.unicodeHighlight.nonBasicASCII',
	ambiguousCharacters: 'editor.unicodeHighlight.ambiguousCharacters',
	includeComments: 'editor.unicodeHighlight.includeComments',
	includeStrings: 'editor.unicodeHighlight.includeStrings',
	allowedLocales: 'editor.unicodeHighlight.allowedLocales',
});

/** Inline completion rendering options. */
export interface IInlineSuggestOptions {
	readonly enabled?: boolean;
	readonly mode?: 'prefix' | 'subword' | 'subwordSmart';
	readonly showToolbar?: 'always' | 'onHover' | 'never';
	readonly suppressSuggestions?: boolean;
	readonly keepOnBlur?: boolean;
	readonly syntaxHighlightingEnabled?: boolean;
	readonly minShowDelay?: number;
	readonly suppressInSnippetMode?: boolean;
	readonly fontFamily?: string | 'default';
	readonly edits?: {
		allowCodeShifting?: 'always' | 'horizontal' | 'never';
		renderSideBySide?: 'never' | 'auto';
		showCollapsed?: boolean;
		showLongDistanceHint?: boolean;
		/**
		 * Controls how many lines of surrounding context are shown above and below the target line
		 * in the long distance inline suggestion hint preview. `0` shows only the target line.
		 */
		longDistanceHintContextLineCount?: number;
		/**
		* @internal
		*/
		enabled?: boolean;
	};
	readonly triggerCommandOnProviderChange?: boolean;
	readonly experimental?: {
		/**
		* @internal
		*/
		suppressInlineSuggestions?: string;
		/**
		* @internal
		*/
		emptyResponseInformation?: boolean;
		showOnSuggestConflict?: 'always' | 'never' | 'whenSuggestListIsIncomplete';
	};
}

type RequiredRecursive<T> = {
	[P in keyof T]-?: T[P] extends object | undefined ? RequiredRecursive<T[P]> : T[P];
};

export type InternalInlineSuggestOptions = Readonly<RequiredRecursive<IInlineSuggestOptions>>;

/** Suggest widget options. The nested shape intentionally remains host-neutral. */
export interface ISuggestOptions {
	readonly insertMode?: 'insert' | 'replace';
	readonly filterGraceful?: boolean;
	readonly snippetsPreventQuickSuggestions?: boolean;
	readonly localityBonus?: boolean;
	readonly shareSuggestSelections?: boolean;
	readonly selectionMode?: 'always' | 'never' | 'whenTriggerCharacter' | 'whenQuickSuggestion';
	readonly showIcons?: boolean;
	readonly showStatusBar?: boolean;
	readonly preview?: boolean;
	readonly previewMode?: 'prefix' | 'subword' | 'subwordSmart';
	readonly showInlineDetails?: boolean;
	readonly fitWidthToDetails?: boolean;
	readonly matchOnWordStartOnly?: boolean;
	readonly showMethods?: boolean;
	readonly showFunctions?: boolean;
	readonly showConstructors?: boolean;
	readonly showDeprecated?: boolean;
	readonly showFields?: boolean;
	readonly showVariables?: boolean;
	readonly showClasses?: boolean;
	readonly showStructs?: boolean;
	readonly showInterfaces?: boolean;
	readonly showModules?: boolean;
	readonly showProperties?: boolean;
	readonly showEvents?: boolean;
	readonly showOperators?: boolean;
	readonly showUnits?: boolean;
	readonly showValues?: boolean;
	readonly showConstants?: boolean;
	readonly showEnums?: boolean;
	readonly showEnumMembers?: boolean;
	readonly showKeywords?: boolean;
	readonly showWords?: boolean;
	readonly showColors?: boolean;
	readonly showFiles?: boolean;
	readonly showReferences?: boolean;
	readonly showFolders?: boolean;
	readonly showTypeParameters?: boolean;
	readonly showIssues?: boolean;
	readonly showUsers?: boolean;
	readonly showSnippets?: boolean;
}

export type InternalSuggestOptions = Readonly<Required<ISuggestOptions>>;

/** Smart-select options. */
export interface ISmartSelectOptions {
	readonly selectLeadingAndTrailingWhitespace?: boolean;
	readonly selectSubwords?: boolean;
}

export type SmartSelectOptions = Readonly<Required<ISmartSelectOptions>>;

/** Options for dropping external content into an editor. */
export interface IDropIntoEditorOptions {
	readonly enabled?: boolean;
	readonly showDropSelector?: 'afterDrop' | 'never';
}

export type EditorDropIntoEditorOptions = Readonly<Required<IDropIntoEditorOptions>>;

/** Options for the editor's paste-as selector. */
export interface IPasteAsOptions {
	readonly enabled?: boolean;
	readonly showPasteSelector?: 'afterPaste' | 'never';
}

export type EditorPasteAsOptions = Readonly<Required<IPasteAsOptions>>;

/** Raw editor options shared by browser and non-browser consumers. */
export interface IEditorOptions {
	readonly inDiffEditor?: boolean;
	readonly allowVariableLineHeights?: boolean;
	readonly allowVariableFonts?: boolean;
	readonly allowVariableFontsInAccessibilityMode?: boolean;
	readonly ariaLabel?: string;
	readonly ariaRequired?: boolean;
	readonly screenReaderAnnounceInlineSuggestion?: boolean;
	readonly tabIndex?: number;
	readonly rulers?: (number | IRulerOption)[];
	readonly wordSegmenterLocales?: string | string[];
	readonly wordSeparators?: string;
	readonly selectionClipboard?: boolean;
	readonly cursorSurroundingLines?: number;
	readonly cursorSurroundingLinesStyle?: 'default' | 'all';
	readonly renderFinalNewline?: 'on' | 'off' | 'dimmed';
	readonly unusualLineTerminators?: 'auto' | 'off' | 'prompt';
	readonly selectOnLineNumbers?: boolean;
	readonly lineNumbersMinChars?: number;
	readonly lineDecorationsWidth?: number | string;
	readonly revealHorizontalRightPadding?: number;
	readonly roundedSelection?: boolean;
	readonly readOnly?: boolean;
	readonly readOnlyMessage?: IMarkdownString;
	readonly domReadOnly?: boolean;
	readonly linkedEditing?: boolean;
	readonly renameOnType?: boolean;
	readonly renderValidationDecorations?: 'editable' | 'on' | 'off';
	readonly fixedOverflowWidgets?: boolean;
	readonly allowOverflow?: boolean;
	readonly overviewRulerLanes?: number;
	readonly overviewRulerBorder?: boolean;
	readonly cursorBlinking?: 'blink' | 'smooth' | 'phase' | 'expand' | 'solid';
	readonly mouseWheelZoom?: boolean;
	readonly mouseStyle?: 'text' | 'default' | 'copy';
	readonly cursorSmoothCaretAnimation?: 'off' | 'explicit' | 'on';
	readonly fontFamily?: string;
	readonly fontWeight?: string;
	readonly fontSize?: number;
	readonly fontLigatures?: boolean | string;
	readonly fontVariations?: boolean | string;
	readonly lineHeight?: number;
	readonly letterSpacing?: number;
	readonly defaultColorDecorators?: 'auto' | 'always' | 'never';
	readonly disableLayerHinting?: boolean;
	readonly disableMonospaceOptimizations?: boolean;
	readonly hideCursorInOverviewRuler?: boolean;
	readonly scrollBeyondLastLine?: boolean;
	readonly scrollOnMiddleClick?: boolean;
	readonly scrollBeyondLastColumn?: number;
	readonly smoothScrolling?: boolean;
	readonly automaticLayout?: boolean;
	readonly wordWrap?: 'off' | 'on' | 'wordWrapColumn' | 'bounded';
	readonly wordWrapOverride1?: 'off' | 'on' | 'inherit';
	readonly wordWrapOverride2?: 'off' | 'on' | 'inherit';
	readonly wordWrapColumn?: number;
	readonly wrappingIndent?: 'none' | 'same' | 'indent' | 'deepIndent';
	readonly wrappingStrategy?: 'simple' | 'advanced';
	readonly wrapOnEscapedLineFeeds?: boolean;
	readonly wordWrapBreakBeforeCharacters?: string;
	readonly wordWrapBreakAfterCharacters?: string;
	readonly wordBreak?: 'normal' | 'keepAll';
	readonly stopRenderingLineAfter?: number;
	readonly hover?: IEditorHoverOptions;
	readonly links?: boolean;
	readonly colorDecorators?: boolean;
	readonly colorDecoratorsActivatedOn?: 'clickAndHover' | 'click' | 'hover';
	readonly colorDecoratorsLimit?: number;
	readonly comments?: IEditorCommentsOptions;
	readonly contextmenu?: boolean;
	readonly mouseWheelScrollSensitivity?: number;
	readonly fastScrollSensitivity?: number;
	readonly scrollPredominantAxis?: boolean;
	readonly inertialScroll?: boolean;
	readonly columnSelection?: boolean;
	readonly multiCursorModifier?: 'ctrlCmd' | 'alt';
	readonly multiCursorMergeOverlapping?: boolean;
	readonly multiCursorPaste?: 'spread' | 'full';
	readonly multiCursorLimit?: number;
	readonly mouseMiddleClickAction?: MouseMiddleClickAction;
	readonly lineNumbers?: LineNumbersType;
	readonly glyphMargin?: boolean;
	readonly minimap?: IEditorMinimapOptions;
	readonly scrollbar?: IEditorScrollbarOptions;
	readonly stickyScroll?: IEditorStickyScrollOptions;
	readonly find?: IEditorFindOptions;
	readonly bracketPairColorization?: IBracketPairColorizationOptions;
	readonly accessibilitySupport?: 'auto' | 'off' | 'on';
	readonly accessibilityPageSize?: number;
	readonly suggest?: ISuggestOptions;
	readonly smartSelect?: ISmartSelectOptions;
	readonly gotoLocation?: IGotoLocationOptions;
	readonly quickSuggestions?: boolean | QuickSuggestionsValue | IQuickSuggestionsOptions;
	readonly quickSuggestionsDelay?: number;
	readonly padding?: IEditorPaddingOptions;
	readonly parameterHints?: IEditorParameterHintOptions;
	readonly autoClosingBrackets?: EditorAutoClosingStrategy;
	readonly autoClosingComments?: EditorAutoClosingStrategy;
	readonly autoClosingQuotes?: EditorAutoClosingStrategy;
	readonly autoClosingDelete?: EditorAutoClosingEditStrategy;
	readonly autoClosingOvertype?: EditorAutoClosingEditStrategy;
	readonly autoSurround?: EditorAutoSurroundStrategy;
	readonly autoIndent?: 'none' | 'keep' | 'brackets' | 'advanced' | 'full';
	readonly autoIndentOnPaste?: boolean;
	readonly autoIndentOnPasteWithinString?: boolean;
	readonly stickyTabStops?: boolean;
	readonly formatOnType?: boolean;
	readonly formatOnPaste?: boolean;
	readonly doubleClickSelectsBlock?: boolean;
	readonly dragAndDrop?: boolean;
	readonly suggestOnTriggerCharacters?: boolean;
	readonly acceptSuggestionOnEnter?: 'on' | 'smart' | 'off';
	readonly acceptSuggestionOnCommitCharacter?: boolean;
	readonly snippetSuggestions?: 'top' | 'bottom' | 'inline' | 'none';
	readonly emptySelectionClipboard?: boolean;
	readonly copyWithSyntaxHighlighting?: boolean;
	readonly suggestSelection?: 'first' | 'recentlyUsed' | 'recentlyUsedByPrefix';
	readonly suggestFontSize?: number;
	readonly suggestLineHeight?: number;
	readonly tabCompletion?: 'on' | 'off' | 'onlySnippets';
	readonly selectionHighlight?: boolean;
	readonly selectionHighlightMultiline?: boolean;
	readonly selectionHighlightMaxLength?: number;
	readonly occurrencesHighlight?: 'off' | 'singleFile' | 'multiFile';
	readonly occurrencesHighlightDelay?: number;
	readonly codeLensFontFamily?: string;
	readonly codeLensFontSize?: number;
	readonly lightbulb?: IEditorLightbulbOptions;
	readonly codeActionsOnSaveTimeout?: number;
	readonly foldingStrategy?: 'auto' | 'indentation';
	readonly foldingHighlight?: boolean;
	readonly foldingImportsByDefault?: boolean;
	readonly foldingMaximumRegions?: number;
	readonly showFoldingControls?: 'always' | 'never' | 'mouseover';
	readonly unfoldOnClickAfterEndOfLine?: boolean;
	readonly matchBrackets?: 'never' | 'near' | 'always';
	readonly experimentalGpuAcceleration?: 'on' | 'off';
	readonly experimentalWhitespaceRendering?: 'svg' | 'font' | 'off';
	readonly renderWhitespace?: 'none' | 'boundary' | 'selection' | 'trailing' | 'all';
	readonly renderControlCharacters?: boolean;
	readonly renderLineHighlight?: 'none' | 'gutter' | 'line' | 'all';
	readonly renderLineHighlightOnlyWhenFocus?: boolean;
	readonly useTabStops?: boolean;
	readonly trimWhitespaceOnDelete?: boolean;
	readonly showUnused?: boolean;
	readonly peekWidgetDefaultFocus?: 'tree' | 'editor';
	readonly placeholder?: string | undefined;
	readonly definitionLinkOpensInPeek?: boolean;
	readonly showDeprecated?: boolean;
	readonly matchOnWordStartOnly?: boolean;
	readonly inlayHints?: IEditorInlayHintsOptions;
	readonly useShadowDOM?: boolean;
	readonly guides?: IGuidesOptions;
	readonly unicodeHighlight?: IUnicodeHighlightOptions;
	readonly dropIntoEditor?: IDropIntoEditorOptions;
	readonly editContext?: boolean;
	readonly renderRichScreenReaderContent?: boolean;
	readonly pasteAs?: IPasteAsOptions;
	readonly tabFocusMode?: boolean;
	readonly inlineCompletionsAccessibilityVerbose?: boolean;
	readonly extraEditorClassName?: string;
	readonly cursorStyle?: 'line' | 'block' | 'underline' | 'line-thin' | 'block-outline' | 'underline-thin';
	readonly overtypeCursorStyle?: 'line' | 'block' | 'underline' | 'line-thin' | 'block-outline' | 'underline-thin';
	readonly overtypeOnPaste?: boolean;
	readonly cursorWidth?: number;
	readonly cursorHeight?: number;
	readonly codeLens?: boolean;
	readonly folding?: boolean;
	readonly inlineSuggest?: IInlineSuggestOptions;
}

/** Diff-specific options shared by the diff editor and its host. */
export interface IDiffEditorBaseOptions {
	readonly enableSplitViewResizing?: boolean;
	readonly splitViewDefaultRatio?: number;
	readonly renderSideBySide?: boolean;
	readonly renderSideBySideInlineBreakpoint?: number | undefined;
	readonly useInlineViewWhenSpaceIsLimited?: boolean;
	readonly compactMode?: boolean;
	readonly hideOriginalLineNumbers?: boolean;
	readonly maxComputationTime?: number;
	readonly maxFileSize?: number;
	readonly ignoreTrimWhitespace?: boolean;
	readonly renderIndicators?: boolean;
	readonly renderMarginRevertIcon?: boolean;
	readonly renderGutterMenu?: boolean;
	readonly originalEditable?: boolean;
	readonly diffCodeLens?: boolean;
	readonly renderOverviewRuler?: boolean;
	readonly diffWordWrap?: 'off' | 'on' | 'inherit';
	readonly diffAlgorithm?: 'legacy' | 'advanced' | 'advanced-external' | 'advanced-wasm';
	readonly accessibilityVerbose?: boolean;
	readonly experimental?: {
		/**
		 * Defaults to false.
		 */
		showMoves?: boolean;
		showEmptyDecorations?: boolean;
		/**
		 * Only applies when `renderSideBySide` is set to false.
		*/
		useTrueInlineView?: boolean;
	};
	readonly isInEmbeddedEditor?: boolean;
	readonly onlyShowAccessibleDiffViewer?: boolean;
	readonly hideUnchangedRegions?: {
		enabled?: boolean;
		revealLineCount?: number;
		minimumLineCount?: number;
		contextLineCount?: number;
	};
}

/** Complete options accepted by a diff editor. */
export interface IDiffEditorOptions extends IEditorOptions, IDiffEditorBaseOptions {}

/** Diff options after all top-level defaults have been applied. */
export type ValidDiffEditorBaseOptions = Readonly<Required<IDiffEditorBaseOptions>>;

/** Identifies one computed option in the common editor option registry.
 *
 * The first block intentionally follows VS Code's ordering. The final four
 * entries are retained for older Ash Workbench settings that are not editor
 * options in upstream VS Code.
 */
export enum EditorOption {
	acceptSuggestionOnCommitCharacter,
	acceptSuggestionOnEnter,
	accessibilitySupport,
	accessibilityPageSize,
	allowOverflow,
	allowVariableLineHeights,
	allowVariableFonts,
	allowVariableFontsInAccessibilityMode,
	ariaLabel,
	ariaRequired,
	autoClosingBrackets,
	autoClosingComments,
	screenReaderAnnounceInlineSuggestion,
	autoClosingDelete,
	autoClosingOvertype,
	autoClosingQuotes,
	autoIndent,
	autoIndentOnPaste,
	autoIndentOnPasteWithinString,
	automaticLayout,
	autoSurround,
	bracketPairColorization,
	guides,
	codeLens,
	codeLensFontFamily,
	codeLensFontSize,
	colorDecorators,
	colorDecoratorsLimit,
	columnSelection,
	comments,
	contextmenu,
	copyWithSyntaxHighlighting,
	cursorBlinking,
	cursorSmoothCaretAnimation,
	cursorStyle,
	cursorSurroundingLines,
	cursorSurroundingLinesStyle,
	cursorWidth,
	cursorHeight,
	disableLayerHinting,
	disableMonospaceOptimizations,
	domReadOnly,
	dragAndDrop,
	dropIntoEditor,
	editContext,
	emptySelectionClipboard,
	experimentalGpuAcceleration,
	experimentalWhitespaceRendering,
	extraEditorClassName,
	fastScrollSensitivity,
	find,
	fixedOverflowWidgets,
	folding,
	foldingStrategy,
	foldingHighlight,
	foldingImportsByDefault,
	foldingMaximumRegions,
	unfoldOnClickAfterEndOfLine,
	fontFamily,
	fontInfo,
	fontLigatures,
	fontSize,
	fontWeight,
	fontVariations,
	formatOnPaste,
	formatOnType,
	glyphMargin,
	gotoLocation,
	hideCursorInOverviewRuler,
	hover,
	inDiffEditor,
	inlineSuggest,
	letterSpacing,
	lightbulb,
	lineDecorationsWidth,
	lineHeight,
	lineNumbers,
	lineNumbersMinChars,
	linkedEditing,
	links,
	matchBrackets,
	minimap,
	mouseStyle,
	mouseWheelScrollSensitivity,
	mouseWheelZoom,
	multiCursorMergeOverlapping,
	multiCursorModifier,
	mouseMiddleClickAction,
	multiCursorPaste,
	multiCursorLimit,
	occurrencesHighlight,
	occurrencesHighlightDelay,
	overtypeCursorStyle,
	overtypeOnPaste,
	overviewRulerBorder,
	overviewRulerLanes,
	padding,
	pasteAs,
	parameterHints,
	peekWidgetDefaultFocus,
	placeholder,
	definitionLinkOpensInPeek,
	quickSuggestions,
	quickSuggestionsDelay,
	readOnly,
	readOnlyMessage,
	renameOnType,
	renderRichScreenReaderContent,
	renderControlCharacters,
	renderFinalNewline,
	renderLineHighlight,
	renderLineHighlightOnlyWhenFocus,
	renderValidationDecorations,
	renderWhitespace,
	revealHorizontalRightPadding,
	roundedSelection,
	rulers,
	scrollbar,
	scrollBeyondLastColumn,
	scrollBeyondLastLine,
	scrollPredominantAxis,
	selectionClipboard,
	selectionHighlight,
	selectionHighlightMaxLength,
	selectionHighlightMultiline,
	selectOnLineNumbers,
	showFoldingControls,
	showUnused,
	snippetSuggestions,
	smartSelect,
	smoothScrolling,
	stickyScroll,
	stickyTabStops,
	stopRenderingLineAfter,
	suggest,
	suggestFontSize,
	suggestLineHeight,
	suggestOnTriggerCharacters,
	suggestSelection,
	tabCompletion,
	tabIndex,
	trimWhitespaceOnDelete,
	unicodeHighlighting,
	unusualLineTerminators,
	useShadowDOM,
	useTabStops,
	wordBreak,
	wordSegmenterLocales,
	wordSeparators,
	wordWrap,
	wordWrapBreakAfterCharacters,
	wordWrapBreakBeforeCharacters,
	wordWrapColumn,
	wordWrapOverride1,
	wordWrapOverride2,
	wrappingIndent,
	wrappingStrategy,
	showDeprecated,
	inertialScroll,
	inlayHints,
	wrapOnEscapedLineFeeds,
	// Leave these at the end because they have dependencies in upstream VS Code.
	effectiveCursorStyle,
	editorClassName,
	pixelRatio,
	tabFocusMode,
	layoutInfo,
	wrappingInfo,
	defaultColorDecorators,
	colorDecoratorsActivatedOn,
	inlineCompletionsAccessibilityVerbose,
	effectiveEditContext,
	scrollOnMiddleClick,
	effectiveAllowVariableFonts,
	doubleClickSelectsBlock,
}

/** Stable memory used by computed layout options between recomputations. */
export class ComputeOptionsMemory {
	public stableMinimapLayoutInput: IMinimapLayoutInput | null = null;
	public stableFitMaxMinimapScale: number = 0;
	public stableFitRemainingWidth: number = 0;

	constructor() { }
}

/** Inputs that can affect option computation without importing browser APIs. */
export interface IEnvironmentalOptions {
	readonly memory: ComputeOptionsMemory | null;
	readonly outerWidth: number;
	readonly outerHeight: number;
	readonly fontInfo: FontInfo;
	readonly extraEditorClassName: string;
	readonly isDominatedByLongLines: boolean;
	readonly viewLineCount: number;
	readonly lineNumbersDigitCount: number;
	readonly emptySelectionClipboard: boolean;
	readonly pixelRatio: number;
	readonly tabFocusMode: boolean;
	readonly inputMode: 'insert' | 'overtype';
	readonly accessibilitySupport: AccessibilitySupport;
	readonly glyphMarginDecorationLaneCount: number;
	readonly editContextSupported: boolean;
}

/** Computes one normalized option by ID. */
export interface IComputedEditorOptions {
	get<T extends EditorOption>(id: T): FindComputedEditorOptionValueById<T>;
}

/** Whether validation decorations should be kept in the current projection. */
export function filterValidationDecorations(options: IComputedEditorOptions): boolean {
	const renderValidationDecorations = options.get(EditorOption.renderValidationDecorations);
	if (renderValidationDecorations === 'editable') return options.get(EditorOption.readOnly);
	return renderValidationDecorations === 'on' ? false : true;
}

/** Whether font decorations require the browser's variable-font path. */
export function filterFontDecorations(options: IComputedEditorOptions): boolean {
	return !options.get(EditorOption.effectiveAllowVariableFonts);
}

/** Describes which option IDs changed during one configuration update. */
export class ConfigurationChangedEvent {
	private readonly _values: boolean[];

	public constructor(values: boolean[]) {
		this._values = values;
	}

	public hasChanged(id: EditorOption): boolean {
		return this._values[id] ?? false;
	}
}

/** The result of applying a partial update to one option. */
export class ApplyUpdateResult<T> {
	public constructor(
		public readonly newValue: T,
		public readonly didChange: boolean,
	) {}
}

/** An option descriptor kept in the common registry. */
type EditorOptionSchema = IConfigurationPropertySchema | { [path: string]: IConfigurationPropertySchema };

export interface IEditorOption<K extends EditorOption, V> {
	readonly id: K;
	readonly name: string;
	readonly defaultValue: V;
	readonly schema: IConfigurationPropertySchema | { [path: string]: IConfigurationPropertySchema } | undefined;
	validate(input: unknown): V;
	compute(environment: IEnvironmentalOptions, options: IComputedEditorOptions, value: V): V;
	applyUpdate(value: V | undefined, update: V): ApplyUpdateResult<V>;
}

/** Maps option IDs to their normalized values. */
interface EditorOptionValueMap {
	/** Unsupported computed options remain type-safe at the boundary as unknown. */
	[id: number]: unknown;
	[EditorOption.acceptSuggestionOnCommitCharacter]: boolean;
	[EditorOption.acceptSuggestionOnEnter]: 'on' | 'smart' | 'off';
	[EditorOption.allowOverflow]: boolean;
	[EditorOption.allowVariableLineHeights]: boolean;
	[EditorOption.allowVariableFonts]: boolean;
	[EditorOption.allowVariableFontsInAccessibilityMode]: boolean;
	[EditorOption.inDiffEditor]: boolean;
	[EditorOption.ariaRequired]: boolean;
	[EditorOption.ariaLabel]: string;
	[EditorOption.screenReaderAnnounceInlineSuggestion]: boolean;
	[EditorOption.autoClosingBrackets]: EditorAutoClosingStrategy;
	[EditorOption.autoClosingComments]: EditorAutoClosingStrategy;
	[EditorOption.autoClosingDelete]: EditorAutoClosingEditStrategy;
	[EditorOption.autoClosingOvertype]: EditorAutoClosingEditStrategy;
	[EditorOption.autoClosingQuotes]: EditorAutoClosingStrategy;
	[EditorOption.autoIndent]: EditorAutoIndentStrategy;
	[EditorOption.autoSurround]: EditorAutoSurroundStrategy;
	[EditorOption.autoIndentOnPaste]: boolean;
	[EditorOption.autoIndentOnPasteWithinString]: boolean;
	[EditorOption.automaticLayout]: boolean;
	[EditorOption.codeLens]: boolean;
	[EditorOption.codeLensFontFamily]: string;
	[EditorOption.codeLensFontSize]: number;
	[EditorOption.colorDecorators]: boolean;
	[EditorOption.colorDecoratorsLimit]: number;
	[EditorOption.columnSelection]: boolean;
	[EditorOption.contextmenu]: boolean;
	[EditorOption.copyWithSyntaxHighlighting]: boolean;
	[EditorOption.bracketPairColorization]: BracketPairColorizationOptions;
	[EditorOption.guides]: InternalGuidesOptions;
	[EditorOption.comments]: EditorCommentsOptions;
	[EditorOption.cursorBlinking]: TextEditorCursorBlinkingStyle;
	[EditorOption.cursorSmoothCaretAnimation]: 'off' | 'explicit' | 'on';
	[EditorOption.cursorSurroundingLines]: number;
	[EditorOption.cursorSurroundingLinesStyle]: 'default' | 'all';
	[EditorOption.cursorWidth]: number;
	[EditorOption.cursorHeight]: number;
	[EditorOption.disableLayerHinting]: boolean;
	[EditorOption.disableMonospaceOptimizations]: boolean;
	[EditorOption.domReadOnly]: boolean;
	[EditorOption.dragAndDrop]: boolean;
	[EditorOption.dropIntoEditor]: EditorDropIntoEditorOptions;
	[EditorOption.editContext]: boolean;
	[EditorOption.emptySelectionClipboard]: boolean;
	[EditorOption.experimentalGpuAcceleration]: 'on' | 'off';
	[EditorOption.experimentalWhitespaceRendering]: 'svg' | 'font' | 'off';
	[EditorOption.extraEditorClassName]: string;
	[EditorOption.fastScrollSensitivity]: number;
	[EditorOption.gotoLocation]: GoToLocationOptions;
	[EditorOption.hover]: EditorHoverOptions;
	[EditorOption.lightbulb]: EditorLightbulbOptions;
	[EditorOption.fixedOverflowWidgets]: boolean;
	[EditorOption.folding]: boolean;
	[EditorOption.foldingStrategy]: 'auto' | 'indentation';
	[EditorOption.foldingHighlight]: boolean;
	[EditorOption.foldingImportsByDefault]: boolean;
	[EditorOption.foldingMaximumRegions]: number;
	[EditorOption.unfoldOnClickAfterEndOfLine]: boolean;
	[EditorOption.readOnly]: boolean;
	[EditorOption.fontFamily]: string;
	[EditorOption.fontInfo]: FontInfo;
	[EditorOption.fontLigatures]: string;
	[EditorOption.fontSize]: number;
	[EditorOption.fontWeight]: string;
	[EditorOption.fontVariations]: string;
	[EditorOption.lineHeight]: number;
	[EditorOption.letterSpacing]: number;
	[EditorOption.lineDecorationsWidth]: number;
	[EditorOption.wordWrap]: EditorWordWrap;
	[EditorOption.lineNumbers]: InternalEditorRenderLineNumbersOptions;
	[EditorOption.lineNumbersMinChars]: number;
	[EditorOption.glyphMargin]: boolean;
	[EditorOption.rulers]: readonly IRulerOption[];
	[EditorOption.minimap]: EditorMinimapOptions;
	[EditorOption.scrollbar]: InternalEditorScrollbarOptions;
	[EditorOption.revealHorizontalRightPadding]: number;
	[EditorOption.stickyScroll]: EditorStickyScrollOptions;
	[EditorOption.find]: EditorFindOptions;
	[EditorOption.accessibilitySupport]: AccessibilitySupport;
	[EditorOption.accessibilityPageSize]: number;
	[EditorOption.tabFocusMode]: boolean;
	[EditorOption.renderValidationDecorations]: 'editable' | 'on' | 'off';
	[EditorOption.selectionClipboard]: boolean;
	[EditorOption.roundedSelection]: boolean;
	[EditorOption.cursorStyle]: TextEditorCursorStyle;
	[EditorOption.overtypeCursorStyle]: TextEditorCursorStyle;
	[EditorOption.multiCursorModifier]: EditorMultiCursorModifier;
	[EditorOption.multiCursorPaste]: 'spread' | 'full';
	[EditorOption.mouseMiddleClickAction]: MouseMiddleClickAction;
	[EditorOption.mouseStyle]: 'text' | 'default' | 'copy';
	[EditorOption.mouseWheelScrollSensitivity]: number;
	[EditorOption.mouseWheelZoom]: boolean;
	[EditorOption.multiCursorMergeOverlapping]: boolean;
	[EditorOption.multiCursorLimit]: number;
	[EditorOption.occurrencesHighlight]: 'off' | 'singleFile' | 'multiFile';
	[EditorOption.occurrencesHighlightDelay]: number;
	[EditorOption.wordSegmenterLocales]: string[];
	[EditorOption.wordSeparators]: string;
	[EditorOption.wordWrapColumn]: number;
	[EditorOption.wordWrapOverride1]: 'off' | 'on' | 'inherit';
	[EditorOption.wordWrapOverride2]: 'off' | 'on' | 'inherit';
	[EditorOption.wrappingIndent]: WrappingIndent;
	[EditorOption.wrappingStrategy]: 'simple' | 'advanced';
	[EditorOption.padding]: InternalEditorPaddingOptions;
	[EditorOption.peekWidgetDefaultFocus]: 'tree' | 'editor';
	[EditorOption.placeholder]: string | undefined;
	[EditorOption.quickSuggestionsDelay]: number;
	[EditorOption.quickSuggestions]: InternalQuickSuggestionsOptions;
	[EditorOption.readOnlyMessage]: IMarkdownString | undefined;
	[EditorOption.renameOnType]: boolean;
	[EditorOption.renderRichScreenReaderContent]: boolean;
	[EditorOption.renderControlCharacters]: boolean;
	[EditorOption.renderFinalNewline]: 'off' | 'on' | 'dimmed';
	[EditorOption.renderLineHighlight]: 'none' | 'gutter' | 'line' | 'all';
	[EditorOption.renderLineHighlightOnlyWhenFocus]: boolean;
	[EditorOption.renderWhitespace]: 'none' | 'boundary' | 'selection' | 'trailing' | 'all';
	[EditorOption.scrollBeyondLastColumn]: number;
	[EditorOption.scrollBeyondLastLine]: boolean;
	[EditorOption.scrollOnMiddleClick]: boolean;
	[EditorOption.scrollPredominantAxis]: boolean;
	[EditorOption.selectionHighlight]: boolean;
	[EditorOption.selectionHighlightMaxLength]: number;
	[EditorOption.selectionHighlightMultiline]: boolean;
	[EditorOption.selectOnLineNumbers]: boolean;
	[EditorOption.showDeprecated]: boolean;
	[EditorOption.showFoldingControls]: 'always' | 'never' | 'mouseover';
	[EditorOption.showUnused]: boolean;
	[EditorOption.suggest]: InternalSuggestOptions;
	[EditorOption.suggestFontSize]: number;
	[EditorOption.suggestLineHeight]: number;
	[EditorOption.suggestOnTriggerCharacters]: boolean;
	[EditorOption.suggestSelection]: 'first' | 'recentlyUsed' | 'recentlyUsedByPrefix';
	[EditorOption.tabCompletion]: 'on' | 'off' | 'onlySnippets';
	[EditorOption.tabIndex]: number;
	[EditorOption.trimWhitespaceOnDelete]: boolean;
	[EditorOption.smartSelect]: SmartSelectOptions;
	[EditorOption.unicodeHighlighting]: InternalUnicodeHighlightOptions;
	[EditorOption.links]: boolean;
	[EditorOption.inlineSuggest]: InternalInlineSuggestOptions;
	[EditorOption.parameterHints]: InternalParameterHintOptions;
	[EditorOption.inlayHints]: EditorInlayHintsOptions;
	[EditorOption.useShadowDOM]: boolean;
	[EditorOption.useTabStops]: boolean;
	[EditorOption.wordBreak]: 'normal' | 'keepAll';
	[EditorOption.wordWrapBreakAfterCharacters]: string;
	[EditorOption.wordWrapBreakBeforeCharacters]: string;
	[EditorOption.wrapOnEscapedLineFeeds]: boolean;
	[EditorOption.inertialScroll]: boolean;
	[EditorOption.stickyTabStops]: boolean;
	[EditorOption.overtypeOnPaste]: boolean;
	[EditorOption.hideCursorInOverviewRuler]: boolean;
	[EditorOption.overviewRulerBorder]: boolean;
	[EditorOption.overviewRulerLanes]: number;
	[EditorOption.stopRenderingLineAfter]: number;
	[EditorOption.inlineCompletionsAccessibilityVerbose]: boolean;
	[EditorOption.colorDecoratorsActivatedOn]: 'clickAndHover' | 'click' | 'hover';
	[EditorOption.effectiveCursorStyle]: TextEditorCursorStyle;
	[EditorOption.effectiveEditContext]: boolean;
	[EditorOption.effectiveAllowVariableFonts]: boolean;
	[EditorOption.layoutInfo]: EditorLayoutInfo;
	[EditorOption.wrappingInfo]: EditorWrappingInfo;
	[EditorOption.editorClassName]: string;
	[EditorOption.pixelRatio]: number;
	[EditorOption.defaultColorDecorators]: 'auto' | 'always' | 'never';
}

type EditorOptionsType = { [K in EditorOption]: IEditorOption<K, EditorOptionValueMap[K]> };
type FindEditorOptionsKeyById<T extends EditorOption> = T;
type ComputedEditorOptionValue<T extends IEditorOption<any, any>> = T extends IEditorOption<any, infer R> ? R : never;
export type FindComputedEditorOptionValueById<T extends EditorOption> = NonNullable<ComputedEditorOptionValue<EditorOptionsType[FindEditorOptionsKeyById<T>]>>;

/** Registry containing the descriptors in numeric option-ID order. */
export const editorOptionsRegistry: IEditorOption<EditorOption, unknown>[] = [];

class EditorOptionDefinition<K extends EditorOption, V> implements IEditorOption<K, V> {
	public readonly schema: EditorOptionSchema | undefined;

	public constructor(
		public readonly id: K,
		public readonly name: string,
		public readonly defaultValue: V,
		private readonly validator: (input: unknown) => V,
		schema?: EditorOptionSchema,
		private readonly computer: ((environment: IEnvironmentalOptions, options: IComputedEditorOptions, value: V) => V) | undefined = undefined,
	) {
		this.schema = schema;
	}

	public validate(input: unknown): V {
		return this.validator(input);
	}

	public compute(environment: IEnvironmentalOptions, options: IComputedEditorOptions, value: V): V {
		return this.computer?.(environment, options, value) ?? value;
	}

	public applyUpdate(value: V | undefined, update: V): ApplyUpdateResult<V> {
		return applyOptionUpdate(value, update);
	}
}

/**
 * Lightweight, browser-neutral layout option computer.
 *
 * VS Code keeps this option at the end of its registry because it depends on
 * several resolved options. Ash exposes the same contract and leaves DOM
 * measurement to the browser adapter.
 */
export class EditorLayoutInfoComputer extends EditorOptionDefinition<EditorOption.layoutInfo, EditorLayoutInfo> {
	public constructor() {
		super(EditorOption.layoutInfo, 'layoutInfo', defaultEditorLayoutInfo(), () => defaultEditorLayoutInfo());
	}

	public override compute(environment: IEnvironmentalOptions, options: IComputedEditorOptions, _value: EditorLayoutInfo): EditorLayoutInfo {
		return EditorLayoutInfoComputer.computeLayout(options, {
			memory: environment.memory,
			outerWidth: environment.outerWidth,
			outerHeight: environment.outerHeight,
			isDominatedByLongLines: environment.isDominatedByLongLines,
			lineHeight: environment.fontInfo.lineHeight,
			viewLineCount: environment.viewLineCount,
			lineNumbersDigitCount: environment.lineNumbersDigitCount,
			typicalHalfwidthCharacterWidth: environment.fontInfo.typicalHalfwidthCharacterWidth,
			maxDigitWidth: environment.fontInfo.maxDigitWidth,
			pixelRatio: environment.pixelRatio,
			glyphMarginDecorationLaneCount: environment.glyphMarginDecorationLaneCount,
		});
	}

	public static computeContainedMinimapLineCount(input: {
		viewLineCount: number;
		scrollBeyondLastLine: boolean;
		paddingTop: number;
		paddingBottom: number;
		height: number;
		lineHeight: number;
		pixelRatio: number;
	}): { typicalViewportLineCount: number; extraLinesBeforeFirstLine: number; extraLinesBeyondLastLine: number; desiredRatio: number; minimapLineCount: number } {
		const height = Math.max(1, input.height);
		const lineHeight = Math.max(1, input.lineHeight);
		const pixelRatio = Math.max(1, input.pixelRatio);
		const typicalViewportLineCount = height / lineHeight;
		const extraLinesBeforeFirstLine = Math.floor(Math.max(0, input.paddingTop) / lineHeight);
		let extraLinesBeyondLastLine = Math.floor(Math.max(0, input.paddingBottom) / lineHeight);
		if (input.scrollBeyondLastLine) extraLinesBeyondLastLine = Math.max(extraLinesBeyondLastLine, typicalViewportLineCount - 1);
		const desiredRatio = (extraLinesBeforeFirstLine + Math.max(0, input.viewLineCount) + extraLinesBeyondLastLine) / (pixelRatio * height);
		const minimapLineCount = Math.max(1, Math.floor(Math.max(0, input.viewLineCount) / Math.max(desiredRatio, Number.MIN_VALUE)));
		return { typicalViewportLineCount, extraLinesBeforeFirstLine, extraLinesBeyondLastLine, desiredRatio, minimapLineCount };
	}

	public static _computeMinimapLayout(input: IMinimapLayoutInput, memory: ComputeOptionsMemory): EditorMinimapLayoutInfo {
		const outerWidth = Math.max(0, input.outerWidth);
		const outerHeight = Math.max(0, input.outerHeight);
		const pixelRatio = Math.max(1, input.pixelRatio);
		if (!input.minimap.enabled) {
			return {
				renderMinimap: RenderMinimap.None,
				minimapLeft: 0,
				minimapWidth: 0,
				minimapHeightIsEditorHeight: false,
				minimapIsSampling: false,
				minimapScale: 1,
				minimapLineHeight: 1,
				minimapCanvasInnerWidth: 0,
				minimapCanvasInnerHeight: Math.floor(pixelRatio * outerHeight),
				minimapCanvasOuterWidth: 0,
				minimapCanvasOuterHeight: outerHeight,
			};
		}

		const previous = memory.stableMinimapLayoutInput;
		const couldUseMemory = !!previous
			&& input.outerHeight === previous.outerHeight
			&& input.lineHeight === previous.lineHeight
			&& input.typicalHalfwidthCharacterWidth === previous.typicalHalfwidthCharacterWidth
			&& input.pixelRatio === previous.pixelRatio
			&& input.scrollBeyondLastLine === previous.scrollBeyondLastLine
			&& input.paddingTop === previous.paddingTop
			&& input.paddingBottom === previous.paddingBottom
			&& input.minimap.enabled === previous.minimap.enabled
			&& input.minimap.side === previous.minimap.side
			&& input.minimap.size === previous.minimap.size
			&& input.minimap.showSlider === previous.minimap.showSlider
			&& input.minimap.renderCharacters === previous.minimap.renderCharacters
			&& input.minimap.maxColumn === previous.minimap.maxColumn
			&& input.minimap.scale === previous.minimap.scale
			&& input.verticalScrollbarWidth === previous.verticalScrollbarWidth
			&& input.isViewportWrapping === previous.isViewportWrapping;

		const lineHeight = Math.max(1, input.lineHeight);
		const typicalHalfwidthCharacterWidth = Math.max(1, input.typicalHalfwidthCharacterWidth);
		const minimapRenderCharacters = input.minimap.renderCharacters;
		let minimapScale = pixelRatio >= 2 ? Math.round(input.minimap.scale * 2) : input.minimap.scale;
		const minimapMaxColumn = input.minimap.maxColumn;
		const minimapSize = input.minimap.size;
		const minimapSide = input.minimap.side;
		const viewLineCount = Math.max(0, input.viewLineCount);
		const remainingWidth = input.remainingWidth;
		const baseCharHeight = minimapRenderCharacters ? 2 : 3;
		let minimapCanvasInnerHeight = Math.floor(pixelRatio * outerHeight);
		const minimapCanvasOuterHeight = minimapCanvasInnerHeight / pixelRatio;
		let minimapHeightIsEditorHeight = false;
		let minimapIsSampling = false;
		let minimapLineHeight = baseCharHeight * minimapScale;
		let minimapCharWidth = minimapScale / pixelRatio;
		let minimapWidthMultiplier = 1;

		if (minimapSize === 'fill' || minimapSize === 'fit') {
			const contained = EditorLayoutInfoComputer.computeContainedMinimapLineCount({
				viewLineCount,
				scrollBeyondLastLine: input.scrollBeyondLastLine,
				paddingTop: input.paddingTop,
				paddingBottom: input.paddingBottom,
				height: outerHeight,
				lineHeight,
				pixelRatio,
			});
			const ratio = viewLineCount / Math.max(1, contained.minimapLineCount);
			if (ratio > 1) {
				minimapHeightIsEditorHeight = true;
				minimapIsSampling = true;
				minimapScale = 1;
				minimapLineHeight = 1;
				minimapCharWidth = minimapScale / pixelRatio;
			} else {
				let fitBecomesFill = false;
				let maxMinimapScale = minimapScale + 1;
				if (minimapSize === 'fit') {
					const effectiveMinimapHeight = Math.ceil((contained.extraLinesBeforeFirstLine + viewLineCount + contained.extraLinesBeyondLastLine) * minimapLineHeight);
					if (input.isViewportWrapping && couldUseMemory && remainingWidth <= memory.stableFitRemainingWidth) {
						fitBecomesFill = true;
						maxMinimapScale = memory.stableFitMaxMinimapScale;
					} else {
						fitBecomesFill = effectiveMinimapHeight > minimapCanvasInnerHeight;
					}
				}
				if (minimapSize === 'fill' || fitBecomesFill) {
					minimapHeightIsEditorHeight = true;
					const configuredMinimapScale = minimapScale;
					minimapLineHeight = Math.min(lineHeight * pixelRatio, Math.max(1, Math.floor(1 / Math.max(contained.desiredRatio, Number.MIN_VALUE))));
					if (input.isViewportWrapping && couldUseMemory && remainingWidth <= memory.stableFitRemainingWidth) maxMinimapScale = memory.stableFitMaxMinimapScale;
					minimapScale = Math.min(maxMinimapScale, Math.max(1, Math.floor(minimapLineHeight / baseCharHeight)));
					if (minimapScale > configuredMinimapScale) minimapWidthMultiplier = Math.min(2, minimapScale / configuredMinimapScale);
					minimapCharWidth = minimapScale / pixelRatio / minimapWidthMultiplier;
					minimapCanvasInnerHeight = Math.ceil(Math.max(contained.typicalViewportLineCount, contained.extraLinesBeforeFirstLine + viewLineCount + contained.extraLinesBeyondLastLine) * minimapLineHeight);
					if (input.isViewportWrapping) {
						memory.stableMinimapLayoutInput = input;
						memory.stableFitRemainingWidth = remainingWidth;
						memory.stableFitMaxMinimapScale = minimapScale;
					} else {
						memory.stableMinimapLayoutInput = null;
						memory.stableFitRemainingWidth = 0;
					}
				}
			}
		}

		const minimapWidth = Math.min(
			Math.floor(minimapMaxColumn * minimapCharWidth),
			Math.max(0, Math.floor(((remainingWidth - input.verticalScrollbarWidth - 2) * minimapCharWidth) / (typicalHalfwidthCharacterWidth + minimapCharWidth))) + MINIMAP_GUTTER_WIDTH,
		);
		let minimapCanvasInnerWidth = Math.floor(pixelRatio * minimapWidth);
		const minimapCanvasOuterWidth = minimapCanvasInnerWidth / pixelRatio;
		minimapCanvasInnerWidth = Math.floor(minimapCanvasInnerWidth * minimapWidthMultiplier);
		return {
			renderMinimap: minimapRenderCharacters ? RenderMinimap.Text : RenderMinimap.Blocks,
			minimapLeft: minimapSide === 'left' ? 0 : outerWidth - minimapWidth - input.verticalScrollbarWidth,
			minimapWidth,
			minimapHeightIsEditorHeight,
			minimapIsSampling,
			minimapScale,
			minimapLineHeight,
			minimapCanvasInnerWidth,
			minimapCanvasInnerHeight,
			minimapCanvasOuterWidth,
			minimapCanvasOuterHeight,
		};
	}

	public static computeLayout(options: IComputedEditorOptions, environment: EditorLayoutInfoComputerEnv): EditorLayoutInfo {
		const outerWidth = environment.outerWidth | 0;
		const outerHeight = environment.outerHeight | 0;
		const lineHeight = environment.lineHeight | 0;
		const lineNumbersDigitCount = environment.lineNumbersDigitCount | 0;
		const typicalHalfwidthCharacterWidth = Math.max(1, environment.typicalHalfwidthCharacterWidth);
		const maxDigitWidth = Math.max(1, environment.maxDigitWidth);
		const pixelRatio = Math.max(1, environment.pixelRatio);
		const viewLineCount = Math.max(0, environment.viewLineCount);

		const wordWrapOverride2 = options.get(EditorOption.wordWrapOverride2);
		const wordWrapOverride1 = wordWrapOverride2 === 'inherit' ? options.get(EditorOption.wordWrapOverride1) : wordWrapOverride2;
		const wordWrap = wordWrapOverride1 === 'inherit' ? options.get(EditorOption.wordWrap) : wordWrapOverride1 as EditorWordWrap;
		const wordWrapColumn = options.get(EditorOption.wordWrapColumn);
		const showGlyphMargin = options.get(EditorOption.glyphMargin);
		const showLineNumbers = options.get(EditorOption.lineNumbers).renderType !== RenderLineNumbersType.Off;
		const lineNumbersMinChars = options.get(EditorOption.lineNumbersMinChars);
		const scrollBeyondLastLine = options.get(EditorOption.scrollBeyondLastLine);
		const padding = options.get(EditorOption.padding);
		const minimap = options.get(EditorOption.minimap);
		const scrollbar = options.get(EditorOption.scrollbar);
		const folding = options.get(EditorOption.folding);
		const showFoldingDecoration = options.get(EditorOption.showFoldingControls) !== 'never';

		let lineDecorationsWidth = options.get(EditorOption.lineDecorationsWidth);
		if (folding && showFoldingDecoration) lineDecorationsWidth += 16;
		let lineNumbersWidth = 0;
		if (showLineNumbers) lineNumbersWidth = Math.round(Math.max(lineNumbersDigitCount, lineNumbersMinChars) * maxDigitWidth);
		const glyphMarginWidth = showGlyphMargin ? lineHeight * environment.glyphMarginDecorationLaneCount : 0;
		let glyphMarginLeft = 0;
		let lineNumbersLeft = glyphMarginLeft + glyphMarginWidth;
		let decorationsLeft = lineNumbersLeft + lineNumbersWidth;
		let contentLeft = decorationsLeft + lineDecorationsWidth;
		const remainingWidth = outerWidth - glyphMarginWidth - lineNumbersWidth - lineDecorationsWidth;

		let isWordWrapMinified = false;
		let isViewportWrapping = false;
		let wrappingColumn = -1;
		if (options.get(EditorOption.accessibilitySupport) === AccessibilitySupport.Enabled && wordWrapOverride1 === 'inherit' && environment.isDominatedByLongLines) {
			isWordWrapMinified = true;
			isViewportWrapping = true;
		} else if (wordWrap === 'on' || wordWrap === 'bounded') {
			isViewportWrapping = true;
		} else if (wordWrap === 'wordWrapColumn') {
			wrappingColumn = wordWrapColumn;
		}

		const minimapLayout = EditorLayoutInfoComputer._computeMinimapLayout({
			outerWidth,
			outerHeight,
			lineHeight,
			typicalHalfwidthCharacterWidth,
			pixelRatio,
			scrollBeyondLastLine,
			paddingTop: padding.top,
			paddingBottom: padding.bottom,
			minimap,
			verticalScrollbarWidth: scrollbar.verticalScrollbarSize,
			viewLineCount,
			remainingWidth,
			isViewportWrapping,
		}, environment.memory ?? new ComputeOptionsMemory());
		if (minimapLayout.renderMinimap !== RenderMinimap.None && minimapLayout.minimapLeft === 0) {
			glyphMarginLeft += minimapLayout.minimapWidth;
			lineNumbersLeft += minimapLayout.minimapWidth;
			decorationsLeft += minimapLayout.minimapWidth;
			contentLeft += minimapLayout.minimapWidth;
		}
		const contentWidth = remainingWidth - minimapLayout.minimapWidth;
		const viewportColumn = Math.max(1, Math.floor((contentWidth - scrollbar.verticalScrollbarSize - 2) / typicalHalfwidthCharacterWidth));
		const verticalArrowSize = scrollbar.verticalHasArrows ? scrollbar.arrowSize : 0;
		if (isViewportWrapping) {
			wrappingColumn = Math.max(1, viewportColumn);
			if (wordWrap === 'bounded') wrappingColumn = Math.min(wrappingColumn, wordWrapColumn);
		}
		return {
			width: outerWidth,
			height: outerHeight,
			glyphMarginLeft,
			glyphMarginWidth,
			glyphMarginDecorationLaneCount: environment.glyphMarginDecorationLaneCount,
			lineNumbersLeft,
			lineNumbersWidth,
			decorationsLeft,
			decorationsWidth: lineDecorationsWidth,
			contentLeft,
			contentWidth,
			minimap: minimapLayout,
			viewportColumn,
			isWordWrapMinified,
			isViewportWrapping,
			wrappingColumn,
			verticalScrollbarWidth: scrollbar.verticalScrollbarSize,
			horizontalScrollbarHeight: scrollbar.horizontalScrollbarSize,
			overviewRuler: {
				top: verticalArrowSize,
				width: scrollbar.verticalScrollbarSize,
				height: outerHeight - 2 * verticalArrowSize,
				right: 0,
			},
		};
	}
}

function defaultEditorLayoutInfo(): EditorLayoutInfo {
	return Object.freeze({
		width: 0,
		height: 0,
		glyphMarginLeft: 0,
		glyphMarginWidth: 0,
		glyphMarginDecorationLaneCount: 0,
		lineNumbersLeft: 0,
		lineNumbersWidth: 0,
		decorationsLeft: 0,
		decorationsWidth: 0,
		contentLeft: 0,
		contentWidth: 0,
		minimap: Object.freeze({
			renderMinimap: RenderMinimap.None,
			minimapLeft: 0,
			minimapWidth: 0,
			minimapHeightIsEditorHeight: false,
			minimapIsSampling: false,
			minimapScale: 1,
			minimapLineHeight: 1,
			minimapCanvasInnerWidth: 0,
			minimapCanvasInnerHeight: 0,
			minimapCanvasOuterWidth: 0,
			minimapCanvasOuterHeight: 0,
		}),
		viewportColumn: 0,
		isWordWrapMinified: false,
		isViewportWrapping: false,
		wrappingColumn: -1,
		verticalScrollbarWidth: 0,
		horizontalScrollbarHeight: 0,
		overviewRuler: Object.freeze({ top: 0, width: 0, height: 0, right: 0 }),
	});
}

function defaultWrappingInfo(): EditorWrappingInfo {
	return Object.freeze({
		isDominatedByLongLines: false,
		isWordWrapMinified: false,
		isViewportWrapping: false,
		wrappingColumn: -1,
	});
}

export class EditorFontLigatures extends EditorOptionDefinition<EditorOption.fontLigatures, string> {
	public static readonly OFF = '"liga" off, "calt" off';
	public static readonly ON = '"liga" on, "calt" on';

	public constructor() {
		super(EditorOption.fontLigatures, 'fontLigatures', EditorFontLigatures.OFF, validateFontLigatures);
	}

	public override validate(input: unknown): string {
		return validateFontLigatures(input);
	}
}

export class EditorFontVariations extends EditorOptionDefinition<EditorOption.fontVariations, string> {
	public static readonly OFF = FONT_VARIATION_OFF;
	public static readonly TRANSLATE = FONT_VARIATION_TRANSLATE;

	public constructor() {
		super(EditorOption.fontVariations, 'fontVariations', EditorFontVariations.OFF, validateFontVariations);
	}

	public override validate(input: unknown): string {
		return validateFontVariations(input);
	}

	public override compute(environment: IEnvironmentalOptions, options: IComputedEditorOptions, value: string): string {
		return super.compute(environment, options, value);
	}
}

function register<K extends EditorOption, V>(option: IEditorOption<K, V>): IEditorOption<K, V> {
	editorOptionsRegistry[option.id] = option as IEditorOption<EditorOption, unknown>;
	return option;
}

const fontInfo = register(new EditorOptionDefinition(
	EditorOption.fontInfo,
	'fontInfo',
	createDefaultFontInfo(),
	input => isRecord(input) ? input as unknown as FontInfo : createDefaultFontInfo(),
	undefined,
	(environment, _options, _value) => environment.fontInfo,
));
const fontLigatures = register(new EditorFontLigatures());

/** Common editor option descriptors, using the VS Code names where they remain useful. */
const editorOptions = {
	inDiffEditor: register(new EditorOptionDefinition(EditorOption.inDiffEditor, 'inDiffEditor', false, input => booleanValue(input, false))),
	ariaLabel: register(new EditorOptionDefinition(EditorOption.ariaLabel, 'ariaLabel', 'Editor content', input => stringValue(input, 'Editor content'))),
	readOnly: register(new EditorOptionDefinition(EditorOption.readOnly, 'readOnly', false, input => booleanValue(input, false))),
	fontFamily: register(new EditorOptionDefinition(EditorOption.fontFamily, 'fontFamily', EDITOR_FONT_DEFAULTS.fontFamily, input => stringValue(input, EDITOR_FONT_DEFAULTS.fontFamily))),
	fontInfo,
	fontLigatures2: fontLigatures,
	fontLigatures,
	fontSize: register(new EditorOptionDefinition(EditorOption.fontSize, 'fontSize', EDITOR_FONT_DEFAULTS.fontSize, validateFontSize, undefined, (environment, _options, _value) => environment.fontInfo.fontSize)),
	fontWeight: register(new EditorOptionDefinition(EditorOption.fontWeight, 'fontWeight', EDITOR_FONT_DEFAULTS.fontWeight, validateFontWeight)),
	fontVariations: register(new EditorOptionDefinition(EditorOption.fontVariations, 'fontVariations', EditorFontVariations.OFF, validateFontVariations, undefined, (environment, _options, _value) => environment.fontInfo.fontVariationSettings)),
	lineHeight: register(new EditorOptionDefinition(EditorOption.lineHeight, 'lineHeight', EDITOR_FONT_DEFAULTS.lineHeight, input => boundedNumber(input, EDITOR_FONT_DEFAULTS.lineHeight, 0, 150), undefined, (environment, _options, _value) => environment.fontInfo.lineHeight)),
	letterSpacing: register(new EditorOptionDefinition(EditorOption.letterSpacing, 'letterSpacing', EDITOR_FONT_DEFAULTS.letterSpacing, input => boundedNumber(input, EDITOR_FONT_DEFAULTS.letterSpacing, -5, 20))),
	wordWrap: register(new EditorOptionDefinition(EditorOption.wordWrap, 'wordWrap', 'off' as EditorWordWrap, input => enumValue(input, 'off' as EditorWordWrap, ['off', 'on', 'wordWrapColumn', 'bounded'] as const))),
	lineNumbers: register(new EditorOptionDefinition(EditorOption.lineNumbers, 'lineNumbers', defaultLineNumbers(), validateLineNumbers)),
	glyphMargin: register(new EditorOptionDefinition(EditorOption.glyphMargin, 'glyphMargin', true, input => booleanValue(input, true))),
	lineDecorationsWidth: register(new EditorOptionDefinition(EditorOption.lineDecorationsWidth, 'lineDecorationsWidth', 10, validateLineDecorationsWidth, undefined, (environment, _options, value) => value < 0 ? boundedInteger(-value * environment.fontInfo.typicalHalfwidthCharacterWidth, 10, 0, 1000) : value)),
	rulers: register(new EditorOptionDefinition(EditorOption.rulers, 'rulers', Object.freeze([]) as readonly IRulerOption[], validateRulers)),
	minimap: register(new EditorOptionDefinition(EditorOption.minimap, 'minimap', defaultMinimapOptions(), validateMinimapOptions)),
	scrollbar: register(new EditorOptionDefinition(EditorOption.scrollbar, 'scrollbar', defaultScrollbarOptions(), validateScrollbarOptions)),
	stickyScroll: register(new EditorOptionDefinition(EditorOption.stickyScroll, 'stickyScroll', defaultStickyScrollOptions(), validateStickyScrollOptions)),
	find: register(new EditorOptionDefinition(EditorOption.find, 'find', defaultFindOptions(), validateFindOptions)),
	bracketPairColorization: register(new EditorOptionDefinition(EditorOption.bracketPairColorization, 'bracketPairColorization', defaultBracketPairColorizationOptions(), validateBracketPairColorizationOptions)),
	comments: register(new EditorOptionDefinition(EditorOption.comments, 'comments', defaultCommentsOptions(), validateCommentsOptions)),
	guides: register(new EditorOptionDefinition(EditorOption.guides, 'guides', defaultGuidesOptions(), validateGuidesOptions)),
	gotoLocation: register(new EditorOptionDefinition(EditorOption.gotoLocation, 'gotoLocation', defaultGotoLocationOptions(), validateGotoLocationOptions)),
	hover: register(new EditorOptionDefinition(EditorOption.hover, 'hover', defaultHoverOptions(), validateHoverOptions)),
	lightbulb: register(new EditorOptionDefinition(EditorOption.lightbulb, 'lightbulb', defaultLightbulbOptions(), validateLightbulbOptions)),
	padding: register(new EditorOptionDefinition(EditorOption.padding, 'padding', defaultPaddingOptions(), validatePaddingOptions)),
	pasteAs: register(new EditorOptionDefinition(EditorOption.pasteAs, 'pasteAs', defaultPasteAsOptions(), validatePasteAsOptions)),
	quickSuggestions: register(new EditorOptionDefinition(EditorOption.quickSuggestions, 'quickSuggestions', defaultQuickSuggestionsOptions(), validateQuickSuggestionsOptions)),
	smartSelect: register(new EditorOptionDefinition(EditorOption.smartSelect, 'smartSelect', defaultSmartSelectOptions(), validateSmartSelectOptions)),
	suggest: register(new EditorOptionDefinition(EditorOption.suggest, 'suggest', defaultSuggestOptions(), validateSuggestOptions)),
	dropIntoEditor: register(new EditorOptionDefinition(EditorOption.dropIntoEditor, 'dropIntoEditor', defaultDropIntoEditorOptions(), validateDropIntoEditorOptions)),
	accessibilitySupport: register(new EditorOptionDefinition(EditorOption.accessibilitySupport, 'accessibilitySupport', AccessibilitySupport.Unknown, validateAccessibilitySupport, undefined, (environment, _options, value) => value === AccessibilitySupport.Unknown ? environment.accessibilitySupport : value)),
	accessibilityPageSize: register(new EditorOptionDefinition(EditorOption.accessibilityPageSize, 'accessibilityPageSize', 500, input => boundedInteger(input, 500, 1, 10_000))),
	tabFocusMode: register(new EditorOptionDefinition(EditorOption.tabFocusMode, 'tabFocusMode', false, input => booleanValue(input, false), undefined, (environment, _options, value) => value || environment.tabFocusMode)),
	effectiveCursorStyle: register(new EditorOptionDefinition(EditorOption.effectiveCursorStyle, 'effectiveCursorStyle', TextEditorCursorStyle.Line, input => validateCursorStyle(input, TextEditorCursorStyle.Line), undefined, (environment, options, _value) => environment.inputMode === 'overtype' ? options.get(EditorOption.overtypeCursorStyle) : options.get(EditorOption.cursorStyle))),
	editorClassName: register(new EditorOptionDefinition(EditorOption.editorClassName, 'editorClassName', '', input => stringValue(input, ''), undefined, computeEditorClassName)),
	pixelRatio: register(new EditorOptionDefinition(EditorOption.pixelRatio, 'pixelRatio', 1, input => boundedNumber(input, 1, 0.1, 10), undefined, (environment, _options, _value) => environment.pixelRatio)),
	layoutInfo: register(new EditorLayoutInfoComputer()),
	wrappingInfo: register(new EditorOptionDefinition(EditorOption.wrappingInfo, 'wrappingInfo', defaultWrappingInfo(), input => isRecord(input) ? input as unknown as EditorWrappingInfo : defaultWrappingInfo(), undefined, (environment, options, _value) => {
		const layout = options.get(EditorOption.layoutInfo);
		return Object.freeze({
			isDominatedByLongLines: environment.isDominatedByLongLines,
			isWordWrapMinified: layout.isWordWrapMinified,
			isViewportWrapping: layout.isViewportWrapping,
			wrappingColumn: layout.wrappingColumn,
		});
	})),
	extraEditorClassName: register(new EditorOptionDefinition(EditorOption.extraEditorClassName, 'extraEditorClassName', '', input => stringValue(input, ''))),
	renderValidationDecorations: register(new EditorOptionDefinition(EditorOption.renderValidationDecorations, 'renderValidationDecorations', 'editable' as const, input => enumValue(input, 'editable' as const, ['editable', 'on', 'off'] as const))),
	selectionClipboard: register(new EditorOptionDefinition(EditorOption.selectionClipboard, 'selectionClipboard', true, input => booleanValue(input, true))),
	emptySelectionClipboard: register(new EditorOptionDefinition(EditorOption.emptySelectionClipboard, 'emptySelectionClipboard', true, input => booleanValue(input, true), undefined, (environment, _options, value) => value && environment.emptySelectionClipboard)),
	roundedSelection: register(new EditorOptionDefinition(EditorOption.roundedSelection, 'roundedSelection', true, input => booleanValue(input, true))),
	cursorStyle: register(new EditorOptionDefinition(EditorOption.cursorStyle, 'cursorStyle', TextEditorCursorStyle.Line, input => validateCursorStyle(input, TextEditorCursorStyle.Line))),
	cursorBlinking: register(new EditorOptionDefinition(EditorOption.cursorBlinking, 'cursorBlinking', TextEditorCursorBlinkingStyle.Blink, validateCursorBlinkingStyle)),
	overtypeCursorStyle: register(new EditorOptionDefinition(EditorOption.overtypeCursorStyle, 'overtypeCursorStyle', TextEditorCursorStyle.Block, input => validateCursorStyle(input, TextEditorCursorStyle.Block))),
	mouseStyle: register(new EditorOptionDefinition(EditorOption.mouseStyle, 'mouseStyle', 'text' as const, input => enumValue(input, 'text' as const, ['text', 'default', 'copy'] as const))),
	multiCursorModifier: register(new EditorOptionDefinition(EditorOption.multiCursorModifier, 'multiCursorModifier', isMacintosh ? 'altKey' as const : 'altKey' as const, validateMultiCursorModifier)),
	wordSegmenterLocales: register(new EditorOptionDefinition(EditorOption.wordSegmenterLocales, 'wordSegmenterLocales', [] as string[], validateWordSegmenterLocales)),
	wrappingIndent: register(new EditorOptionDefinition(EditorOption.wrappingIndent, 'wrappingIndent', WrappingIndent.Same, validateWrappingIndent, undefined, (environment, options, value) => options.get(EditorOption.accessibilitySupport) === AccessibilitySupport.Enabled ? WrappingIndent.None : value)),
	codeLens: register(new EditorOptionDefinition(EditorOption.codeLens, 'codeLens', true, input => booleanValue(input, true))),
	folding: register(new EditorOptionDefinition(EditorOption.folding, 'folding', true, input => booleanValue(input, true))),
	links: register(new EditorOptionDefinition(EditorOption.links, 'links', true, input => booleanValue(input, true))),
	inlineSuggest: register(new EditorOptionDefinition(EditorOption.inlineSuggest, 'inlineSuggest', defaultInlineSuggestOptions(), validateInlineSuggestOptions)),
	parameterHints: register(new EditorOptionDefinition(EditorOption.parameterHints, 'parameterHints', defaultParameterHintOptions(), validateParameterHintOptions)),
	inlayHints: register(new EditorOptionDefinition(EditorOption.inlayHints, 'inlayHints', defaultInlayHintsOptions(), validateInlayHintsOptions)),
	unicodeHighlighting: register(new EditorOptionDefinition(EditorOption.unicodeHighlighting, 'unicodeHighlight', defaultUnicodeHighlightOptions(), validateUnicodeHighlightOptions)),
	effectiveEditContext: register(new EditorOptionDefinition(EditorOption.effectiveEditContext, 'effectiveEditContext', false, input => booleanValue(input, false), undefined, (environment, options) => environment.editContextSupported && options.get(EditorOption.editContext))),
	effectiveAllowVariableFonts: register(new EditorOptionDefinition(EditorOption.effectiveAllowVariableFonts, 'effectiveAllowVariableFonts', false, input => booleanValue(input, false), undefined, (environment, options) => environment.accessibilitySupport === AccessibilitySupport.Enabled ? options.get(EditorOption.allowVariableFontsInAccessibilityMode) : options.get(EditorOption.allowVariableFonts))),
};

type EditorOptionsCollection = Record<string, IEditorOption<EditorOption, unknown>> & {
	readonly fontFamily: IEditorOption<EditorOption.fontFamily, string>;
	readonly fontWeight: IEditorOption<EditorOption.fontWeight, string>;
	readonly fontSize: IEditorOption<EditorOption.fontSize, number>;
	readonly fontLigatures: IEditorOption<EditorOption.fontLigatures, string>;
	readonly fontLigatures2: IEditorOption<EditorOption.fontLigatures, string>;
	readonly fontVariations: IEditorOption<EditorOption.fontVariations, string>;
	readonly lineHeight: IEditorOption<EditorOption.lineHeight, number>;
	readonly letterSpacing: IEditorOption<EditorOption.letterSpacing, number>;
	readonly lineNumbers: IEditorOption<EditorOption.lineNumbers, InternalEditorRenderLineNumbersOptions>;
	readonly cursorStyle: IEditorOption<EditorOption.cursorStyle, TextEditorCursorStyle>;
	readonly overtypeCursorStyle: IEditorOption<EditorOption.overtypeCursorStyle, TextEditorCursorStyle>;
	readonly cursorBlinking: IEditorOption<EditorOption.cursorBlinking, TextEditorCursorBlinkingStyle>;
	readonly cursorWidth: IEditorOption<EditorOption.cursorWidth, number>;
	readonly cursorHeight: IEditorOption<EditorOption.cursorHeight, number>;
	readonly mouseStyle: IEditorOption<EditorOption.mouseStyle, 'text' | 'default' | 'copy'>;
	readonly guides: IEditorOption<EditorOption.guides, InternalGuidesOptions>;
	readonly accessibilitySupport: IEditorOption<EditorOption.accessibilitySupport, AccessibilitySupport>;
	readonly scrollbar: IEditorOption<EditorOption.scrollbar, InternalEditorScrollbarOptions>;
	readonly revealHorizontalRightPadding: IEditorOption<EditorOption.revealHorizontalRightPadding, number>;
	readonly quickSuggestions: IEditorOption<EditorOption.quickSuggestions, InternalQuickSuggestionsOptions>;
	readonly suggest: IEditorOption<EditorOption.suggest, InternalSuggestOptions>;
	readonly inlineSuggest: IEditorOption<EditorOption.inlineSuggest, InternalInlineSuggestOptions>;
	readonly parameterHints: IEditorOption<EditorOption.parameterHints, InternalParameterHintOptions>;
	readonly unicodeHighlighting: IEditorOption<EditorOption.unicodeHighlighting, InternalUnicodeHighlightOptions>;
	readonly layoutInfo: IEditorOption<EditorOption.layoutInfo, EditorLayoutInfo>;
	readonly wrappingInfo: IEditorOption<EditorOption.wrappingInfo, EditorWrappingInfo>;
	readonly wordSeparators: IEditorOption<EditorOption.wordSeparators, string>;
};

const editorOptionsCollection = editorOptions as unknown as EditorOptionsCollection;

const booleanCompatibilityDefaults = {
	acceptSuggestionOnCommitCharacter: true,
	allowOverflow: true,
	allowVariableLineHeights: true,
	allowVariableFonts: true,
	allowVariableFontsInAccessibilityMode: false,
	ariaRequired: false,
	screenReaderAnnounceInlineSuggestion: true,
	autoIndentOnPaste: false,
	autoIndentOnPasteWithinString: true,
	automaticLayout: false,
	colorDecorators: true,
	columnSelection: false,
	contextmenu: true,
	copyWithSyntaxHighlighting: true,
	disableLayerHinting: false,
	disableMonospaceOptimizations: false,
	domReadOnly: false,
	dragAndDrop: true,
	editContext: true,
	emptySelectionClipboard: true,
	fixedOverflowWidgets: false,
	foldingHighlight: true,
	foldingImportsByDefault: false,
	unfoldOnClickAfterEndOfLine: false,
	formatOnPaste: false,
	formatOnType: false,
	hideCursorInOverviewRuler: false,
	linkedEditing: false,
	mouseWheelZoom: false,
	multiCursorMergeOverlapping: true,
	overtypeOnPaste: true,
	overviewRulerBorder: true,
	renderRichScreenReaderContent: false,
	renderControlCharacters: true,
	renderLineHighlightOnlyWhenFocus: false,
	scrollOnMiddleClick: false,
	scrollBeyondLastLine: true,
	scrollPredominantAxis: true,
	selectionHighlight: true,
	selectionHighlightMultiline: false,
	selectOnLineNumbers: true,
	showUnused: true,
	smoothScrolling: false,
	stickyTabStops: false,
	suggestOnTriggerCharacters: true,
	trimWhitespaceOnDelete: false,
	useShadowDOM: true,
	useTabStops: true,
	showDeprecated: false,
	inertialScroll: false,
	wrapOnEscapedLineFeeds: false,
	inlineCompletionsAccessibilityVerbose: false,
	effectiveEditContext: false,
	effectiveAllowVariableFonts: false,
	doubleClickSelectsBlock: true,
} as const;

const numberCompatibilityDefaults = {
	codeLensFontSize: 0,
	colorDecoratorsLimit: 500,
	cursorSurroundingLines: 0,
	cursorWidth: 0,
	cursorHeight: 0,
	fastScrollSensitivity: 5,
	lineDecorationsWidth: 10,
	lineNumbersMinChars: 5,
	mouseWheelScrollSensitivity: 1,
	multiCursorLimit: 10_000,
	occurrencesHighlightDelay: 250,
	overviewRulerLanes: 3,
	quickSuggestionsDelay: 10,
	revealHorizontalRightPadding: 15,
	scrollBeyondLastColumn: 4,
	selectionHighlightMaxLength: 200,
	stopRenderingLineAfter: 10_000,
	suggestFontSize: 0,
	suggestLineHeight: 0,
	tabIndex: 0,
	wordWrapColumn: 80,
	foldingMaximumRegions: 5_000,
} as const;

const enumCompatibilityDefaults = {
	acceptSuggestionOnEnter: ['on', ['on', 'smart', 'off']],
	autoClosingBrackets: ['languageDefined', ['always', 'languageDefined', 'beforeWhitespace', 'never']],
	autoClosingComments: ['languageDefined', ['always', 'languageDefined', 'beforeWhitespace', 'never']],
	autoClosingDelete: ['auto', ['always', 'auto', 'never']],
	autoClosingOvertype: ['auto', ['always', 'auto', 'never']],
	autoClosingQuotes: ['languageDefined', ['always', 'languageDefined', 'beforeWhitespace', 'never']],
	autoIndent: ['full', ['none', 'keep', 'brackets', 'advanced', 'full']],
	autoSurround: ['languageDefined', ['languageDefined', 'quotes', 'brackets', 'never']],
	cursorSmoothCaretAnimation: ['off', ['off', 'explicit', 'on']],
	experimentalGpuAcceleration: ['off', ['off', 'on']],
	experimentalWhitespaceRendering: ['svg', ['svg', 'font', 'off']],
	foldingStrategy: ['auto', ['auto', 'indentation']],
	matchBrackets: ['always', ['never', 'near', 'always']],
	mouseMiddleClickAction: ['default', ['default', 'openLink', 'ctrlLeftClick']],
	multiCursorModifier: ['alt', ['ctrlCmd', 'alt']],
	multiCursorPaste: ['spread', ['spread', 'full']],
	occurrencesHighlight: ['singleFile', ['off', 'singleFile', 'multiFile']],
	overtypeCursorStyle: ['block', ['line', 'block', 'underline', 'line-thin', 'block-outline', 'underline-thin']],
	peekWidgetDefaultFocus: ['tree', ['tree', 'editor']],
	renderFinalNewline: ['on', ['off', 'on', 'dimmed']],
	renderLineHighlight: ['line', ['none', 'gutter', 'line', 'all']],
	renderWhitespace: ['selection', ['none', 'boundary', 'selection', 'trailing', 'all']],
	showFoldingControls: ['mouseover', ['always', 'never', 'mouseover']],
	snippetSuggestions: ['inline', ['top', 'bottom', 'inline', 'none']],
	suggestSelection: ['first', ['first', 'recentlyUsed', 'recentlyUsedByPrefix']],
	tabCompletion: ['off', ['on', 'off', 'onlySnippets']],
	unusualLineTerminators: ['prompt', ['auto', 'off', 'prompt']],
	wordBreak: ['normal', ['normal', 'keepAll']],
	wordWrapOverride1: ['inherit', ['off', 'on', 'inherit']],
	wordWrapOverride2: ['inherit', ['off', 'on', 'inherit']],
	wrappingIndent: ['same', ['none', 'same', 'indent', 'deepIndent']],
	wrappingStrategy: ['simple', ['simple', 'advanced']],
	defaultColorDecorators: ['auto', ['auto', 'always', 'never']],
	colorDecoratorsActivatedOn: ['clickAndHover', ['clickAndHover', 'click', 'hover']],
} as const;

const objectCompatibilityDefaults: Readonly<Record<string, unknown>> = {
	comments: Object.freeze({ insertSpace: true, ignoreEmptyLines: true }),
	gotoLocation: Object.freeze({
		multiple: 'peek',
		multipleDefinitions: 'peek',
		multipleTypeDefinitions: 'peek',
		multipleDeclarations: 'peek',
		multipleImplementations: 'peek',
		multipleReferences: 'peek',
		multipleTests: 'peek',
		alternativeDefinitionCommand: 'editor.action.goToReferences',
		alternativeTypeDefinitionCommand: 'editor.action.goToReferences',
		alternativeDeclarationCommand: 'editor.action.goToReferences',
		alternativeImplementationCommand: 'editor.action.goToReferences',
		alternativeReferenceCommand: 'editor.action.goToReferences',
		alternativeTestsCommand: 'editor.action.goToReferences',
	}),
	guides: Object.freeze({ bracketPairs: false, bracketPairsHorizontal: 'active', highlightActiveBracketPair: true, indentation: true, highlightActiveIndentation: true }),
	hover: Object.freeze({ enabled: 'on', delay: 300, sticky: true, hidingDelay: 300, above: true, showLongLineWarning: true }),
	lightbulb: Object.freeze({ enabled: ShowLightbulbIconMode.OnCode }),
	padding: Object.freeze({ top: 0, bottom: 0 }),
	pasteAs: Object.freeze({ enabled: true, showPasteSelector: 'afterPaste' }),
	quickSuggestions: Object.freeze({ other: 'offWhenInlineCompletions', comments: 'off', strings: 'off' }),
	smartSelect: Object.freeze({ selectLeadingAndTrailingWhitespace: true, selectSubwords: true }),
	suggest: Object.freeze({ insertMode: 'insert', filterGraceful: true, snippetsPreventQuickSuggestions: false, localityBonus: false, shareSuggestSelections: false, selectionMode: 'always', showIcons: true, showStatusBar: false, preview: false, previewMode: 'subwordSmart', showInlineDetails: true, fitWidthToDetails: false, matchOnWordStartOnly: true }),
	unicodeHighlighting: Object.freeze({ nonBasicASCII: true, invisibleCharacters: true, ambiguousCharacters: true, includeComments: false, allowedCharacters: Object.freeze({}) }),
	inlineSuggest: Object.freeze({ enabled: true, mode: 'prefix', showToolbar: 'onHover', suppressSuggestions: false, keepOnBlur: false, syntaxHighlightingEnabled: true }),
	inlayHints: Object.freeze({ enabled: 'on', fontSize: 0, fontFamily: '', padding: false, maximumLength: 43 }),
	parameterHints: Object.freeze({ enabled: true, cycle: true }),
	minimap: Object.freeze({ enabled: true, autohide: 'none', side: 'right', size: 'proportional', renderCharacters: true, showSlider: 'mouseover', maxColumn: 120, scale: 1, showRegionSectionHeaders: true, showMarkSectionHeaders: true, markSectionHeaderRegex: '', sectionHeaderFontSize: 9, sectionHeaderLetterSpacing: 1 }),
	scrollbar: Object.freeze({ arrowSize: 11, vertical: ScrollbarVisibility.Auto, horizontal: ScrollbarVisibility.Auto, useShadows: true, verticalHasArrows: false, horizontalHasArrows: false, handleMouseWheel: true, alwaysConsumeMouseWheel: true, horizontalScrollbarSize: 12, horizontalSliderSize: 12, verticalScrollbarSize: 14, verticalSliderSize: 14, scrollByPage: false, ignoreHorizontalScrollbarInContentHeight: false }),
	stickyScroll: Object.freeze({ enabled: true, maxLineCount: 5, defaultModel: 'outlineModel', scrollWithEditor: true }),
	dropIntoEditor: Object.freeze({ enabled: true, showDropSelector: 'afterDrop' }),
};

const stringCompatibilityDefaults = {
	codeLensFontFamily: '',
	extraEditorClassName: '',
	placeholder: undefined,
	readOnlyMessage: undefined,
	wordSeparators: `~!@#$%^&*()-=+[\\]{}\\\\|;:'\",.<>/?`,
	wordWrapBreakAfterCharacters: ' \\t})]?|/&.,;!?:',
	wordWrapBreakBeforeCharacters: '([{',
} as const;

for (const [name, defaultValue] of Object.entries(booleanCompatibilityDefaults)) {
	addCompatibilityOption(name, defaultValue, { type: 'boolean', default: defaultValue });
}
for (const [name, defaultValue] of Object.entries(numberCompatibilityDefaults)) {
	addCompatibilityOption(name, defaultValue, { type: 'number', default: defaultValue, minimum: 0 });
}
for (const [name, [defaultValue, values]] of Object.entries(enumCompatibilityDefaults)) {
	addCompatibilityOption(name, defaultValue, { type: 'string', enum: values, default: defaultValue }, input => enumValue(input, defaultValue, values));
}
for (const [name, defaultValue] of Object.entries(objectCompatibilityDefaults)) {
	addCompatibilityOption(name, defaultValue, { type: 'object', default: defaultValue as never });
}
for (const [name, defaultValue] of Object.entries(stringCompatibilityDefaults)) {
	addCompatibilityOption(name, defaultValue, defaultValue === undefined ? { type: 'string' } : { type: 'string', default: defaultValue });
}

// Keep the registry dense even for computed options whose full browser/layout
// implementation is intentionally supplied by a later Ash adapter.
for (const name of Object.keys(EditorOption).filter(key => Number.isNaN(Number(key)))) {
	const id = optionId(name);
	if (id !== undefined && !editorOptionsRegistry[id]) addCompatibilityOption(name, undefined);
}

export const EditorOptions = Object.freeze(editorOptionsCollection);

function optionId(name: string): EditorOption | undefined {
	const value = (EditorOption as unknown as Record<string, number>)[name];
	return typeof value === 'number' ? value as EditorOption : undefined;
}

function computeEditorClassName(environment: IEnvironmentalOptions, options: IComputedEditorOptions, _value: string): string {
	const classNames = ['stanza-editor'];
	const configuredClassName = options.get(EditorOption.extraEditorClassName);
	if (configuredClassName) classNames.push(configuredClassName);
	if (environment.extraEditorClassName) classNames.push(environment.extraEditorClassName);
	const mouseStyle = options.get(EditorOption.mouseStyle);
	if (mouseStyle === 'default') classNames.push('mouse-default');
	else if (mouseStyle === 'copy') classNames.push('mouse-copy');
	if (options.get(EditorOption.showUnused)) classNames.push('showUnused');
	if (options.get(EditorOption.showDeprecated)) classNames.push('showDeprecated');
	return classNames.join(' ');
}

function addCompatibilityOption(
	name: string,
	defaultValue: unknown,
	schema?: IConfigurationPropertySchema,
	validator: ((input: unknown) => unknown) | undefined = undefined,
): void {
	const id = optionId(name);
	if (id === undefined || editorOptionsCollection[name] !== undefined) return;
	const option = register(new EditorOptionDefinition(
		id,
		name,
		defaultValue,
		input => validator?.(input) ?? validateCompatibilityValue(input, defaultValue),
		schema,
	));
	editorOptionsCollection[name] = option;
}

function validateCompatibilityValue(input: unknown, defaultValue: unknown): unknown {
	if (input === undefined) return defaultValue;
	if (typeof defaultValue === 'boolean') return booleanValue(input, defaultValue);
	if (typeof defaultValue === 'number') return typeof input === 'number' && Number.isFinite(input) ? input : defaultValue;
	if (typeof defaultValue === 'string') return stringValue(input, defaultValue);
	if (Array.isArray(defaultValue)) return Array.isArray(input) ? Object.freeze([...input]) : defaultValue;
	if (isRecord(defaultValue) && isRecord(input)) return Object.freeze({ ...defaultValue, ...input });
	return input;
}

function applyOptionUpdate<T>(value: T | undefined, update: T): ApplyUpdateResult<T> {
	if (value === undefined) return new ApplyUpdateResult(update, true);
	if (isRecord(value) && isRecord(update)) {
		const newValue = Object.freeze({ ...value, ...update }) as T;
		return new ApplyUpdateResult(newValue, !recordsEqual(value, newValue as unknown as Record<string, unknown>));
	}
	return new ApplyUpdateResult(update, !Object.is(value, update));
}

function booleanValue(input: unknown, defaultValue: boolean): boolean {
	return boolean(input, defaultValue);
}

/** VS Code-compatible boolean normalization helper. */
export function boolean(value: unknown, defaultValue: boolean): boolean {
	if (value === undefined) return defaultValue;
	if (value === 'false') return false;
	return Boolean(value);
}

function stringValue(input: unknown, defaultValue: string): string {
	return input === undefined ? defaultValue : typeof input === 'string' ? input : defaultValue;
}

function boundedNumber(input: unknown, defaultValue: number, minimum: number, maximum: number): number {
	if (input === undefined || typeof input !== 'number' || !Number.isFinite(input)) return defaultValue;
	return Math.min(maximum, Math.max(minimum, input));
}

/** VS Code-compatible integer clamping helper. */
export function clampedInt<T = number>(value: unknown, defaultValue: T, minimum: number, maximum: number): number | T {
	if (typeof value === 'string') value = Number.parseInt(value, 10);
	if (typeof value !== 'number' || !Number.isFinite(value)) return defaultValue;
	return Math.trunc(Math.min(maximum, Math.max(minimum, value)));
}

/** VS Code-compatible floating-point clamping helper. */
export function clampedFloat<T extends number = number>(value: unknown, defaultValue: T, minimum: number, maximum: number): number | T {
	if (value === undefined) return defaultValue;
	const numberValue = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(numberValue)) return defaultValue;
	return Math.min(maximum, Math.max(minimum, numberValue));
}

function boundedInteger(input: unknown, defaultValue: number, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(input)) return defaultValue;
	return Math.min(maximum, Math.max(minimum, input as number));
}

function enumValue<T extends string>(input: unknown, defaultValue: T, values: readonly T[]): T {
	return typeof input === 'string' && values.includes(input as T) ? input as T : defaultValue;
}

/** Returns an allowed string value, optionally translating renamed values. */
export function stringSet<T extends string>(value: unknown, defaultValue: T, allowedValues: ReadonlyArray<T>, renamedValues?: Record<string, T>): T {
	if (typeof value !== 'string') return defaultValue;
	const renamed = renamedValues?.[value];
	if (renamed !== undefined) return renamed;
	return allowedValues.includes(value as T) ? value as T : defaultValue;
}

function validateCursorStyle(input: unknown, defaultValue: TextEditorCursorStyle): TextEditorCursorStyle {
	if (typeof input === 'number' && input >= TextEditorCursorStyle.Line && input <= TextEditorCursorStyle.UnderlineThin) {
		return input as TextEditorCursorStyle;
	}
	if (typeof input === 'string' && ['line', 'block', 'underline', 'line-thin', 'block-outline', 'underline-thin'].includes(input)) {
		return cursorStyleFromString(input as Parameters<typeof cursorStyleFromString>[0]);
	}
	return defaultValue;
}

function validateCursorBlinkingStyle(input: unknown): TextEditorCursorBlinkingStyle {
	if (typeof input === 'number' && input >= TextEditorCursorBlinkingStyle.Hidden && input <= TextEditorCursorBlinkingStyle.Solid) {
		return input as TextEditorCursorBlinkingStyle;
	}
	if (typeof input === 'string' && ['blink', 'smooth', 'phase', 'expand', 'solid'].includes(input)) {
		return cursorBlinkingStyleFromString(input as Parameters<typeof cursorBlinkingStyleFromString>[0]);
	}
	return TextEditorCursorBlinkingStyle.Blink;
}

function validateAccessibilitySupport(input: unknown): AccessibilitySupport {
	switch (input) {
		case 'auto': return AccessibilitySupport.Unknown;
		case 'off': return AccessibilitySupport.Disabled;
		case 'on': return AccessibilitySupport.Enabled;
		default: return AccessibilitySupport.Unknown;
	}
}

function validateLineNumbers(input: unknown): InternalEditorRenderLineNumbersOptions {
	if (typeof input === 'function') return { renderType: RenderLineNumbersType.Custom, renderFn: input as (lineNumber: number) => string };
	switch (input) {
		case 'off': return { renderType: RenderLineNumbersType.Off, renderFn: null };
		case 'relative': return { renderType: RenderLineNumbersType.Relative, renderFn: null };
		case 'interval': return { renderType: RenderLineNumbersType.Interval, renderFn: null };
		case 'on': return { renderType: RenderLineNumbersType.On, renderFn: null };
		default: return { renderType: RenderLineNumbersType.On, renderFn: null };
	}
}

function validateLineDecorationsWidth(input: unknown): number {
	if (typeof input === 'string' && /^\d+(?:\.\d+)?ch$/u.test(input)) return -Number.parseFloat(input.slice(0, -2));
	return clampedInt(input, 10, 0, 1000) as number;
}

function validateMultiCursorModifier(input: unknown): EditorMultiCursorModifier {
	if (input === 'ctrlCmd') return isMacintosh ? 'metaKey' : 'ctrlKey';
	return 'altKey';
}

function validateWrappingIndent(input: unknown): WrappingIndent {
	switch (input) {
		case 'none': return WrappingIndent.None;
		case 'indent': return WrappingIndent.Indent;
		case 'deepIndent': return WrappingIndent.DeepIndent;
		case 'same': return WrappingIndent.Same;
		default: return WrappingIndent.Same;
	}
}

function validateWordSegmenterLocales(input: unknown): string[] {
	const locales = typeof input === 'string' ? [input] : Array.isArray(input) ? input : [];
	const validLocales: string[] = [];
	for (const locale of locales) {
		if (typeof locale !== 'string') continue;
		try {
			if (Intl.Segmenter.supportedLocalesOf(locale).length > 0) validLocales.push(locale);
		} catch {
			// Ignore invalid BCP 47 tags.
		}
	}
	return validLocales;
}

function validateFontSize(input: unknown): number {
	const value = typeof input === 'string' ? Number.parseFloat(input) : typeof input === 'number' ? input : EDITOR_FONT_DEFAULTS.fontSize;
	if (!Number.isFinite(value) || value === 0) return EDITOR_FONT_DEFAULTS.fontSize;
	return Math.min(100, Math.max(6, value));
}

function validateFontLigatures(input: unknown): string {
	if (input === undefined || input === false || input === 'false' || input === '') return EditorFontLigatures.OFF;
	if (input === true || input === 'true') return EditorFontLigatures.ON;
	return typeof input === 'string' ? input : EditorFontLigatures.OFF;
}

function validateFontVariations(input: unknown): string {
	if (input === undefined || input === false || input === 'false') return EditorFontVariations.OFF;
	if (input === true || input === 'true') return EditorFontVariations.TRANSLATE;
	return typeof input === 'string' ? input : EditorFontVariations.OFF;
}

function validateFontWeight(input: unknown): string {
	if (input === undefined) return EDITOR_FONT_DEFAULTS.fontWeight;
	if (input === 'normal' || input === 'bold') return input;
	if ((typeof input === 'number' && Number.isFinite(input)) || typeof input === 'string') {
		const weight = clampedInt(input, EDITOR_FONT_DEFAULTS.fontWeight, 1, 1000);
		if (typeof weight === 'number') return String(weight);
	}
	return EDITOR_FONT_DEFAULTS.fontWeight;
}

function validateFindOptions(input: unknown): EditorFindOptions {
	const options = isRecord(input) ? input : {};
	return Object.freeze({
		cursorMoveOnType: boolean(options.cursorMoveOnType, true),
		findOnType: boolean(options.findOnType, true),
		seedSearchStringFromSelection: enumValue(options.seedSearchStringFromSelection, 'always' as const, ['never', 'always', 'selection'] as const),
		autoFindInSelection: enumValue(options.autoFindInSelection, 'never' as const, ['never', 'always', 'multiline'] as const),
		addExtraSpaceOnTop: boolean(options.addExtraSpaceOnTop, true),
		globalFindClipboard: boolean(options.globalFindClipboard, false),
		loop: boolean(options.loop, true),
		closeOnResult: boolean(options.closeOnResult, false),
		history: enumValue(options.history, 'workspace' as const, ['never', 'workspace'] as const),
		replaceHistory: enumValue(options.replaceHistory, 'workspace' as const, ['never', 'workspace'] as const),
	});
}

function validateMinimapOptions(input: unknown): EditorMinimapOptions {
	const options = isRecord(input) ? input : {};
	return Object.freeze({
		enabled: booleanValue(options.enabled, true),
		autohide: enumValue(options.autohide, 'none' as const, ['none', 'mouseover', 'scroll'] as const),
		side: enumValue(options.side, 'right' as const, ['right', 'left'] as const),
		size: enumValue(options.size, 'proportional' as const, ['proportional', 'fill', 'fit'] as const),
		renderCharacters: booleanValue(options.renderCharacters, true),
		showSlider: enumValue(options.showSlider, 'mouseover' as const, ['always', 'mouseover'] as const),
		maxColumn: boundedInteger(options.maxColumn, 120, 1, 10_000),
		scale: boundedInteger(options.scale, 1, 1, 3),
		showRegionSectionHeaders: boolean(options.showRegionSectionHeaders, true),
		showMarkSectionHeaders: boolean(options.showMarkSectionHeaders, true),
		markSectionHeaderRegex: validRegex(options.markSectionHeaderRegex, '\\bMARK:\\s*(?<separator>\\-?)\\s*(?<label>.*)$'),
		sectionHeaderFontSize: boundedNumber(options.sectionHeaderFontSize, 9, 4, 32),
		sectionHeaderLetterSpacing: boundedNumber(options.sectionHeaderLetterSpacing, 1, 0, 5),
	});
}

function validateScrollbarOptions(input: unknown): EditorScrollbarOptions {
	const options = isRecord(input) ? input : {};
	return Object.freeze({
		arrowSize: boundedInteger(options.arrowSize, 11, 0, 1000),
		vertical: scrollbarVisibility(options.vertical),
		horizontal: scrollbarVisibility(options.horizontal),
		useShadows: boolean(options.useShadows, true),
		verticalHasArrows: boolean(options.verticalHasArrows, false),
		horizontalHasArrows: boolean(options.horizontalHasArrows, false),
		handleMouseWheel: boolean(options.handleMouseWheel, true),
		verticalScrollbarSize: boundedInteger(options.verticalScrollbarSize, 14, 0, 1000),
		horizontalScrollbarSize: boundedInteger(options.horizontalScrollbarSize, 12, 0, 1000),
		verticalSliderSize: boundedInteger(options.verticalSliderSize, boundedInteger(options.verticalScrollbarSize, 14, 0, 1000), 0, 1000),
		horizontalSliderSize: boundedInteger(options.horizontalSliderSize, boundedInteger(options.horizontalScrollbarSize, 12, 0, 1000), 0, 1000),
		scrollByPage: boolean(options.scrollByPage, false),
		ignoreHorizontalScrollbarInContentHeight: boolean(options.ignoreHorizontalScrollbarInContentHeight, false),
		alwaysConsumeMouseWheel: boolean(options.alwaysConsumeMouseWheel, true),
	});
}

function scrollbarVisibility(value: unknown): ScrollbarVisibility {
	switch (value) {
		case 'hidden': return ScrollbarVisibility.Hidden;
		case 'visible': return ScrollbarVisibility.Visible;
		default: return ScrollbarVisibility.Auto;
	}
}

function validateStickyScrollOptions(input: unknown): EditorStickyScrollOptions {
	const options = isRecord(input) ? input : {};
	return Object.freeze({
		enabled: boolean(options.enabled, true),
		defaultModel: enumValue(options.defaultModel, 'outlineModel' as const, ['outlineModel', 'foldingProviderModel', 'indentationModel'] as const),
		maxLineCount: boundedInteger(options.maxLineCount, 5, 1, 20),
		scrollWithEditor: boolean(options.scrollWithEditor, true),
	});
}

function validateBracketPairColorizationOptions(input: unknown): BracketPairColorizationOptions {
	const options = isRecord(input) ? input : {};
	return Object.freeze({
		enabled: boolean(options.enabled, EDITOR_MODEL_DEFAULTS.bracketPairColorizationOptions.enabled),
		independentColorPoolPerBracketType: boolean(options.independentColorPoolPerBracketType, EDITOR_MODEL_DEFAULTS.bracketPairColorizationOptions.independentColorPoolPerBracketType),
	});
}

function validateRulers(input: unknown): readonly IRulerOption[] {
	if (!Array.isArray(input)) return Object.freeze([]);
	const rulers: IRulerOption[] = [];
	for (const value of input) {
		if (typeof value === 'number') {
			rulers.push(Object.freeze({ column: clampedInt(value, 0, 0, 10_000) as number, color: null }));
		} else if (isRecord(value)) {
			rulers.push(Object.freeze({
				column: clampedInt(value.column, 0, 0, 10_000) as number,
				color: typeof value.color === 'string' ? value.color : null,
			}));
		}
	}
	rulers.sort((left, right) => left.column - right.column);
	return Object.freeze(rulers);
}

function validateInlineSuggestOptions(input: unknown): InternalInlineSuggestOptions {
	const options = isRecord(input) ? input : {};
	const edits = isRecord(options.edits) ? options.edits : {};
	const experimental = isRecord(options.experimental) ? options.experimental : {};
	return Object.freeze({
		enabled: boolean(options.enabled, true),
		mode: enumValue(options.mode, 'subwordSmart' as const, ['prefix', 'subword', 'subwordSmart'] as const),
		showToolbar: enumValue(options.showToolbar, 'onHover' as const, ['always', 'onHover', 'never'] as const),
		suppressSuggestions: boolean(options.suppressSuggestions, false),
		keepOnBlur: boolean(options.keepOnBlur, false),
		syntaxHighlightingEnabled: boolean(options.syntaxHighlightingEnabled, true),
		minShowDelay: boundedInteger(options.minShowDelay, 0, 0, 10_000),
		suppressInSnippetMode: boolean(options.suppressInSnippetMode, true),
		fontFamily: typeof options.fontFamily === 'string' ? options.fontFamily : 'default',
		edits: Object.freeze({
			allowCodeShifting: enumValue(edits.allowCodeShifting, 'always' as const, ['always', 'horizontal', 'never'] as const),
			renderSideBySide: enumValue(edits.renderSideBySide, 'auto' as const, ['never', 'auto'] as const),
			showCollapsed: boolean(edits.showCollapsed, false),
			showLongDistanceHint: boolean(edits.showLongDistanceHint, true),
			longDistanceHintContextLineCount: boundedInteger(edits.longDistanceHintContextLineCount, 0, 0, 10),
			enabled: boolean(edits.enabled, true),
		}),
		triggerCommandOnProviderChange: boolean(options.triggerCommandOnProviderChange, false),
		experimental: Object.freeze({
			suppressInlineSuggestions: stringValue(experimental.suppressInlineSuggestions, ''),
			emptyResponseInformation: boolean(experimental.emptyResponseInformation, true),
			showOnSuggestConflict: enumValue(experimental.showOnSuggestConflict, 'never' as const, ['always', 'never', 'whenSuggestListIsIncomplete'] as const),
		}),
	});
}

function validateParameterHintOptions(input: unknown): InternalParameterHintOptions {
	const options = isRecord(input) ? input : {};
	return Object.freeze({
		enabled: booleanValue(options.enabled, true),
		cycle: booleanValue(options.cycle, true),
	});
}

function validateInlayHintsOptions(input: unknown): EditorInlayHintsOptions {
	const options = isRecord(input) ? input : {};
	return Object.freeze({
		enabled: enumValue(options.enabled, 'on' as const, ['on', 'off', 'offUnlessPressed', 'onUnlessPressed'] as const),
		fontSize: boundedInteger(options.fontSize, 0, 0, 100),
		fontFamily: stringValue(options.fontFamily, ''),
		padding: boolean(options.padding, false),
		maximumLength: boundedInteger(options.maximumLength, 43, 0, Number.MAX_SAFE_INTEGER),
	});
}

function validateUnicodeHighlightOptions(input: unknown): InternalUnicodeHighlightOptions {
	const options = isRecord(input) ? input : {};
	const allowedCharacters = validateBooleanMap(options.allowedCharacters, {});
	const allowedLocales = validateBooleanMap(options.allowedLocales, { _os: true, _vscode: true });
	return Object.freeze({
		nonBasicASCII: primitiveSet(options.nonBasicASCII, forUntrustedContent, [true, false, forUntrustedContent]),
		invisibleCharacters: boolean(options.invisibleCharacters, true),
		ambiguousCharacters: boolean(options.ambiguousCharacters, true),
		includeComments: primitiveSet(options.includeComments, forUntrustedContent, [true, false, forUntrustedContent]),
		includeStrings: primitiveSet(options.includeStrings, true, [true, false, forUntrustedContent]),
		allowedCharacters,
		allowedLocales,
	});
}

function defaultCommentsOptions(): EditorCommentsOptions {
	return Object.freeze({ insertSpace: true, ignoreEmptyLines: true });
}

function validateCommentsOptions(input: unknown): EditorCommentsOptions {
	const options = isRecord(input) ? input : {};
	return Object.freeze({
		insertSpace: boolean(options.insertSpace, true),
		ignoreEmptyLines: boolean(options.ignoreEmptyLines, true),
	});
}

function defaultGuidesOptions(): InternalGuidesOptions {
	return Object.freeze({
		bracketPairs: false,
		bracketPairsHorizontal: 'active' as const,
		highlightActiveBracketPair: true,
		indentation: true,
		highlightActiveIndentation: true,
	});
}

function validateGuidesOptions(input: unknown): InternalGuidesOptions {
	const options = isRecord(input) ? input : {};
	return Object.freeze({
		bracketPairs: primitiveSet(options.bracketPairs, false, [true, false, 'active'] as const),
		bracketPairsHorizontal: primitiveSet(options.bracketPairsHorizontal, 'active' as const, [true, false, 'active'] as const),
		highlightActiveBracketPair: boolean(options.highlightActiveBracketPair, true),
		indentation: boolean(options.indentation, true),
		highlightActiveIndentation: primitiveSet(options.highlightActiveIndentation, true, [true, false, 'always'] as const),
	});
}

function defaultGotoLocationOptions(): GoToLocationOptions {
	return Object.freeze({
		multiple: 'peek' as const,
		multipleDefinitions: 'peek' as const,
		multipleTypeDefinitions: 'peek' as const,
		multipleDeclarations: 'peek' as const,
		multipleImplementations: 'peek' as const,
		multipleReferences: 'peek' as const,
		multipleTests: 'peek' as const,
		alternativeDefinitionCommand: 'editor.action.goToReferences',
		alternativeTypeDefinitionCommand: 'editor.action.goToReferences',
		alternativeDeclarationCommand: 'editor.action.goToReferences',
		alternativeImplementationCommand: '',
		alternativeReferenceCommand: '',
		alternativeTestsCommand: '',
	});
}

function validateGotoLocationOptions(input: unknown): GoToLocationOptions {
	const options = isRecord(input) ? input : {};
	const defaults = defaultGotoLocationOptions();
	return Object.freeze({
		multiple: enumValue(options.multiple, defaults.multiple, ['peek', 'gotoAndPeek', 'goto'] as const),
		multipleDefinitions: enumValue(options.multipleDefinitions, defaults.multipleDefinitions, ['peek', 'gotoAndPeek', 'goto'] as const),
		multipleTypeDefinitions: enumValue(options.multipleTypeDefinitions, defaults.multipleTypeDefinitions, ['peek', 'gotoAndPeek', 'goto'] as const),
		multipleDeclarations: enumValue(options.multipleDeclarations, defaults.multipleDeclarations, ['peek', 'gotoAndPeek', 'goto'] as const),
		multipleImplementations: enumValue(options.multipleImplementations, defaults.multipleImplementations, ['peek', 'gotoAndPeek', 'goto'] as const),
		multipleReferences: enumValue(options.multipleReferences, defaults.multipleReferences, ['peek', 'gotoAndPeek', 'goto'] as const),
		multipleTests: enumValue(options.multipleTests, defaults.multipleTests, ['peek', 'gotoAndPeek', 'goto'] as const),
		alternativeDefinitionCommand: stringValue(options.alternativeDefinitionCommand, defaults.alternativeDefinitionCommand),
		alternativeTypeDefinitionCommand: stringValue(options.alternativeTypeDefinitionCommand, defaults.alternativeTypeDefinitionCommand),
		alternativeDeclarationCommand: stringValue(options.alternativeDeclarationCommand, defaults.alternativeDeclarationCommand),
		alternativeImplementationCommand: stringValue(options.alternativeImplementationCommand, defaults.alternativeImplementationCommand),
		alternativeReferenceCommand: stringValue(options.alternativeReferenceCommand, defaults.alternativeReferenceCommand),
		alternativeTestsCommand: stringValue(options.alternativeTestsCommand, defaults.alternativeTestsCommand),
	});
}

function defaultHoverOptions(): EditorHoverOptions {
	return Object.freeze({ enabled: 'on' as const, delay: 300, sticky: true, hidingDelay: 300, above: true, showLongLineWarning: true });
}

function validateHoverOptions(input: unknown): EditorHoverOptions {
	const options = isRecord(input) ? input : {};
	return Object.freeze({
		enabled: enumValue(options.enabled, 'on' as const, ['on', 'off', 'onKeyboardModifier'] as const),
		delay: boundedInteger(options.delay, 300, 0, 10_000),
		sticky: boolean(options.sticky, true),
		hidingDelay: boundedInteger(options.hidingDelay, 300, 0, 600_000),
		above: boolean(options.above, true),
		showLongLineWarning: boolean(options.showLongLineWarning, true),
	});
}

function defaultLightbulbOptions(): EditorLightbulbOptions {
	return Object.freeze({ enabled: ShowLightbulbIconMode.OnCode });
}

function validateLightbulbOptions(input: unknown): EditorLightbulbOptions {
	const options = isRecord(input) ? input : {};
	return Object.freeze({ enabled: enumValue(options.enabled, ShowLightbulbIconMode.OnCode, [ShowLightbulbIconMode.Off, ShowLightbulbIconMode.OnCode, ShowLightbulbIconMode.On] as const) });
}

function defaultPaddingOptions(): InternalEditorPaddingOptions {
	return Object.freeze({ top: 0, bottom: 0 });
}

function validatePaddingOptions(input: unknown): InternalEditorPaddingOptions {
	const options = isRecord(input) ? input : {};
	return Object.freeze({ top: boundedInteger(options.top, 0, 0, 1000), bottom: boundedInteger(options.bottom, 0, 0, 1000) });
}

function defaultPasteAsOptions(): EditorPasteAsOptions {
	return Object.freeze({ enabled: true, showPasteSelector: 'afterPaste' as const });
}

function validatePasteAsOptions(input: unknown): EditorPasteAsOptions {
	const options = isRecord(input) ? input : {};
	return Object.freeze({ enabled: boolean(options.enabled, true), showPasteSelector: enumValue(options.showPasteSelector, 'afterPaste' as const, ['afterPaste', 'never'] as const) });
}

function defaultDropIntoEditorOptions(): EditorDropIntoEditorOptions {
	return Object.freeze({ enabled: true, showDropSelector: 'afterDrop' as const });
}

function validateDropIntoEditorOptions(input: unknown): EditorDropIntoEditorOptions {
	const options = isRecord(input) ? input : {};
	return Object.freeze({ enabled: boolean(options.enabled, true), showDropSelector: enumValue(options.showDropSelector, 'afterDrop' as const, ['afterDrop', 'never'] as const) });
}

function defaultQuickSuggestionsOptions(): InternalQuickSuggestionsOptions {
	return Object.freeze({ other: 'offWhenInlineCompletions' as const, comments: 'off' as const, strings: 'off' as const });
}

function quickSuggestionValue(value: unknown, defaultValue: QuickSuggestionsValue): QuickSuggestionsValue {
	if (typeof value === 'boolean') return value ? 'on' : 'off';
	return enumValue(value, defaultValue, ['on', 'inline', 'off', 'offWhenInlineCompletions'] as const);
}

function validateQuickSuggestionsOptions(input: unknown): InternalQuickSuggestionsOptions {
	const defaults = defaultQuickSuggestionsOptions();
	if (typeof input === 'boolean') {
		const value = input ? 'on' : 'off';
		return Object.freeze({ other: value, comments: value, strings: value });
	}
	if (typeof input === 'string') {
		const value = quickSuggestionValue(input, defaults.other);
		return Object.freeze({ other: value, comments: value, strings: value });
	}
	const options = isRecord(input) ? input : {};
	return Object.freeze({
		other: quickSuggestionValue(options.other, defaults.other),
		comments: quickSuggestionValue(options.comments, defaults.comments),
		strings: quickSuggestionValue(options.strings, defaults.strings),
	});
}

function defaultSmartSelectOptions(): SmartSelectOptions {
	return Object.freeze({ selectLeadingAndTrailingWhitespace: true, selectSubwords: true });
}

function validateSmartSelectOptions(input: unknown): SmartSelectOptions {
	const options = isRecord(input) ? input : {};
	return Object.freeze({
		selectLeadingAndTrailingWhitespace: boolean(options.selectLeadingAndTrailingWhitespace, true),
		selectSubwords: boolean(options.selectSubwords, true),
	});
}

function defaultSuggestOptions(): InternalSuggestOptions {
	return Object.freeze({
		insertMode: 'insert' as const,
		filterGraceful: true,
		snippetsPreventQuickSuggestions: false,
		localityBonus: false,
		shareSuggestSelections: false,
		selectionMode: 'always' as const,
		showIcons: true,
		showStatusBar: false,
		preview: false,
		previewMode: 'subwordSmart' as const,
		showInlineDetails: true,
		fitWidthToDetails: false,
		matchOnWordStartOnly: true,
		showMethods: true,
		showFunctions: true,
		showConstructors: true,
		showDeprecated: true,
		showFields: true,
		showVariables: true,
		showClasses: true,
		showStructs: true,
		showInterfaces: true,
		showModules: true,
		showProperties: true,
		showEvents: true,
		showOperators: true,
		showUnits: true,
		showValues: true,
		showConstants: true,
		showEnums: true,
		showEnumMembers: true,
		showKeywords: true,
		showWords: true,
		showColors: true,
		showFiles: true,
		showReferences: true,
		showFolders: true,
		showTypeParameters: true,
		showIssues: true,
		showUsers: true,
		showSnippets: true,
	});
}

function validateSuggestOptions(input: unknown): InternalSuggestOptions {
	const defaults = defaultSuggestOptions();
	const options = isRecord(input) ? input : {};
	return Object.freeze({
		insertMode: enumValue(options.insertMode, defaults.insertMode, ['insert', 'replace'] as const),
		filterGraceful: boolean(options.filterGraceful, defaults.filterGraceful),
		snippetsPreventQuickSuggestions: boolean(options.snippetsPreventQuickSuggestions, defaults.snippetsPreventQuickSuggestions),
		localityBonus: boolean(options.localityBonus, defaults.localityBonus),
		shareSuggestSelections: boolean(options.shareSuggestSelections, defaults.shareSuggestSelections),
		selectionMode: enumValue(options.selectionMode, defaults.selectionMode, ['always', 'never', 'whenTriggerCharacter', 'whenQuickSuggestion'] as const),
		showIcons: boolean(options.showIcons, defaults.showIcons),
		showStatusBar: boolean(options.showStatusBar, defaults.showStatusBar),
		preview: boolean(options.preview, defaults.preview),
		previewMode: enumValue(options.previewMode, defaults.previewMode, ['prefix', 'subword', 'subwordSmart'] as const),
		showInlineDetails: boolean(options.showInlineDetails, defaults.showInlineDetails),
		fitWidthToDetails: boolean(options.fitWidthToDetails, defaults.fitWidthToDetails),
		matchOnWordStartOnly: boolean(options.matchOnWordStartOnly, defaults.matchOnWordStartOnly),
		showMethods: boolean(options.showMethods, defaults.showMethods),
		showFunctions: boolean(options.showFunctions, defaults.showFunctions),
		showConstructors: boolean(options.showConstructors, defaults.showConstructors),
		showDeprecated: boolean(options.showDeprecated, defaults.showDeprecated),
		showFields: boolean(options.showFields, defaults.showFields),
		showVariables: boolean(options.showVariables, defaults.showVariables),
		showClasses: boolean(options.showClasses, defaults.showClasses),
		showStructs: boolean(options.showStructs, defaults.showStructs),
		showInterfaces: boolean(options.showInterfaces, defaults.showInterfaces),
		showModules: boolean(options.showModules, defaults.showModules),
		showProperties: boolean(options.showProperties, defaults.showProperties),
		showEvents: boolean(options.showEvents, defaults.showEvents),
		showOperators: boolean(options.showOperators, defaults.showOperators),
		showUnits: boolean(options.showUnits, defaults.showUnits),
		showValues: boolean(options.showValues, defaults.showValues),
		showConstants: boolean(options.showConstants, defaults.showConstants),
		showEnums: boolean(options.showEnums, defaults.showEnums),
		showEnumMembers: boolean(options.showEnumMembers, defaults.showEnumMembers),
		showKeywords: boolean(options.showKeywords, defaults.showKeywords),
		showWords: boolean(options.showWords, defaults.showWords),
		showColors: boolean(options.showColors, defaults.showColors),
		showFiles: boolean(options.showFiles, defaults.showFiles),
		showReferences: boolean(options.showReferences, defaults.showReferences),
		showFolders: boolean(options.showFolders, defaults.showFolders),
		showTypeParameters: boolean(options.showTypeParameters, defaults.showTypeParameters),
		showIssues: boolean(options.showIssues, defaults.showIssues),
		showUsers: boolean(options.showUsers, defaults.showUsers),
		showSnippets: boolean(options.showSnippets, defaults.showSnippets),
	});
}

function defaultLineNumbers(): InternalEditorRenderLineNumbersOptions {
	return Object.freeze({ renderType: RenderLineNumbersType.On, renderFn: null });
}

function validRegex(value: unknown, defaultValue: string): string {
	if (typeof value !== 'string') return defaultValue;
	try {
		new RegExp(value, 'd');
		return value;
	} catch {
		return defaultValue;
	}
}

function primitiveSet<T extends string | boolean>(value: unknown, defaultValue: T, allowedValues: readonly T[]): T {
	return allowedValues.includes(value as T) ? value as T : defaultValue;
}

function defaultFindOptions(): EditorFindOptions {
	return validateFindOptions(undefined);
}

function defaultInlineSuggestOptions(): InternalInlineSuggestOptions {
	return validateInlineSuggestOptions(undefined);
}

function defaultParameterHintOptions(): InternalParameterHintOptions {
	return validateParameterHintOptions(undefined);
}

function defaultInlayHintsOptions(): EditorInlayHintsOptions {
	return validateInlayHintsOptions(undefined);
}

function defaultUnicodeHighlightOptions(): InternalUnicodeHighlightOptions {
	return validateUnicodeHighlightOptions(undefined);
}

function defaultMinimapOptions(): EditorMinimapOptions {
	return validateMinimapOptions(undefined);
}

function defaultScrollbarOptions(): EditorScrollbarOptions {
	return validateScrollbarOptions(undefined);
}

function defaultStickyScrollOptions(): EditorStickyScrollOptions {
	return validateStickyScrollOptions(undefined);
}

function defaultBracketPairColorizationOptions(): BracketPairColorizationOptions {
	return validateBracketPairColorizationOptions(undefined);
}

function validateBooleanMap<T extends Record<string, true>>(input: unknown, defaultValue: T): T {
	if (!isRecord(input)) return defaultValue;
	const result: Record<string, true> = {};
	for (const [key, value] of Object.entries(input)) {
		if (value === true) result[key] = true;
	}
	return Object.freeze(result) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordsEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	if (leftKeys.length !== rightKeys.length) return false;
	return leftKeys.every(key => Object.is(left[key], right[key]));
}
