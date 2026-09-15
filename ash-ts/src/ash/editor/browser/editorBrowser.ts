import { type Event } from '../../base/common/event.js';
import { type IKeyboardEvent } from '../../base/browser/keyboardEvent.js';
import { type IMouseEvent, type IMouseWheelEvent } from '../../base/browser/mouseEvent.js';
import { type IDimension } from '../common/core/2d/dimension.js';
import { type IPosition, type Position } from '../common/core/position.js';
import { type IRange, type Range } from '../common/core/range.js';
import { type ISelection, type Selection } from '../common/core/selection.js';
import { type GlyphMarginLane, type ICursorStateComputer, type IIdentifiedSingleEditOperation, type IModelDecorationsChangeAccessor, type PositionAffinity } from '../common/model.js';
import { type IModelDeltaDecoration } from '../common/model.js';
import { type IModelContentChangedEvent, type IModelDecorationsChangedEvent } from '../common/textModelEvents.js';
import { type InjectedText } from '../common/modelLineProjectionData.js';
import { type ConfigurationChangedEvent, type EditorLayoutInfo, type EditorOption, type FindComputedEditorOptionValueById, type IComputedEditorOptions, type IEditorOptions, type OverviewRulerPosition } from '../common/config/editorOptions.js';
import { type ICommand, type IEditorContribution, type IEditorDecorationsCollection, type IModelChangedEvent, type INewScrollPosition, type ScrollType } from '../common/editorCommon.js';
import { type ITextModel } from '../common/model.js';
import { type ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { type IClipboardCopyEvent, type IClipboardPasteEvent } from './controller/editContext/clipboardUtils.js';
import { type MenuId } from '../../platform/actions/common/actions.js';
import { type TextModelEditSource } from '../common/textModelEditSource.js';
import { type IViewModel } from '../common/viewModel.js';
import { type OverviewRulerZone } from '../common/viewModel/overviewZoneManager.js';
import { type ICursorPositionChangedEvent, type ICursorSelectionChangedEvent } from '../common/cursorEvents.js';

export const enum MouseTargetType {
	UNKNOWN,
	TEXTAREA,
	GUTTER_GLYPH_MARGIN,
	GUTTER_LINE_NUMBERS,
	GUTTER_LINE_DECORATIONS,
	GUTTER_VIEW_ZONE,
	CONTENT_TEXT,
	CONTENT_EMPTY,
	CONTENT_VIEW_ZONE,
	CONTENT_WIDGET,
	OVERVIEW_RULER,
	SCROLLBAR,
	OVERLAY_WIDGET,
	OUTSIDE_EDITOR,
}

export interface IBaseMouseTarget {
	readonly element: HTMLElement | null;
	readonly position: Position | null;
	readonly mouseColumn: number;
	readonly range: Range | null;
}

export interface IMouseTargetUnknown extends IBaseMouseTarget {
	readonly type: MouseTargetType.UNKNOWN;
}

export interface IMouseTargetTextarea extends IBaseMouseTarget {
	readonly type: MouseTargetType.TEXTAREA;
	readonly position: null;
	readonly range: null;
}

export interface IMouseTargetMarginData {
	readonly isAfterLines: boolean;
	readonly glyphMarginLeft: number;
	readonly glyphMarginWidth: number;
	readonly glyphMarginLane?: GlyphMarginLane;
	readonly lineNumbersWidth: number;
	readonly offsetX: number;
}

export interface IMouseTargetMargin extends IBaseMouseTarget {
	readonly type: MouseTargetType.GUTTER_GLYPH_MARGIN | MouseTargetType.GUTTER_LINE_NUMBERS | MouseTargetType.GUTTER_LINE_DECORATIONS;
	readonly position: Position;
	readonly range: Range;
	readonly detail: IMouseTargetMarginData;
}

export interface IMouseTargetViewZoneData {
	readonly viewZoneId: string;
	readonly positionBefore: Position | null;
	readonly positionAfter: Position | null;
	readonly position: Position;
	readonly afterLineNumber: number;
}

export interface IMouseTargetViewZone extends IBaseMouseTarget {
	readonly type: MouseTargetType.GUTTER_VIEW_ZONE | MouseTargetType.CONTENT_VIEW_ZONE;
	readonly position: Position;
	readonly range: Range;
	readonly detail: IMouseTargetViewZoneData;
}

export interface IMouseTargetContentTextData {
	readonly mightBeForeignElement: boolean;
	readonly injectedText: InjectedText | null;
}

export interface IMouseTargetContentText extends IBaseMouseTarget {
	readonly type: MouseTargetType.CONTENT_TEXT;
	readonly position: Position;
	readonly range: Range;
	readonly detail: IMouseTargetContentTextData;
}

export interface IMouseTargetContentEmptyData {
	readonly isAfterLines: boolean;
	readonly horizontalDistanceToText?: number;
}

export interface IMouseTargetContentEmpty extends IBaseMouseTarget {
	readonly type: MouseTargetType.CONTENT_EMPTY;
	readonly position: Position;
	readonly range: Range;
	readonly detail: IMouseTargetContentEmptyData;
}

export interface IMouseTargetContentWidget extends IBaseMouseTarget {
	readonly type: MouseTargetType.CONTENT_WIDGET;
	readonly position: null;
	readonly range: null;
	readonly detail: string;
}

export interface IMouseTargetOverlayWidget extends IBaseMouseTarget {
	readonly type: MouseTargetType.OVERLAY_WIDGET;
	readonly position: null;
	readonly range: null;
	readonly detail: string;
}

export interface IMouseTargetScrollbar extends IBaseMouseTarget {
	readonly type: MouseTargetType.SCROLLBAR;
	readonly position: Position;
	readonly range: Range;
}

export interface IMouseTargetOverviewRuler extends IBaseMouseTarget {
	readonly type: MouseTargetType.OVERVIEW_RULER;
}

export interface IMouseTargetOutsideEditor extends IBaseMouseTarget {
	readonly type: MouseTargetType.OUTSIDE_EDITOR;
	readonly outsidePosition: 'above' | 'below' | 'left' | 'right';
	readonly outsideDistance: number;
}

export type IMouseTarget = IMouseTargetUnknown | IMouseTargetTextarea | IMouseTargetMargin | IMouseTargetViewZone | IMouseTargetContentText | IMouseTargetContentEmpty | IMouseTargetContentWidget | IMouseTargetOverlayWidget | IMouseTargetScrollbar | IMouseTargetOverviewRuler | IMouseTargetOutsideEditor;

export interface IEditorMouseEvent {
	readonly event: IMouseEvent;
	readonly target: IMouseTarget;
}

export interface IPartialEditorMouseEvent {
	readonly event: IMouseEvent;
	readonly target: IMouseTarget | null;
}

export interface IOverviewRuler {
	getDomNode(): HTMLElement;
	dispose(): void;
	setZones(zones: OverviewRulerZone[]): void;
	setLayout(position: OverviewRulerPosition): void;
}

/** Browser-facing contract shared by editor services and contributions. */
export interface ICodeEditor {
	readonly isSimpleWidget: boolean;
	readonly contextMenuId: MenuId;
	readonly onDidDispose: Event<void>;
	readonly onWillChangeModel: Event<IModelChangedEvent>;
	readonly onDidChangeModel: Event<IModelChangedEvent>;
	readonly onDidChangeModelContent: Event<IModelContentChangedEvent>;
	readonly onDidChangeModelDecorations: Event<IModelDecorationsChangedEvent>;
	readonly onDidChangeConfiguration: Event<ConfigurationChangedEvent>;
	readonly onDidAttemptReadOnlyEdit: Event<void>;
	readonly onDidLayoutChange: Event<EditorLayoutInfo>;
	readonly onDidChangeCursorPosition: Event<ICursorPositionChangedEvent>;
	readonly onDidChangeCursorSelection: Event<ICursorSelectionChangedEvent>;
	readonly onDidFocusEditorText: Event<void>;
	readonly onDidBlurEditorText: Event<void>;
	readonly onDidFocusEditorWidget: Event<void>;
	readonly onDidBlurEditorWidget: Event<void>;
	readonly onDidCompositionStart: Event<void>;
	readonly onDidCompositionEnd: Event<void>;
	readonly onDidType: Event<string>;
	readonly onDidPaste: Event<IClipboardPasteEvent>;
	readonly onWillCopy: Event<IClipboardCopyEvent>;
	readonly onWillCut: Event<IClipboardCopyEvent>;
	readonly onWillPaste: Event<IClipboardPasteEvent>;
	readonly onMouseUp: Event<IEditorMouseEvent>;
	readonly onMouseDown: Event<IEditorMouseEvent>;
	readonly onMouseDrag: Event<IEditorMouseEvent>;
	readonly onMouseDrop: Event<IPartialEditorMouseEvent>;
	readonly onMouseDropCanceled: Event<void>;
	readonly onDropIntoEditor: Event<{ readonly position: IPosition; readonly event: DragEvent }>;
	readonly onContextMenu: Event<IEditorMouseEvent>;
	readonly onMouseMove: Event<IEditorMouseEvent>;
	readonly onMouseLeave: Event<IPartialEditorMouseEvent>;
	readonly onMouseWheel: Event<IMouseWheelEvent>;
	readonly onKeyUp: Event<IKeyboardEvent>;
	readonly onKeyDown: Event<IKeyboardEvent>;
	readonly inComposition: boolean;
	getId(): string;
	focus(): void;
	hasTextFocus(): boolean;
	hasWidgetFocus(): boolean;
	getModel(): ITextModel | null;
	setModel(model: ITextModel | null): void;
	hasModel(): boolean;
	_getViewModel(): IViewModel | null;
	getPosition(): IPosition | null;
	getScrollTop(): number;
	getScrollLeft(): number;
	getContentHeight(): number;
	getContentWidth(): number;
	hasPendingScrollAnimation(): boolean;
	getVisibleRanges(): Range[];
	getTopForPosition(lineNumber: number, column: number): number;
	getTopForLineNumber(lineNumber: number): number;
	getBottomForLineNumber(lineNumber: number): number;
	setScrollTop(newScrollTop: number, scrollType?: ScrollType): void;
	setScrollLeft(newScrollLeft: number, scrollType?: ScrollType): void;
	setScrollPosition(position: INewScrollPosition, scrollType?: ScrollType): void;
	getSelection(): Selection | null;
	getSelections(): Selection[] | null;
	setPosition(position: IPosition, source?: string): void;
	setSelection(selection: IRange, source?: string): void;
	setSelection(selection: ISelection, source?: string): void;
	setSelections(selections: readonly ISelection[], source?: string): void;
	executeCommand(source: string | null | undefined, command: ICommand): void;
	executeEdits(source: string | null | undefined, edits: IIdentifiedSingleEditOperation[], endCursorState?: ICursorStateComputer | Selection[]): boolean;
	executeEdits(source: TextModelEditSource | undefined, edits: IIdentifiedSingleEditOperation[], endCursorState?: ICursorStateComputer | Selection[]): boolean;
	executeCommands(source: string | null | undefined, commands: (ICommand | null)[]): void;
	pushUndoStop(): boolean;
	trigger(source: string | null | undefined, handlerId: string, payload: unknown): void;
	getContribution<T extends IEditorContribution>(id: string): T | null;
	invokeWithinContext<T>(fn: (accessor: ServicesAccessor) => T): T;
	getContainerDomNode(): HTMLElement;
	getDomNode(): HTMLElement | null;
	getLayoutInfo(): EditorLayoutInfo;
	updateOptions(newOptions: Readonly<IEditorOptions> | undefined): void;
	getOptions(): IComputedEditorOptions;
	getOption<T extends EditorOption>(id: T): FindComputedEditorOptionValueById<T>;
	getRawOptions(): IEditorOptions;
	getScrolledVisiblePosition(position: IPosition): { top: number; left: number; height: number } | null;
	getWidthOfLine(lineNumber: number): number;
	applyFontInfo(target: HTMLElement): void;
	createDecorationsCollection(decorations?: IModelDeltaDecoration[]): IEditorDecorationsCollection;
	changeDecorations<T>(callback: (changeAccessor: IModelDecorationsChangeAccessor) => T): T | null;
	removeDecorations(decorationIds: string[]): void;
	removeDecorationsByType(key: string): void;
	addContentWidget(widget: IContentWidget): void;
	layoutContentWidget(widget: IContentWidget): void;
	removeContentWidget(widget: IContentWidget): void;
	addOverlayWidget(widget: IOverlayWidget): void;
	layoutOverlayWidget(widget: IOverlayWidget): void;
	removeOverlayWidget(widget: IOverlayWidget): void;
	addGlyphMarginWidget(widget: IGlyphMarginWidget): void;
	layoutGlyphMarginWidget(widget: IGlyphMarginWidget): void;
	removeGlyphMarginWidget(widget: IGlyphMarginWidget): void;
	changeViewZones(callback: (accessor: IViewZoneChangeAccessor) => void): void;
	revealRange(range: Range, scrollType?: ScrollType): void;
}

export interface PastePayload {
	text: string;
	pasteOnNewLine: boolean;
	multicursorText: string[] | null;
	mode: string | null;
	clipboardEvent?: ClipboardEvent;
}

export interface IDiffEditor {
	getId(): string;
}

export interface IViewZone {
	afterLineNumber: number;
	afterColumn?: number;
	afterColumnAffinity?: PositionAffinity;
	showInHiddenAreas?: boolean;
	heightInLines?: number;
	heightInPx?: number;
	ordinal?: number;
	minWidthInPx?: number;
	suppressMouseDown?: boolean;
	readonly domNode: HTMLElement;
	readonly marginDomNode?: HTMLElement | null;
	onDomNodeTop?: (top: number) => void;
	onComputedHeight?: (height: number) => void;
}

export interface IViewZoneChangeAccessor {
	addZone(zone: IViewZone): string;
	removeZone(id: string): void;
	layoutZone(id: string): void;
}

export const enum ContentWidgetPositionPreference {
	EXACT,
	ABOVE,
	BELOW,
}

export interface IContentWidgetPosition {
	readonly position: IPosition | null;
	readonly secondaryPosition?: IPosition | null;
	readonly preference: ContentWidgetPositionPreference[];
	readonly positionAffinity?: PositionAffinity;
}

export interface IContentWidget {
	readonly allowEditorOverflow?: boolean;
	readonly useDisplayNone?: boolean;
	readonly suppressMouseDown?: boolean;
	getId(): string;
	getDomNode(): HTMLElement;
	getPosition(): IContentWidgetPosition | null;
	beforeRender?(): IDimension | null;
	afterRender?(position: ContentWidgetPositionPreference | null, coordinate: IContentWidgetRenderedCoordinate | null): void;
}

export interface IContentWidgetRenderedCoordinate {
	readonly top: number;
	readonly left: number;
}

export interface IGlyphMarginWidget {
	getId(): string;
	getDomNode(): HTMLElement;
	getPosition(): IGlyphMarginWidgetPosition;
}

export interface IGlyphMarginWidgetPosition {
	readonly lane: GlyphMarginLane;
	readonly zIndex: number;
	readonly range: IRange;
}

export const enum OverlayWidgetPositionPreference {
	TOP_RIGHT_CORNER,
	BOTTOM_RIGHT_CORNER,
	TOP_CENTER,
}

export interface IOverlayWidgetPositionCoordinates {
	readonly top: number;
	readonly left: number;
}

export interface IOverlayWidgetPosition {
	readonly preference: OverlayWidgetPositionPreference | IOverlayWidgetPositionCoordinates | null;
	readonly stackOrdinal?: number;
}

export interface IOverlayWidget {
	readonly onDidLayout?: Event<void>;
	readonly allowEditorOverflow?: boolean;
	getId(): string;
	getDomNode(): HTMLElement;
	getPosition(): IOverlayWidgetPosition | null;
	getMinContentWidthInPx?(): number;
}

export interface IEditorAriaOptions {
	activeDescendant: string | undefined;
	role?: string;
}
