/** Selects one visual side when a model position has multiple rendered locations. */
export enum PositionAffinity {
	Left = 0,
	Right = 1,
	None = 2,
	LeftOfInjectedText = 3,
	RightOfInjectedText = 4,
}

/** Configures text projected into a view without changing model contents. */
export interface InjectedTextOptions {
	readonly content: string;
	readonly tokens?: TokenArray | null;
	readonly inlineClassName?: string | null;
	readonly inlineClassNameAffectsLetterSpacing?: boolean;
	readonly widthInEm?: number;
	readonly attachedData?: unknown;
	readonly cursorStops?: InjectedTextCursorStops | null;
}

export enum InjectedTextCursorStops {
	Both,
	Right,
	Left,
	None,
}

/** Text direction for a decoration. */
export enum TextDirection {
	LTR = 0,
	RTL = 1,
}

/** Vertical lane in the glyph margin. */
export enum GlyphMarginLane {
	Left = 1,
	Center = 2,
	Right = 3,
}

export interface IGlyphMarginLanesModel {
	readonly requiredLanes: number;
	getLanesAtLine(lineNumber: number): GlyphMarginLane[];
	reset(maxLine: number): void;
	push(lane: GlyphMarginLane, range: Range, persist?: boolean): void;
}

export enum OverviewRulerLane {
	Left = 1,
	Center = 2,
	Right = 4,
	Full = 7,
}

export const enum MinimapPosition {
	Inline = 1,
	Gutter = 2,
}

export const enum MinimapSectionHeaderStyle {
	Normal = 1,
	Underlined = 2,
}

export interface IDecorationOptions {
	color: string | ThemeColor | undefined;
	darkColor?: string | ThemeColor;
}

export interface IModelDecorationGlyphMarginOptions {
	position: GlyphMarginLane;
	persistLane?: boolean;
}

export interface IModelDecorationOverviewRulerOptions extends IDecorationOptions {
	position: OverviewRulerLane;
}

export interface IModelDecorationMinimapOptions extends IDecorationOptions {
	position: MinimapPosition;
	sectionHeaderStyle?: MinimapSectionHeaderStyle | null;
	sectionHeaderText?: string | null;
}

export interface IModelDecorationOptions {
	description: string;
	stickiness?: TrackedRangeStickiness;
	className?: string | null;
	shouldFillLineOnLineBreak?: boolean | null;
	blockClassName?: string | null;
	blockIsAfterEnd?: boolean | null;
	blockDoesNotCollapse?: boolean | null;
	blockPadding?: [top: number, right: number, bottom: number, left: number] | null;
	glyphMarginHoverMessage?: IMarkdownString | IMarkdownString[] | null;
	hoverMessage?: IMarkdownString | IMarkdownString[] | null;
	lineNumberHoverMessage?: IMarkdownString | IMarkdownString[] | null;
	isWholeLine?: boolean;
	showIfCollapsed?: boolean;
	collapseOnReplaceEdit?: boolean;
	zIndex?: number;
	overviewRuler?: IModelDecorationOverviewRulerOptions | null;
	minimap?: IModelDecorationMinimapOptions | null;
	glyphMarginClassName?: string | null;
	glyphMargin?: IModelDecorationGlyphMarginOptions | null;
	lineHeight?: number | null;
	fontFamily?: string | null;
	fontSize?: string | null;
	fontWeight?: string | null;
	fontStyle?: string | null;
	linesDecorationsClassName?: string | null;
	linesDecorationsTooltip?: string | null;
	lineNumberClassName?: string | null;
	firstLineDecorationClassName?: string | null;
	/** SVG icon rendered inside the first-line decoration; the class remains its layout and interaction hook. */
	firstLineDecorationIcon?: Icon | null;
	marginClassName?: string | null;
	inlineClassName?: string | null;
	inlineClassNameAffectsLetterSpacing?: boolean;
	beforeContentClassName?: string | null;
	afterContentClassName?: string | null;
	after?: InjectedTextOptions | null;
	before?: InjectedTextOptions | null;
	hideInCommentTokens?: boolean | null;
	hideInStringTokens?: boolean | null;
	affectsFont?: boolean | null;
	textDirection?: TextDirection | null;
}

export interface IModelDeltaDecoration {
	range: IRange;
	options: IModelDecorationOptions;
}

export interface IModelDecoration {
	readonly id: string;
	readonly ownerId: number;
	readonly range: Range;
	readonly options: IModelDecorationOptions;
}

export interface IModelDecorationsChangeAccessor {
	addDecoration(range: IRange, options: IModelDecorationOptions): string;
	changeDecoration(id: string, range: IRange): void;
	changeDecorationOptions(id: string, options: IModelDecorationOptions): void;
	removeDecoration(id: string): void;
	deltaDecorations(oldDecorations: readonly string[], newDecorations: readonly IModelDeltaDecoration[]): string[];
}

/** Describes how a tracked range grows when typing at its edges. */
export enum TrackedRangeStickiness {
	AlwaysGrowsWhenTypingAtEdges = 0,
	NeverGrowsWhenTypingAtEdges = 1,
	GrowsOnlyWhenTypingBefore = 2,
	GrowsOnlyWhenTypingAfter = 3,
}

/** End-of-line character preference for language edits. */
export const enum EndOfLineSequence {
	LF = 0,
	CRLF = 1,
}

export const enum EndOfLinePreference {
	TextDefined = 0,
	LF = 1,
	CRLF = 2,
}

export const enum DefaultEndOfLine {
	LF = 1,
	CRLF = 2,
}

export interface BracketPairColorizationOptions {
	enabled: boolean;
	independentColorPoolPerBracketType: boolean;
}

export interface ITextModelCreationOptions {
	tabSize: number;
	indentSize: number | 'tabSize';
	insertSpaces: boolean;
	detectIndentation: boolean;
	trimAutoWhitespace: boolean;
	defaultEOL: DefaultEndOfLine;
	isForSimpleWidget: boolean;
	largeFileOptimizations: boolean;
	bracketPairColorizationOptions: BracketPairColorizationOptions;
}

export interface ITextModelUpdateOptions {
	tabSize?: number;
	indentSize?: number | 'tabSize';
	insertSpaces?: boolean;
	trimAutoWhitespace?: boolean;
	bracketColorizationOptions?: BracketPairColorizationOptions;
}

export class FindMatch {
	_findMatchBrand: void = undefined;

	public constructor(
		public readonly range: Range,
		public readonly matches: string[] | null,
	) {}
}

export class TextModelResolvedOptions {
	_textModelResolvedOptionsBrand: void = undefined;

	public readonly tabSize: number;
	public readonly indentSize: number;
	private readonly _indentSizeIsTabSize: boolean;
	public readonly insertSpaces: boolean;
	public readonly defaultEOL: DefaultEndOfLine;
	public readonly trimAutoWhitespace: boolean;
	public readonly bracketPairColorizationOptions: BracketPairColorizationOptions;

	public get originalIndentSize(): number | 'tabSize' {
		return this._indentSizeIsTabSize ? 'tabSize' : this.indentSize;
	}

	public constructor(source: {
		readonly tabSize: number;
		readonly indentSize: number | 'tabSize';
		readonly insertSpaces: boolean;
		readonly defaultEOL: DefaultEndOfLine;
		readonly trimAutoWhitespace: boolean;
		readonly bracketPairColorizationOptions: BracketPairColorizationOptions;
	}) {
		this.tabSize = Math.max(1, source.tabSize | 0);
		this._indentSizeIsTabSize = source.indentSize === 'tabSize';
		this.indentSize = this._indentSizeIsTabSize ? this.tabSize : Math.max(1, (source.indentSize as number) | 0);
		this.insertSpaces = Boolean(source.insertSpaces);
		this.defaultEOL = source.defaultEOL | 0;
		this.trimAutoWhitespace = Boolean(source.trimAutoWhitespace);
		this.bracketPairColorizationOptions = source.bracketPairColorizationOptions;
	}

	public equals(other: TextModelResolvedOptions): boolean {
		return this.tabSize === other.tabSize
			&& this._indentSizeIsTabSize === other._indentSizeIsTabSize
			&& this.indentSize === other.indentSize
			&& this.insertSpaces === other.insertSpaces
			&& this.defaultEOL === other.defaultEOL
			&& this.trimAutoWhitespace === other.trimAutoWhitespace
			&& this.bracketPairColorizationOptions.enabled === other.bracketPairColorizationOptions.enabled
			&& this.bracketPairColorizationOptions.independentColorPoolPerBracketType === other.bracketPairColorizationOptions.independentColorPoolPerBracketType;
	}

	public createChangeEvent(newOptions: TextModelResolvedOptions): IModelOptionsChangedEvent {
		return {
			tabSize: this.tabSize !== newOptions.tabSize,
			indentSize: this.indentSize !== newOptions.indentSize,
			insertSpaces: this.insertSpaces !== newOptions.insertSpaces,
			trimAutoWhitespace: this.trimAutoWhitespace !== newOptions.trimAutoWhitespace,
		};
	}
}

/** Text snapshot consumed sequentially by model clients. */
export interface ITextSnapshot {
	read(): string | null;
}

export interface ISingleEditOperationIdentifier {
	major: number;
	minor: number;
}

/** A single edit operation carrying the command that produced it. */
export interface IIdentifiedSingleEditOperation extends ISingleEditOperation {
	identifier?: ISingleEditOperationIdentifier | null;
	isAutoWhitespaceEdit?: boolean;
	_isTracked?: boolean;
}

export interface IValidEditOperation {
	identifier: ISingleEditOperationIdentifier | null;
	range: Range;
	text: string;
	textChange: TextChange;
}

/** Computes cursor state from the inverse operations returned by the text buffer. */
export interface ICursorStateComputer {
	(inverseEditOperations: IValidEditOperation[]): Selection[] | null;
}

export interface IInternalModelContentChange extends TextModelContentChange {
	readonly forceMoveMarkers: boolean;
}

export class ValidAnnotatedEditOperation implements IIdentifiedSingleEditOperation {
	constructor(
		public readonly identifier: ISingleEditOperationIdentifier | null,
		public readonly range: Range,
		public readonly text: string | null,
		public readonly forceMoveMarkers: boolean,
		public readonly isAutoWhitespaceEdit: boolean,
		public readonly _isTracked: boolean,
	) {}
}

export class ApplyEditsResult {
	constructor(
		public readonly reverseEdits: IValidEditOperation[] | null,
		public readonly changes: IInternalModelContentChange[],
		public readonly trimAutoWhitespaceLineNumbers: number[] | null,
	) {}
}

export class SearchData {
	constructor(
		public readonly regex: RegExp,
		public readonly wordSeparators: WordCharacterClassifier | null,
		public readonly simpleSearch: string | null,
	) {}
}

/** Internal text and physical-line storage contract owned by TextModel. */
export interface ITextBuffer extends IDisposable {
	readonly onDidChangeContent: Event<void>;
	equals(other: ITextBuffer): boolean;
	mightContainRTL(): boolean;
	mightContainUnusualLineTerminators(): boolean;
	resetMightContainUnusualLineTerminators(): void;
	mightContainNonBasicASCII(): boolean;
	getBOM(): string;
	getEOL(): '\n' | '\r\n';
	createSnapshot(preserveBOM?: boolean): TextBufferSnapshot;
	getOffsetAt(lineNumber: number, column: number): number;
	getPositionAt(offset: number): Position;
	getRangeAt(start: number, length: number): Range;
	getValueInRange(range: Range, eol?: EndOfLinePreference): string;
	getValueLengthInRange(range: Range, eol?: EndOfLinePreference): number;
	getCharacterCountInRange(range: Range, eol?: EndOfLinePreference): number;
	getNearestChunk(offset: number): string;
	getLength(): number;
	getLineCount(): number;
	getLinesContent(): string[];
	getLineContent(lineNumber: number): string;
	getLineCharCode(lineNumber: number, index: number): number;
	getCharCode(offset: number): number;
	getLineLength(lineNumber: number): number;
	getLineMinColumn(lineNumber: number): number;
	getLineMaxColumn(lineNumber: number): number;
	getLineFirstNonWhitespaceColumn(lineNumber: number): number;
	getLineLastNonWhitespaceColumn(lineNumber: number): number;
	findMatchesLineByLine(searchRange: Range, searchData: SearchData, captureMatches: boolean, limitResultCount: number): FindMatch[];
	setEOL(eol: '\n' | '\r\n'): void;
	applyEdits(rawOperations: ValidAnnotatedEditOperation[], recordTrimAutoWhitespace: boolean, computeUndoEdits: boolean): ApplyEditsResult;
	maintainIfNeeded(): boolean;
	needsMaintenance(): boolean;
	maintain(): void;
}

/** Incremental construction contract for large or streamed text sources. */
export interface ITextBufferBuilder {
	acceptChunk(chunk: string): void;
	finish(normalizeEOL?: boolean): ITextBufferFactory;
}

export interface ITextBufferFactory {
	create(defaultEOL: DefaultEndOfLine): { textBuffer: ITextBuffer; disposable: IDisposable };
	getFirstLineText(lengthLimit: number): string;
}

export interface IAttachedView {
	setVisibleLines(visibleLines: { startLineNumber: number; endLineNumber: number }[], stabilized: boolean): void;
}

export function isITextSnapshot(value: unknown): value is ITextSnapshot {
	return !!value && typeof (value as ITextSnapshot).read === 'function';
}

/**
 * Editor-facing text model contract. The interface grows with supported editor
 * capabilities while preserving VS Code's ownership and method names.
 */
export interface ITextModel extends IDisposable {
	readonly guides: IGuidesTextModelPart;
	readonly bracketPairs: IBracketPairsTextModelPart;
	readonly tokenization: ITokenizationTextModelPart;
	readonly uri: URI;
	readonly id: string;
	readonly isForSimpleWidget: boolean;
	readonly onWillDispose: Event<void>;
	readonly onDidChangeLanguage: Event<IModelLanguageChangedEvent>;
	readonly onDidChangeLanguageConfiguration: Event<IModelLanguageConfigurationChangedEvent>;
	readonly onDidChangeTokens: Event<IModelTokensChangedEvent>;
	readonly onDidChangeLineHeight: Event<ModelLineHeightChangedEvent>;
	readonly onDidChangeFont: Event<ModelFontChangedEvent>;
	readonly onDidChangeOptions: Event<IModelOptionsChangedEvent>;
	readonly onDidChangeContent: Event<TextModelChange>;
	readonly onDidChangeDecorations: Event<IModelDecorationsChangedEvent>;
	readonly onDidChangeAttached: Event<void>;
	isDisposed(): boolean;
	dispose(): void;
	onBeforeAttached(): IAttachedView;
	onBeforeDetached(view: IAttachedView): void;
	isAttachedToEditor(): boolean;
	getAttachedEditorCount(): number;
	registerViewModel(viewModel: IViewModel): void;
	unregisterViewModel(viewModel: IViewModel): void;
	_getTrackedRange(id: string): Range | null;
	_setTrackedRange(id: string | null, newRange: null, newStickiness: TrackedRangeStickiness): null;
	_setTrackedRange(id: string | null, newRange: Range, newStickiness: TrackedRangeStickiness): string;
	changeDecorations<T>(callback: (changeAccessor: IModelDecorationsChangeAccessor) => T, ownerId?: number): T | null;
	deltaDecorations(oldDecorations: string[], newDecorations: IModelDeltaDecoration[], ownerId?: number): string[];
	removeAllDecorationsWithOwnerId(ownerId: number): void;
	getDecorationRange(id: string): Range | null;
	getDecorationOptions(id: string): IModelDecorationOptions | null;
	getLineDecorations(lineNumber: number, ownerId?: number, filterOutValidation?: boolean, filterFontDecorations?: boolean): IModelDecoration[];
	getLinesDecorations(startLineNumber: number, endLineNumber: number, ownerId?: number, filterOutValidation?: boolean, filterFontDecorations?: boolean): IModelDecoration[];
	getAllDecorations(ownerId?: number, filterOutValidation?: boolean, filterFontDecorations?: boolean): IModelDecoration[];
	getAllMarginDecorations(ownerId?: number): IModelDecoration[];
	getDecorationsInRange(range: IRange, ownerId?: number, filterOutValidation?: boolean, filterFontDecorations?: boolean, onlyMinimapDecorations?: boolean, onlyMarginDecorations?: boolean): IModelDecoration[];
	getLineInjectedText(lineNumber: number, ownerId?: number): LineInjectedText[];
	getInjectedTextDecorations(ownerId?: number): IModelDecoration[];
	getOverviewRulerDecorations(ownerId?: number, filterOutValidation?: boolean, filterFontDecorations?: boolean): IModelDecoration[];
	getFontDecorationsInRange(range: IRange, ownerId?: number): IModelDecoration[];
	getCustomLineHeightsDecorations(ownerId?: number): IModelDecoration[];
	getCustomLineHeightsDecorationsInRange(range: Range, ownerId?: number): IModelDecoration[];
	pushStackElement(): void;
	popStackElement(): void;
	edit(edit: TextEdit, options?: { reason?: TextModelEditSource }): void;
	pushEditOperations(beforeCursorState: Selection[] | null, editOperations: IIdentifiedSingleEditOperation[], cursorStateComputer: ICursorStateComputer): Selection[] | null;
	pushEditOperations(beforeCursorState: Selection[] | null, editOperations: IIdentifiedSingleEditOperation[], cursorStateComputer: ICursorStateComputer, group?: UndoRedoGroup, reason?: TextModelEditSource): Selection[] | null;
	applyEdits(operations: readonly IIdentifiedSingleEditOperation[]): void;
	applyEdits(operations: readonly IIdentifiedSingleEditOperation[], reason: TextModelEditSource): void;
	applyEdits(operations: readonly IIdentifiedSingleEditOperation[], computeUndoEdits: false): void;
	applyEdits(operations: readonly IIdentifiedSingleEditOperation[], computeUndoEdits: true): IValidEditOperation[];
	_applyUndo(changes: TextChange[], eol: EndOfLineSequence, resultingAlternativeVersionId: number, resultingSelection: Selection[] | null): void;
	_applyRedo(changes: TextChange[], eol: EndOfLineSequence, resultingAlternativeVersionId: number, resultingSelection: Selection[] | null): void;
	mightContainRTL(): boolean;
	mightContainUnusualLineTerminators(): boolean;
	removeUnusualLineTerminators(selections?: Selection[]): void;
	mightContainNonBasicASCII(): boolean;
	isDominatedByLongLines(): boolean;
	isTooLargeForSyncing(): boolean;
	isTooLargeForTokenization(): boolean;
	isTooLargeForHeapOperation(): boolean;
	findMatches(searchString: string, searchOnlyEditableRange: boolean, isRegex: boolean, matchCase: boolean, wordSeparators: string | null, captureMatches: boolean, limitResultCount?: number): FindMatch[];
	findMatches(searchString: string, searchScope: IRange | IRange[], isRegex: boolean, matchCase: boolean, wordSeparators: string | null, captureMatches: boolean, limitResultCount?: number): FindMatch[];
	findNextMatch(searchString: string, searchStart: IPosition, isRegex: boolean, matchCase: boolean, wordSeparators: string | null, captureMatches: boolean): FindMatch | null;
	findPreviousMatch(searchString: string, searchStart: IPosition, isRegex: boolean, matchCase: boolean, wordSeparators: string | null, captureMatches: boolean): FindMatch | null;
	getLanguageId(): string;
	setLanguage(languageId: string | ILanguageSelection, source?: string): void;
	getWordAtPosition(position: IPosition): IWordAtPosition | null;
	getWordUntilPosition(position: IPosition): IWordAtPosition;
	getOptions(): TextModelResolvedOptions;
	getFormattingOptions(): FormattingOptions;
	getVersionId(): number;
	getAlternativeVersionId(): number;
	setValue(newValue: string | ITextSnapshot): void;
	equalsTextBuffer(other: ITextBuffer): boolean;
	getTextBuffer(): ITextBuffer;
	getValue(eol?: EndOfLinePreference, preserveBOM?: boolean): string;
	createSnapshot(preserveBOM?: boolean): ITextSnapshot;
	getValueLength(eol?: EndOfLinePreference, preserveBOM?: boolean): number;
	getValueInRange(range: IRange, eol?: EndOfLinePreference): string;
	getValueLengthInRange(range: IRange, eol?: EndOfLinePreference): number;
	getCharacterCountInRange(range: IRange, eol?: EndOfLinePreference): number;
	getLineCount(): number;
	getLineContent(lineNumber: number): string;
	getLineLength(lineNumber: number): number;
	getLinesContent(): string[];
	getEOL(): string;
	getEndOfLineSequence(): EndOfLineSequence;
	pushEOL(eol: EndOfLineSequence, reason?: TextModelEditSource): void;
	setEOL(eol: EndOfLineSequence): void;
	getLineMinColumn(lineNumber: number): number;
	getLineMaxColumn(lineNumber: number): number;
	getLineFirstNonWhitespaceColumn(lineNumber: number): number;
	getLineLastNonWhitespaceColumn(lineNumber: number): number;
	getFullModelRange(): Range;
	modifyPosition(position: IPosition, offset: number): Position;
	getOffsetAt(position: IPosition): number;
	getPositionAt(offset: number): Position;
	validatePosition(position: IPosition): Position;
	validateRange(range: IRange): Range;
	isValidRange(range: IRange): boolean;
	getLanguageIdAtPosition(lineNumber: number, column: number): string;
	canUndo(): boolean;
	undo(): TextModelChange | undefined;
	canRedo(): boolean;
	redo(): TextModelChange | undefined;
	normalizePosition(position: Position, affinity: PositionAffinity): Position;
	getLineIndentColumn(lineNumber: number): number;
	normalizeIndentation(str: string): string;
	updateOptions(newOptions: ITextModelUpdateOptions): void;
	detectIndentation(defaultInsertSpaces: boolean, defaultTabSize: number): void;
}
import type { Event } from '../../base/common/event.js';
import type { Icon } from '../../base/common/icon.js';
import type { IMarkdownString } from '../../base/common/htmlContent.js';
import type { IDisposable } from '../../base/common/lifecycle.js';
import type { ThemeColor } from '../../base/common/themables.js';
import type { URI } from '../../base/common/uri.js';
import type { IPosition, Position } from './core/position.js';
import type { IRange, Range } from './core/range.js';
import type { Selection } from './core/selection.js';
import type { IWordAtPosition } from './core/wordHelper.js';
import type { WordCharacterClassifier } from './core/wordCharacterClassifier.js';
import type { ILanguageSelection } from './languages/language.js';
import type { FormattingOptions } from './languages.js';
import type { TextEdit } from './core/edits/textEdit.js';
import type { ISingleEditOperation } from './core/editOperation.js';
import type { IModelDecorationsChangedEvent, IModelLanguageChangedEvent, IModelLanguageConfigurationChangedEvent, IModelOptionsChangedEvent, IModelTokensChangedEvent, ModelFontChangedEvent, ModelLineHeightChangedEvent } from './textModelEvents.js';
import { TextChange, type TextModelChange, type TextModelContentChange } from './core/textChange.js';
import type { TextModelEditSource } from './textModelEditSource.js';
import type { UndoRedoGroup } from '../../platform/undoRedo/common/undoRedo.js';
import type { ITokenizationTextModelPart } from './tokenizationTextModelPart.js';
import type { IGuidesTextModelPart } from './textModelGuides.js';
import type { IBracketPairsTextModelPart } from './textModelBracketPairs.js';
import type { LineInjectedText } from './textModelEvents.js';
import type { TokenArray } from './tokens/lineTokens.js';
import type { IViewModel } from './viewModel.js';

export interface TextBufferSnapshot {
	readonly length: number;
	readonly lineCount: number;
	getText(): string;
	getTextBetweenOffsets(startOffset: number, endOffset: number): string;
}
