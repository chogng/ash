import type { Event } from '../../base/common/event.js';
import type { IMarkdownString } from '../../base/common/htmlContent.js';
import type { IDisposable } from '../../base/common/lifecycle.js';
import type { ThemeColor } from '../../base/common/themables.js';
import type { URI, UriComponents } from '../../base/common/uri.js';
import type { ICommandMetadata } from '../../platform/commands/common/commands.js';
import type { IEditorOptions } from './config/editorOptions.js';
import type { IDimension } from './core/2d/dimension.js';
import type { IRange, Range } from './core/range.js';
import type { IPosition, Position } from './core/position.js';
import type { ISelection, Selection } from './core/selection.js';
import type { IModelDecoration, IModelDecorationsChangeAccessor, IModelDeltaDecoration, ITextModel, IValidEditOperation, OverviewRulerLane, TrackedRangeStickiness } from './model.js';
import type { IModelDecorationsChangedEvent } from './textModelEvents.js';

export interface INewScrollPosition {
	scrollLeft?: number;
	scrollTop?: number;
}

export interface IScrollEvent {
	readonly scrollTop: number;
	readonly scrollLeft: number;
	readonly scrollWidth: number;
	readonly scrollHeight: number;
	readonly scrollTopChanged: boolean;
	readonly scrollLeftChanged: boolean;
	readonly scrollWidthChanged: boolean;
	readonly scrollHeightChanged: boolean;
}

export interface IContentSizeChangedEvent {
	readonly contentWidth: number;
	readonly contentHeight: number;
	readonly contentWidthChanged: boolean;
	readonly contentHeightChanged: boolean;
}


/** Collects edit operations and tracked selections for one editor command. */
export interface IEditOperationBuilder {
	addEditOperation(range: IRange, text: string | null, forceMoveMarkers?: boolean): void;
	addTrackedEditOperation(range: IRange, text: string | null, forceMoveMarkers?: boolean): void;
	trackSelection(selection: ISelection, trackPreviousOnEmpty?: boolean): string;
}

/** Supplies inverse edits and tracked selections after a command has run. */
export interface ICursorStateComputerData {
	getInverseEditOperations(): IValidEditOperation[];
	getTrackedSelection(id: string): Selection;
}

/** A model edit whose resulting selection is computed after the edits apply. */
export interface ICommand {
	readonly insertsAutoWhitespace?: boolean;
	getEditOperations(model: ITextModel, builder: IEditOperationBuilder): void;
	computeCursorState(model: ITextModel, helper: ICursorStateComputerData): Selection;
}

export interface IDiffEditorModel {
	original: ITextModel;
	modified: ITextModel;
}

export interface IDiffEditorViewModel extends IDisposable {
	readonly model: IDiffEditorModel;
	waitForDiff(): Promise<void>;
}

export interface IModelChangedEvent {
	readonly oldModelUrl: URI | null;
	readonly newModelUrl: URI | null;
}

export interface ITriggerEditorOperationEvent {
	source: string | null | undefined;
	handlerId: string;
	payload: unknown;
}

export interface IEditorAction {
	readonly id: string;
	readonly label: string;
	readonly alias: string;
	readonly metadata: ICommandMetadata | undefined;
	isSupported(): boolean;
	run(args?: unknown): Promise<void>;
}

export type IEditorModel = ITextModel | IDiffEditorModel | IDiffEditorViewModel;

/** A serializable state of one cursor. */
export interface ICursorState {
	inSelectionMode: boolean;
	selectionStart: IPosition;
	position: IPosition;
}

/** A serializable state of the editor view. */
export interface IViewState {
	scrollTop?: number;
	scrollTopWithoutViewZones?: number;
	scrollLeft: number;
	firstPosition: IPosition;
	firstPositionDeltaTop: number;
}

export interface ICodeEditorViewState {
	cursorState: ICursorState[];
	viewState: IViewState;
	contributionsState: { [id: string]: unknown };
}

export interface IDiffEditorViewState {
	original: ICodeEditorViewState | null;
	modified: ICodeEditorViewState | null;
	modelState?: unknown;
}

export type IEditorViewState = ICodeEditorViewState | IDiffEditorViewState;

export const enum ScrollType {
	Smooth = 0,
	Immediate = 1,
}

export interface IEditor {
	onDidDispose(listener: () => void): IDisposable;
	dispose(): void;
	getId(): string;
	getEditorType(): string;
	updateOptions(options: IEditorOptions): void;
	onVisible(): void;
	onHide(): void;
	layout(dimension?: IDimension, postponeRendering?: boolean): void;
	focus(): void;
	hasTextFocus(): boolean;
	getSupportedActions(): IEditorAction[];
	saveViewState(): IEditorViewState | null;
	restoreViewState(state: IEditorViewState | null): void;
	getVisibleColumnFromPosition(position: IPosition): number;
	getStatusbarColumn(position: IPosition): number;
	getPosition(): Position | null;
	setPosition(position: IPosition, source?: string): void;
	revealLine(lineNumber: number, scrollType?: ScrollType): void;
	revealLineInCenter(lineNumber: number, scrollType?: ScrollType): void;
	revealLineInCenterIfOutsideViewport(lineNumber: number, scrollType?: ScrollType): void;
	revealLineNearTop(lineNumber: number, scrollType?: ScrollType): void;
	revealPosition(position: IPosition, scrollType?: ScrollType): void;
	revealPositionInCenter(position: IPosition, scrollType?: ScrollType): void;
	revealPositionInCenterIfOutsideViewport(position: IPosition, scrollType?: ScrollType): void;
	revealPositionNearTop(position: IPosition, scrollType?: ScrollType): void;
	getSelection(): Selection | null;
	getSelections(): Selection[] | null;
	setSelection(selection: IRange, source?: string): void;
	setSelection(selection: Range, source?: string): void;
	setSelection(selection: ISelection, source?: string): void;
	setSelection(selection: Selection, source?: string): void;
	setSelections(selections: readonly ISelection[], source?: string): void;
	revealLines(startLineNumber: number, endLineNumber: number, scrollType?: ScrollType): void;
	revealLinesInCenter(startLineNumber: number, endLineNumber: number, scrollType?: ScrollType): void;
	revealLinesInCenterIfOutsideViewport(startLineNumber: number, endLineNumber: number, scrollType?: ScrollType): void;
	revealLinesNearTop(startLineNumber: number, endLineNumber: number, scrollType?: ScrollType): void;
	revealRange(range: IRange, scrollType?: ScrollType): void;
	revealRangeInCenter(range: IRange, scrollType?: ScrollType): void;
	revealRangeAtTop(range: IRange, scrollType?: ScrollType): void;
	revealRangeInCenterIfOutsideViewport(range: IRange, scrollType?: ScrollType): void;
	revealRangeNearTop(range: IRange, scrollType?: ScrollType): void;
	revealRangeNearTopIfOutsideViewport(range: IRange, scrollType?: ScrollType): void;
	trigger(source: string | null | undefined, handlerId: string, payload: unknown): void;
	getModel(): IEditorModel | null;
	setModel(model: IEditorModel | null): void;
	createDecorationsCollection(decorations?: IModelDeltaDecoration[]): IEditorDecorationsCollection;
	changeDecorations<T>(callback: (accessor: IModelDecorationsChangeAccessor) => T): T | null;
}

export interface IDiffEditor extends IEditor {
	getModel(): IDiffEditorModel | null;
	getOriginalEditor(): IEditor;
	getModifiedEditor(): IEditor;
}

export interface ICompositeCodeEditor {
	readonly onDidChangeActiveEditor: Event<ICompositeCodeEditor>;
	readonly activeCodeEditor: IEditor | undefined;
}

export interface IEditorDecorationsCollection {
	readonly onDidChange: Event<IModelDecorationsChangedEvent>;
	length: number;
	getRange(index: number): Range | null;
	getRanges(): Range[];
	has(decoration: IModelDecoration): boolean;
	set(decorations: readonly IModelDeltaDecoration[]): string[];
	append(decorations: readonly IModelDeltaDecoration[]): string[];
	clear(): void;
}

export interface IEditorContribution extends IDisposable {
	saveViewState?(): unknown;
	restoreViewState?(state: unknown): void;
}

export interface IDiffEditorContribution extends IDisposable {}

export function isThemeColor(value: unknown): value is ThemeColor {
	return typeof value === 'object' && value !== null && typeof (value as ThemeColor).id === 'string';
}

export interface IThemeDecorationRenderOptions {
	backgroundColor?: string | ThemeColor;
	outline?: string;
	outlineColor?: string | ThemeColor;
	outlineStyle?: string;
	outlineWidth?: string;
	border?: string;
	borderColor?: string | ThemeColor;
	borderRadius?: string;
	borderSpacing?: string;
	borderStyle?: string;
	borderWidth?: string;
	fontStyle?: string;
	fontWeight?: string;
	fontFamily?: string;
	fontSize?: string;
	lineHeight?: number;
	textDecoration?: string;
	cursor?: string;
	color?: string | ThemeColor;
	opacity?: string;
	letterSpacing?: string;
	gutterIconPath?: UriComponents;
	gutterIconSize?: string;
	overviewRulerColor?: string | ThemeColor;
	before?: IContentDecorationRenderOptions;
	after?: IContentDecorationRenderOptions;
	beforeInjectedText?: IContentDecorationRenderOptions & { affectsLetterSpacing?: boolean };
	afterInjectedText?: IContentDecorationRenderOptions & { affectsLetterSpacing?: boolean };
}

export interface IContentDecorationRenderOptions {
	contentText?: string;
	contentIconPath?: UriComponents;
	border?: string;
	borderColor?: string | ThemeColor;
	borderRadius?: string;
	fontStyle?: string;
	fontWeight?: string;
	fontSize?: string;
	fontFamily?: string;
	textDecoration?: string;
	color?: string | ThemeColor;
	backgroundColor?: string | ThemeColor;
	opacity?: string;
	verticalAlign?: string;
	margin?: string;
	padding?: string;
	width?: string;
	height?: string;
}

export interface IDecorationRenderOptions extends IThemeDecorationRenderOptions {
	isWholeLine?: boolean;
	rangeBehavior?: TrackedRangeStickiness;
	overviewRulerLane?: OverviewRulerLane;
	light?: IThemeDecorationRenderOptions;
	dark?: IThemeDecorationRenderOptions;
}

export interface IThemeDecorationInstanceRenderOptions {
	before?: IContentDecorationRenderOptions;
	after?: IContentDecorationRenderOptions;
}

export interface IDecorationInstanceRenderOptions extends IThemeDecorationInstanceRenderOptions {
	light?: IThemeDecorationInstanceRenderOptions;
	dark?: IThemeDecorationInstanceRenderOptions;
}

export interface IDecorationOptions {
	range: IRange;
	hoverMessage?: IMarkdownString | IMarkdownString[];
	renderOptions?: IDecorationInstanceRenderOptions;
}

export const EditorType = {
	ICodeEditor: 'vs.editor.ICodeEditor',
	IDiffEditor: 'vs.editor.IDiffEditor',
};

export const enum Handler {
	CompositionStart = 'compositionStart',
	CompositionEnd = 'compositionEnd',
	Type = 'type',
	ReplacePreviousChar = 'replacePreviousChar',
	CompositionType = 'compositionType',
	Paste = 'paste',
	Cut = 'cut',
}

export interface TypePayload {
	text: string;
}

export interface ReplacePreviousCharPayload {
	text: string;
	replaceCharCnt: number;
}

export interface CompositionTypePayload {
	text: string;
	replacePrevCharCnt: number;
	replaceNextCharCnt: number;
	positionDelta: number;
}
