import { type Event } from '../../../base/common/event.js';
import { Disposable, type IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { type IThemeService } from '../../../platform/theme/common/themeService.js';
import { type IEditorConfiguration } from '../config/editorConfiguration.js';
import { EditorLineWrapping, EditorOption, type FindComputedEditorOptionValueById } from '../config/editorOptions.js';
import { type ICoordinatesConverter } from '../coordinatesConverter.js';
import { CursorsController } from '../cursor/cursor.js';
import { CursorConfiguration, CursorState, EditOperationType, type IColumnSelectData, type PartialCursorState } from '../cursorCommon.js';
import { CursorChangeReason } from '../cursorEvents.js';
import { Position } from '../core/position.js';
import { Range } from '../core/range.js';
import { Selection, type ISelection } from '../core/selection.js';
import { type ICommand, type ICursorState, type IViewState, ScrollType } from '../editorCommon.js';
import { EditorTheme } from '../editorTheme.js';
import { type ILanguageConfigurationService } from '../languages/languageConfigurationRegistry.js';
import { TokenizationRegistry } from '../languages.js';
import { EndOfLinePreference, type IAttachedView, type ICursorStateComputer, type IIdentifiedSingleEditOperation, type ITextModel, PositionAffinity, TextDirection } from '../model.js';
import { TextModel } from '../model/textModel.js';
import { type ILineBreaksComputer, type ILineBreaksComputerContext, type ILineBreaksComputerFactory, type InjectedText } from '../modelLineProjectionData.js';
import { type IActiveIndentGuideInfo, type BracketGuideOptions, type IndentGuide } from '../textModelGuides.js';
import * as textModelEvents from '../textModelEvents.js';
import { type ViewEventHandler } from '../viewEventHandler.js';
import * as viewEvents from '../viewEvents.js';
import { type IViewModel, type IWhitespaceChangeAccessor, MinimapLinesRenderingData, OverviewRulerDecorationsGroup, ViewLineData, ViewLineRenderingData, ViewModelDecoration } from '../viewModel.js';
import {
	CursorStateChangedEvent,
	FocusChangedEvent,
	HiddenAreasChangedEvent,
	ModelContentChangedEvent,
	ModelTokensChangedEvent,
	type OutgoingViewModelEvent,
	ReadOnlyEditAttemptEvent,
	ScrollChangedEvent,
	ViewModelEventDispatcher,
	type ViewModelEventsCollector,
	ViewZonesChangedEvent,
	WidgetFocusChangedEvent,
} from '../viewModelEventDispatcher.js';
import { ViewLayout } from '../viewLayout/viewLayout.js';
import { GlyphMarginLanesModel } from './glyphLanesModel.js';
import { ViewModelDecorations } from './viewModelDecorations.js';
import { type IViewModelLines, ViewModelLinesFromModelAsIs, ViewModelLinesFromProjectedModel } from './viewModelLines.js';
import { type TextModelEditSource } from '../textModelEditSource.js';

const cursorOwners = new WeakMap<ViewModel, CursorsController>();

/** Owns editor-instance cursor, line projection, layout, and their events. */
export class ViewModel extends Disposable implements IViewModel {
	private readonly events = this._register(new ViewModelEventDispatcher());
	private readonly lines: IViewModelLines;
	private readonly cursor: CursorsController;
	private readonly decorations: ViewModelDecorations;
	private hasFocus = false;
	private previousSelections: Selection[];
	private collectedCursorEventDepth = 0;

	readonly onEvent: Event<OutgoingViewModelEvent> = this.events.onEvent;
	readonly coordinatesConverter: ICoordinatesConverter;
	readonly viewLayout: ViewLayout;
	readonly glyphLanes = new GlyphMarginLanesModel(0);
	cursorConfig: CursorConfiguration;

	constructor(
		private readonly editorId: number,
		private readonly configuration: IEditorConfiguration,
		readonly model: ITextModel,
		domLineBreaksComputerFactory: ILineBreaksComputerFactory,
		monospaceLineBreaksComputerFactory: ILineBreaksComputerFactory,
		scheduleAtNextAnimationFrame: (callback: () => void) => IDisposable,
		private readonly languageConfigurationService: ILanguageConfigurationService,
		themeService: IThemeService,
		private readonly attachedView: IAttachedView,
		private readonly transactionalTarget: IBatchableTarget,
	) {
		super();
		if (!(model instanceof TextModel)) throw new TypeError('ViewModel requires the editor text model implementation');
		const options = configuration.options;
		const fontInfo = options.get(EditorOption.fontInfo);
		const wrappingInfo = options.get(EditorOption.wrappingInfo);
		const lineBreaksComputerFactory: ILineBreaksComputerFactory = {
			createLineBreaksComputer: (context, currentFontInfo, ...args) => (
				currentFontInfo.isMonospace ? monospaceLineBreaksComputerFactory : domLineBreaksComputerFactory
			).createLineBreaksComputer(context, currentFontInfo, ...args),
		};
		this.lines = model.isTooLargeForTokenization()
			? this._register(new ViewModelLinesFromModelAsIs(model))
			: this._register(new ViewModelLinesFromProjectedModel(model, lineBreaksComputerFactory, fontInfo, model.getOptions().tabSize, {
				editorId,
				wrapping: wrappingInfo.wrappingColumn > 0 ? EditorLineWrapping.On : EditorLineWrapping.Off,
				wrapWidth: Math.max(0, wrappingInfo.wrappingColumn) * fontInfo.typicalHalfwidthCharacterWidth,
				wrappingIndent: options.get(EditorOption.wrappingIndent),
			}));
		this.coordinatesConverter = this.lines.createCoordinatesConverter();
		this.cursorConfig = new CursorConfiguration(model.getLanguageId(), model.getOptions(), configuration, this.languageConfigurationService);
		this.cursor = this._register(new CursorsController(model, this, this.coordinatesConverter, this.cursorConfig));
		cursorOwners.set(this, this.cursor);
		this.previousSelections = [...this.cursor.getSelections()];
		this.viewLayout = this._register(new ViewLayout(configuration, this.lines.getViewLineCount(), [], scheduleAtNextAnimationFrame));
		this.decorations = this._register(new ViewModelDecorations(editorId, model, configuration, this.lines, this.coordinatesConverter));
		this.connectLayout();
		this.connectCursor();
		if (this.lines instanceof ViewModelLinesFromProjectedModel) {
			this._register(this.lines.onDidChange(() => {
				this.withViewEventsCollector(eventsCollector => {
					this.decorations.onLineMappingChanged();
					this.viewLayout.onFlushed(this.lines.getViewLineCount(), []);
					eventsCollector.emitViewEvent(new viewEvents.ViewLineMappingChangedEvent());
					eventsCollector.emitViewEvent(new viewEvents.ViewDecorationsChangedEvent(null));
					this.cursor.onLineMappingChanged(eventsCollector);
				});
			}));
		}
		this._register(configuration.onDidChangeFast(event => {
			this.viewLayout.onConfigurationChanged(event);
			this.lines.setWrappingSettings(
				configuration.options.get(EditorOption.fontInfo),
				configuration.options.get(EditorOption.wrappingStrategy),
				configuration.options.get(EditorOption.wrappingInfo).wrappingColumn,
				configuration.options.get(EditorOption.wrappingIndent),
				configuration.options.get(EditorOption.wordBreak),
			);
			if (CursorConfiguration.shouldRecreate(event)) this.recreateCursorConfiguration();
			this.events.emitSingleViewEvent(new viewEvents.ViewConfigurationChangedEvent(event));
		}));
		this._register(model.onDidChangeLanguage(() => this.recreateCursorConfiguration()));
		this._register(model.onDidChangeLanguageConfiguration(() => {
			this.events.emitSingleViewEvent(new viewEvents.ViewLanguageConfigurationEvent());
			this.recreateCursorConfiguration();
		}));
		this._register(model.onDidChangeOptions(() => {
			this.withViewEventsCollector(eventsCollector => {
				if (this.lines.setTabSize(model.getOptions().tabSize)) {
					this.decorations.onLineMappingChanged();
					this.viewLayout.onFlushed(this.lines.getViewLineCount(), []);
					eventsCollector.emitViewEvent(new viewEvents.ViewFlushedEvent());
					eventsCollector.emitViewEvent(new viewEvents.ViewLineMappingChangedEvent());
					eventsCollector.emitViewEvent(new viewEvents.ViewDecorationsChangedEvent(null));
					this.cursor.onLineMappingChanged(eventsCollector);
				}
				this.recreateCursorConfiguration();
			});
		}));
		this._register(themeService.onDidColorThemeChange(theme => this.events.emitSingleViewEvent(new viewEvents.ViewThemeChangedEvent(theme))));
		this._register(model.onDidChangeDecorations(event => {
			this.decorations.onModelDecorationsChanged();
			this.events.emitSingleViewEvent(new viewEvents.ViewDecorationsChangedEvent(event));
		}));
		this._register(model.onDidChangeTokens(event => {
			const ranges = event.ranges.map(range => ({
				fromLineNumber: this.coordinatesConverter.convertModelPositionToViewPosition(new Position(range.fromLineNumber, 1)).lineNumber,
				toLineNumber: this.coordinatesConverter.convertModelPositionToViewPosition(new Position(range.toLineNumber, model.getLineMaxColumn(range.toLineNumber))).lineNumber,
			}));
			this.events.emitSingleViewEvent(new viewEvents.ViewTokensChangedEvent(ranges));
			this.events.emitOutgoingEvent(new ModelTokensChangedEvent(event));
		}));
		model.registerViewModel(this);
		this._register(toDisposable(() => model.unregisterViewModel(this)));
	}

	getEditorOption<T extends EditorOption>(id: T): FindComputedEditorOptionValueById<T> {
		return this.configuration.options.get(id);
	}

	createLineBreaksComputer(context?: ILineBreaksComputerContext): ILineBreaksComputer {
		return this.lines.createLineBreaksComputer(context);
	}

	setViewport(startLineNumber: number, endLineNumber: number, _centeredLineNumber: number): void {
		const start = this.coordinatesConverter.convertViewPositionToModelPosition(new Position(startLineNumber, 1)).lineNumber;
		const end = this.coordinatesConverter.convertViewPositionToModelPosition(new Position(endLineNumber, this.getLineMaxColumn(endLineNumber))).lineNumber;
		for (let lineNumber = start; lineNumber <= end; lineNumber += 1) this.model.tokenization.tokenizeIfCheap(lineNumber);
	}

	getFontSizeAtPosition(position: Position): string | null {
		if (!this.configuration.options.get(EditorOption.effectiveAllowVariableFonts)) return null;
		const modelPosition = this.coordinatesConverter.convertViewPositionToModelPosition(Position.lift(position));
		const decoration = this.model.getFontDecorationsInRange(Range.fromPositions(modelPosition), this.editorId)
			.find(value => value.options.fontSize);
		return decoration?.options.fontSize ?? `${this.configuration.options.get(EditorOption.fontInfo).fontSize}px`;
	}

	getMinimapDecorationsInRange(range: Range): ViewModelDecoration[] {
		return this.decorations.getMinimapDecorationsInRange(range);
	}

	getDecorationsInViewport(visibleRange: Range): ViewModelDecoration[] {
		return this.decorations.getDecorationsViewportData(visibleRange).decorations;
	}

	getTextDirection(lineNumber: number): TextDirection {
		const content = this.getLineContent(lineNumber);
		return /[\u0590-\u08ff]/u.test(content) ? TextDirection.RTL : TextDirection.LTR;
	}

	getViewportViewLineRenderingData(_visibleRange: Range, lineNumber: number): ViewLineRenderingData {
		return this.getViewLineRenderingData(lineNumber);
	}

	getViewLineRenderingData(lineNumber: number): ViewLineRenderingData {
		const line = this.lines.getViewLineData(lineNumber);
		const decorations = this.decorations.getDecorationsOnLine(lineNumber);
		return new ViewLineRenderingData(
			line.minColumn,
			line.maxColumn,
			line.content,
			line.continuesWithWrappedLine,
			this.model.mightContainRTL(),
			this.model.mightContainNonBasicASCII(),
			line.tokens,
			[...decorations.inlineDecorations[0] ?? [], ...line.inlineDecorations ?? []],
			this.model.getOptions().tabSize,
			line.startVisibleColumn,
			this.getTextDirection(lineNumber),
			decorations.hasVariableFonts[0] ?? false,
		);
	}

	getViewLineData(lineNumber: number): ViewLineData {
		return this.lines.getViewLineData(lineNumber);
	}

	getMinimapLinesRenderingData(startLineNumber: number, endLineNumber: number, needed: boolean[]): MinimapLinesRenderingData {
		return new MinimapLinesRenderingData(this.model.getOptions().tabSize, this.lines.getViewLinesData(startLineNumber, endLineNumber, needed));
	}

	getCompletelyVisibleViewRange(): Range {
		return this.getCompletelyVisibleViewRangeAtScrollTop(this.viewLayout.getCurrentScrollTop());
	}

	getCompletelyVisibleViewRangeAtScrollTop(scrollTop: number): Range {
		const viewport = this.viewLayout.getLinesViewportDataAtScrollTop(scrollTop);
		return new Range(
			viewport.completelyVisibleStartLineNumber,
			this.getLineMinColumn(viewport.completelyVisibleStartLineNumber),
			viewport.completelyVisibleEndLineNumber,
			this.getLineMaxColumn(viewport.completelyVisibleEndLineNumber),
		);
	}

	getViewRangeWithCursorPadding(viewRange: Range): Range {
		const surrounding = this.configuration.options.get(EditorOption.cursorSurroundingLines);
		const sticky = this.configuration.options.get(EditorOption.stickyScroll);
		const padding = Math.min(Math.max(surrounding, sticky.enabled ? sticky.maxLineCount : 0), Math.floor((viewRange.endLineNumber - viewRange.startLineNumber + 1) / 2));
		const start = viewRange.startLineNumber + padding;
		const end = viewRange.endLineNumber - Math.max(0, padding - 1);
		return padding === 0 || start > end ? viewRange : new Range(start, this.getLineMinColumn(start), end, this.getLineMaxColumn(end));
	}

	saveState(): IViewState {
		const scroll = this.viewLayout.saveState();
		const firstViewLine = this.viewLayout.getLineNumberAtVerticalOffset(scroll.scrollTop);
		const firstPosition = this.coordinatesConverter.convertViewPositionToModelPosition(
			new Position(firstViewLine, this.getLineMinColumn(firstViewLine)),
		);
		return {
			scrollLeft: scroll.scrollLeft,
			firstPosition,
			firstPositionDeltaTop: this.viewLayout.getVerticalOffsetForLineNumber(firstViewLine) - scroll.scrollTop,
		};
	}

	reduceRestoreState(state: IViewState): { scrollLeft: number; scrollTop: number } {
		if (state.firstPosition === undefined) {
			return { scrollLeft: state.scrollLeft, scrollTop: state.scrollTopWithoutViewZones ?? state.scrollTop ?? 0 };
		}
		const modelPosition = this.model.validatePosition(state.firstPosition);
		const viewPosition = this.coordinatesConverter.convertModelPositionToViewPosition(modelPosition);
		return {
			scrollLeft: state.scrollLeft,
			scrollTop: this.viewLayout.getVerticalOffsetForLineNumber(viewPosition.lineNumber) - state.firstPositionDeltaTop,
		};
	}

	addViewEventHandler(handler: ViewEventHandler): void {
		this.events.addViewEventHandler(handler);
	}

	removeViewEventHandler(handler: ViewEventHandler): void {
		this.events.removeViewEventHandler(handler);
	}

	setHasFocus(hasFocus: boolean): void {
		if (this.hasFocus === hasFocus) return;
		const previous = this.hasFocus;
		this.hasFocus = hasFocus;
		this.cursor.setHasFocus(hasFocus);
		this.events.emitSingleViewEvent(new viewEvents.ViewFocusChangedEvent(hasFocus));
		this.events.emitOutgoingEvent(new FocusChangedEvent(previous, hasFocus));
	}

	setHasWidgetFocus(hasFocus: boolean): void {
		this.events.emitOutgoingEvent(new WidgetFocusChangedEvent(!hasFocus, hasFocus));
	}

	onCompositionStart(): void {
		this.events.emitSingleViewEvent(new viewEvents.ViewCompositionStartEvent());
	}

	onCompositionEnd(): void {
		this.events.emitSingleViewEvent(new viewEvents.ViewCompositionEndEvent());
	}

	getHiddenAreas(): Range[] {
		return this.lines.getHiddenAreas();
	}

	getVisibleRanges(): Range[] {
		return this.toModelVisibleRanges(this.getCompletelyVisibleViewRange());
	}

	getVisibleRangesPlusViewportAboveBelow(): Range[] {
		const viewport = this.viewLayout.getLinesViewportData();
		const lineHeight = this.configuration.options.get(EditorOption.lineHeight);
		const height = this.configuration.options.get(EditorOption.layoutInfo).height;
		const margin = Math.max(20, Math.round(height / lineHeight));
		const start = Math.max(1, viewport.completelyVisibleStartLineNumber - margin);
		const end = Math.min(this.getLineCount(), viewport.completelyVisibleEndLineNumber + margin);
		return this.toModelVisibleRanges(new Range(start, this.getLineMinColumn(start), end, this.getLineMaxColumn(end)));
	}

	setHiddenAreas(ranges: readonly Range[]): void {
		if (!this.lines.setHiddenAreas(ranges)) return;
		this.viewLayout.onFlushed(this.lines.getViewLineCount(), []);
		this.events.emitSingleViewEvent(new viewEvents.ViewFlushedEvent());
		this.events.emitOutgoingEvent(new HiddenAreasChangedEvent());
	}

	getLineCount(): number {
		return this.lines.getViewLineCount();
	}

	getLineContent(lineNumber: number): string {
		return this.lines.getViewLineContent(lineNumber);
	}

	getLineLength(lineNumber: number): number {
		return this.lines.getViewLineLength(lineNumber);
	}

	getLineMinColumn(lineNumber: number): number {
		return this.lines.getViewLineMinColumn(lineNumber);
	}

	getLineMaxColumn(lineNumber: number): number {
		return this.lines.getViewLineMaxColumn(lineNumber);
	}

	getLineFirstNonWhitespaceColumn(lineNumber: number): number {
		const index = this.getLineContent(lineNumber).search(/\S/u);
		return index < 0 ? 0 : index + 1;
	}

	getLineLastNonWhitespaceColumn(lineNumber: number): number {
		const content = this.getLineContent(lineNumber);
		for (let index = content.length - 1; index >= 0; index -= 1) if (/\S/u.test(content[index]!)) return index + 2;
		return 0;
	}

	normalizePosition(position: Position, affinity: PositionAffinity): Position {
		return this.lines.normalizePosition(position, affinity);
	}

	getLineIndentColumn(lineNumber: number): number {
		return this.lines.getLineIndentColumn(lineNumber);
	}

	getActiveIndentGuide(lineNumber: number, minLineNumber: number, maxLineNumber: number): IActiveIndentGuideInfo {
		return this.lines.getActiveIndentGuide(lineNumber, minLineNumber, maxLineNumber);
	}

	getLinesIndentGuides(startLineNumber: number, endLineNumber: number): number[] {
		return this.lines.getViewLinesIndentGuides(startLineNumber, endLineNumber);
	}

	getBracketGuidesInRangeByLine(startLineNumber: number, endLineNumber: number, activePosition: Position | null, options: BracketGuideOptions): IndentGuide[][] {
		return this.lines.getViewLinesBracketGuides(startLineNumber, endLineNumber, activePosition, options);
	}

	getAllOverviewRulerDecorations(theme: EditorTheme): OverviewRulerDecorationsGroup[] {
		const groups = new Map<string, OverviewRulerDecorationsGroup>();
		for (const decoration of this.model.getOverviewRulerDecorations(this.editorId)) {
			const ruler = decoration.options.overviewRuler;
			if (!ruler || !ruler.color) continue;
			const color = typeof ruler.color === 'string' ? ruler.color : theme.getColor(ruler.color.id)?.toString();
			if (!color) continue;
			const zIndex = decoration.options.zIndex ?? 0;
			const key = `${zIndex}:${color}`;
			let group = groups.get(key);
			if (!group) {
				group = new OverviewRulerDecorationsGroup(color, zIndex, []);
				groups.set(key, group);
			}
			const start = this.coordinatesConverter.getViewLineNumberOfModelPosition(decoration.range.startLineNumber, decoration.range.startColumn);
			const end = this.coordinatesConverter.getViewLineNumberOfModelPosition(decoration.range.endLineNumber, decoration.range.endColumn);
			group.data.push(ruler.position, start, end);
		}
		return [...groups.values()].sort(OverviewRulerDecorationsGroup.compareByRenderingProps);
	}

	getValueInRange(range: Range, eol: EndOfLinePreference): string {
		return this.model.getValueInRange(this.coordinatesConverter.convertViewRangeToModelRange(range), eol);
	}

	getValueLengthInRange(range: Range, eol: EndOfLinePreference): number {
		return this.model.getValueLengthInRange(this.coordinatesConverter.convertViewRangeToModelRange(range), eol);
	}

	modifyPosition(position: Position, offset: number): Position {
		const modelPosition = this.coordinatesConverter.convertViewPositionToModelPosition(position);
		return this.coordinatesConverter.convertModelPositionToViewPosition(this.model.modifyPosition(modelPosition, offset));
	}

	getInjectedTextAt(viewPosition: Position): InjectedText | null {
		return this.lines.getInjectedTextAt(viewPosition);
	}

	deduceModelPositionRelativeToViewPosition(viewAnchorPosition: Position, deltaOffset: number, lineFeedCnt: number): Position {
		const anchor = this.coordinatesConverter.convertViewPositionToModelPosition(viewAnchorPosition);
		const eolAdjustment = this.model.getEOL().length === 2 ? Math.sign(deltaOffset) * lineFeedCnt : 0;
		return this.model.getPositionAt(this.model.getOffsetAt(anchor) + deltaOffset + eolAdjustment);
	}

	getPlainTextToCopy(modelRanges: Range[], emptySelectionClipboard: boolean, forceCRLF: boolean): { sourceRanges: Range[]; sourceText: string | string[] } {
		const eol = forceCRLF ? '\r\n' : this.model.getEOL();
		const ranges = [...modelRanges].sort(Range.compareRangesUsingStarts);
		const sourceRanges: Range[] = [];
		const sourceText: string[] = [];
		for (const range of ranges) {
			if (range.isEmpty()) {
				if (!emptySelectionClipboard) continue;
				const line = range.startLineNumber;
				const fullLine = new Range(line, this.model.getLineMinColumn(line), line, this.model.getLineMaxColumn(line));
				if (sourceRanges.some(value => value.startLineNumber === line && value.isEmpty() === false)) continue;
				sourceRanges.push(fullLine);
				sourceText.push(this.model.getValueInRange(fullLine, forceCRLF ? EndOfLinePreference.CRLF : EndOfLinePreference.TextDefined) + eol);
			} else {
				sourceRanges.push(range);
				sourceText.push(this.model.getValueInRange(range, forceCRLF ? EndOfLinePreference.CRLF : EndOfLinePreference.TextDefined));
			}
		}
		return { sourceRanges, sourceText: sourceText.length <= 1 ? (sourceText[0] ?? '') : sourceText };
	}

	getRichTextToCopy(modelRanges: Range[], emptySelectionClipboard: boolean): { html: string; mode: string } | null {
		const { sourceRanges, sourceText } = this.getPlainTextToCopy(modelRanges, emptySelectionClipboard, false);
		if (sourceRanges.length === 0) return null;
		const texts = Array.isArray(sourceText) ? sourceText : [sourceText];
		const colorMap = TokenizationRegistry.getColorMap()?.map(color => color.toString()) ?? [];
		const fragments = sourceRanges.map((range, index) => {
			const lines: string[] = [];
			for (let lineNumber = range.startLineNumber; lineNumber <= range.endLineNumber; lineNumber++) {
				this.model.tokenization.tokenizeIfCheap(lineNumber);
				const tokens = this.model.tokenization.getLineTokens(lineNumber);
				const content = this.model.getLineContent(lineNumber);
				const start = lineNumber === range.startLineNumber ? range.startColumn - 1 : 0;
				const end = lineNumber === range.endLineNumber ? range.endColumn - 1 : content.length;
				const spans: string[] = [];
				for (let token = tokens.findTokenIndexAtOffset(start); token < tokens.getCount(); token++) {
					const from = Math.max(start, tokens.getStartOffset(token));
					const to = Math.min(end, tokens.getEndOffset(token));
					if (from >= end) break;
					const text = escapeClipboardHtml(content.slice(from, to));
					const style = colorMap[tokens.getForeground(token)] ? tokens.getInlineStyle(token, colorMap) : '';
					spans.push(style ? `<span style="${escapeClipboardHtml(style)}">${text}</span>` : text);
				}
				lines.push(spans.join(''));
			}
			const trailingText = texts[index]!.slice(this.model.getValueInRange(range).length);
			return lines.join(this.model.getEOL()) + escapeClipboardHtml(trailingText);
		});
		return {
			html: `<pre style="white-space: pre; tab-size: ${this.model.getOptions().tabSize}"><code>${fragments.join(this.model.getEOL())}</code></pre>`,
			mode: this.model.getLanguageId(),
		};
	}

	onDidChangeContentOrInjectedText(event: textModelEvents.InternalModelContentChangeEvent | textModelEvents.ModelInjectedTextChangedEvent): void {
		this.collectedCursorEventDepth += 1;
		try {
			const eventsCollector = this.events.beginEmitViewEvents();
			if (event instanceof textModelEvents.ModelInjectedTextChangedEvent) this.lines.onModelFlushed();
			this.cursor.onModelContentChanged(eventsCollector, event);
			this.decorations.onLineMappingChanged();
			this.viewLayout.onFlushed(this.lines.getViewLineCount(), []);
			this.events.emitSingleViewEvent(new viewEvents.ViewFlushedEvent());
		} finally {
			this.collectedCursorEventDepth -= 1;
		}
	}

	emitContentChangeEvent(event: textModelEvents.InternalModelContentChangeEvent | textModelEvents.ModelInjectedTextChangedEvent): void {
		try {
			if (event instanceof textModelEvents.InternalModelContentChangeEvent) this.events.emitOutgoingEvent(new ModelContentChangedEvent(event.contentChangedEvent));
		} finally {
			this.events.endEmitViewEvents();
		}
	}

	getPrimaryCursorState(): CursorState {
		return this.cursor.getPrimaryCursorState();
	}

	getLastAddedCursorIndex(): number {
		return this.cursor.getLastAddedCursorIndex();
	}

	getCursorStates(): CursorState[] {
		return this.cursor.getCursorStates();
	}

	setCursorStates(source: string | null | undefined, reason: CursorChangeReason, states: PartialCursorState[] | null): boolean {
		const changed = this.withCollectedCursorEvents(eventsCollector => this.cursor.setStates(eventsCollector, source, reason, states));
		this.previousSelections = this.cursor.getSelections();
		return changed;
	}

	getCursorAutoClosedCharacters(): Range[] {
		return [...this.cursor.getAutoClosedCharacters()];
	}

	getCursorColumnSelectData(): IColumnSelectData {
		return this.cursor.getCursorColumnSelectData();
	}

	setCursorColumnSelectData(columnSelectData: IColumnSelectData): void {
		this.cursor.setCursorColumnSelectData(columnSelectData);
	}

	getPrevEditOperationType(): EditOperationType {
		return this.cursor.getPrevEditOperationType();
	}

	setPrevEditOperationType(type: EditOperationType): void {
		this.cursor.setPrevEditOperationType(type);
	}

	getSelection(): Selection {
		return this.cursor.getSelection();
	}

	getSelections(): Selection[] {
		return this.cursor.getSelections();
	}

	getPosition(): Position {
		return this.cursor.getPosition();
	}

	setSelections(source: string | null | undefined, selections: readonly ISelection[], reason = CursorChangeReason.NotSet): void {
		this.setCursorStates(source, reason, CursorState.fromModelSelections(selections));
	}

	saveCursorState(): ICursorState[] {
		return this.cursor.saveState();
	}

	restoreCursorState(states: ICursorState[]): void {
		this.withCollectedCursorEvents(eventsCollector => this.cursor.restoreState(eventsCollector, states));
		this.previousSelections = this.cursor.getSelections();
	}

	executeEdits(source: string | null | undefined, edits: IIdentifiedSingleEditOperation[], cursorStateComputer: ICursorStateComputer, reason: TextModelEditSource): void {
		this.executeCursorEdit(eventsCollector => this.cursor.executeEdits(eventsCollector, source, edits, cursorStateComputer, reason));
	}

	startComposition(): void {
		this.executeCursorEdit(eventsCollector => this.cursor.startComposition(eventsCollector));
	}

	endComposition(source?: string | null): void {
		this.executeCursorEdit(eventsCollector => this.cursor.endComposition(eventsCollector, source));
	}

	type(text: string, source?: string | null): void {
		this.executeCursorEdit(eventsCollector => this.cursor.type(eventsCollector, text, source));
	}

	compositionType(text: string, replacePrevCharCnt: number, replaceNextCharCnt: number, positionDelta: number, source?: string | null): void {
		this.executeCursorEdit(eventsCollector => this.cursor.compositionType(eventsCollector, text, replacePrevCharCnt, replaceNextCharCnt, positionDelta, source));
	}

	paste(text: string, pasteOnNewLine: boolean, multicursorText?: string[] | null, source?: string | null): void {
		this.executeCursorEdit(eventsCollector => this.cursor.paste(eventsCollector, text, pasteOnNewLine, multicursorText, source));
	}

	cut(source?: string | null): void {
		this.executeCursorEdit(eventsCollector => this.cursor.cut(eventsCollector, source));
	}

	executeCommand(command: ICommand, source?: string | null): void {
		this.executeCursorEdit(eventsCollector => this.cursor.executeCommand(eventsCollector, command, source));
	}

	executeCommands(commands: (ICommand | null)[], source?: string | null): void {
		this.executeCursorEdit(eventsCollector => this.cursor.executeCommands(eventsCollector, commands, source));
	}

	revealAllCursors(source: string | null | undefined, revealHorizontal: boolean, minimalReveal = false): void {
		this.withViewEventsCollector(eventsCollector => this.cursor.revealAll(eventsCollector, source, minimalReveal, viewEvents.VerticalRevealType.Simple, revealHorizontal, ScrollType.Smooth));
	}

	revealPrimaryCursor(source: string | null | undefined, revealHorizontal: boolean, minimalReveal = false): void {
		this.withViewEventsCollector(eventsCollector => this.cursor.revealPrimary(eventsCollector, source, minimalReveal, viewEvents.VerticalRevealType.Simple, revealHorizontal, ScrollType.Smooth));
	}

	revealTopMostCursor(source: string | null | undefined): void {
		this.revealRange(source, true, Range.fromPositions(this.cursor.getTopMostViewPosition()), viewEvents.VerticalRevealType.Simple, ScrollType.Smooth);
	}

	revealBottomMostCursor(source: string | null | undefined): void {
		this.revealRange(source, true, Range.fromPositions(this.cursor.getBottomMostViewPosition()), viewEvents.VerticalRevealType.Simple, ScrollType.Smooth);
	}

	revealRange(source: string | null | undefined, revealHorizontal: boolean, viewRange: Range, verticalType: viewEvents.VerticalRevealType, scrollType: ScrollType): void {
		this.events.emitSingleViewEvent(new viewEvents.ViewRevealRangeRequestEvent(source, false, viewRange, null, verticalType, revealHorizontal, scrollType));
	}

	changeWhitespace(callback: (accessor: IWhitespaceChangeAccessor) => void): void {
		if (!this.viewLayout.changeWhitespace(callback)) return;
		this.events.emitSingleViewEvent(new viewEvents.ViewZonesChangedEvent());
		this.events.emitOutgoingEvent(new ViewZonesChangedEvent());
	}

	visibleLinesStabilized(): void {
		this.publishVisibleLines(true);
	}

	batchEvents(callback: () => void): void {
		this.withViewEventsCollector(() => callback());
	}

	private withViewEventsCollector<T>(callback: (eventsCollector: ViewModelEventsCollector) => T): T {
		return this.transactionalTarget.batchChanges(() => {
			try {
				return callback(this.events.beginEmitViewEvents());
			} finally {
				this.events.endEmitViewEvents();
			}
		});
	}

	private withCollectedCursorEvents<T>(callback: (eventsCollector: ViewModelEventsCollector) => T): T {
		this.collectedCursorEventDepth += 1;
		try {
			return this.withViewEventsCollector(callback);
		} finally {
			this.collectedCursorEventDepth -= 1;
		}
	}

	private executeCursorEdit(callback: (eventsCollector: ViewModelEventsCollector) => void): void {
		if (this.cursorConfig.readOnly) {
			this.events.emitOutgoingEvent(new ReadOnlyEditAttemptEvent());
			return;
		}
		this.withCollectedCursorEvents(callback);
		this.previousSelections = this.cursor.getSelections();
	}

	private recreateCursorConfiguration(): void {
		this.cursorConfig = new CursorConfiguration(this.model.getLanguageId(), this.model.getOptions(), this.configuration, this.languageConfigurationService);
		this.cursor.updateConfiguration(this.cursorConfig);
	}

	private connectLayout(): void {
		this._register(this.viewLayout.onDidScroll(event => {
			this.publishVisibleLines(false);
			this.events.emitSingleViewEvent(new viewEvents.ViewScrollChangedEvent(event));
			this.events.emitOutgoingEvent(new ScrollChangedEvent(
				event.oldScrollWidth, event.oldScrollLeft, event.oldScrollHeight, event.oldScrollTop,
				event.scrollWidth, event.scrollLeft, event.scrollHeight, event.scrollTop,
			));
		}));
		this._register(this.viewLayout.onDidContentSizeChange(event => this.events.emitOutgoingEvent(event)));
	}

	private connectCursor(): void {
		this._register(this.cursor.onDidAttemptReadOnlyEdit(() => this.events.emitOutgoingEvent(new ReadOnlyEditAttemptEvent())));
		this._register(this.cursor.onDidChange(change => {
			if (this.collectedCursorEventDepth > 0) return;
			const modelSelections = [...change.selections];
			const viewSelections = modelSelections.map(selection => this.toViewSelection(selection));
			this.events.emitSingleViewEvent(new viewEvents.ViewCursorStateChangedEvent(viewSelections, modelSelections, change.reason));
			this.events.emitOutgoingEvent(new CursorStateChangedEvent(
				this.previousSelections, modelSelections, change.modelVersion, change.modelVersion, 'viewModel', change.reason, false,
			));
			this.previousSelections = modelSelections;
		}));
	}

	private publishVisibleLines(stabilized: boolean): void {
		const viewport = this.viewLayout.getLinesViewportData();
		const viewRange = new Range(viewport.startLineNumber, 1, viewport.endLineNumber, this.getLineMaxColumn(viewport.endLineNumber));
		const modelRange = this.coordinatesConverter.convertViewRangeToModelRange(viewRange);
		this.attachedView.setVisibleLines([{ startLineNumber: modelRange.startLineNumber, endLineNumber: modelRange.endLineNumber }], stabilized);
	}

	private toCursorState(selection: Selection): CursorState {
		const modelState = CursorState.fromModelSelection(selection).modelState;
		const viewState = CursorState.fromModelSelection(this.toViewSelection(selection)).modelState;
		return new CursorState(modelState, viewState);
	}

	private toViewSelection(selection: Selection): Selection {
		const range = this.coordinatesConverter.convertModelRangeToViewRange(selection);
		return Selection.fromPositions(range.getStartPosition(), range.getEndPosition());
	}

	private toModelVisibleRanges(viewRange: Range): Range[] {
		const visible = this.coordinatesConverter.convertViewRangeToModelRange(viewRange);
		const hiddenAreas = this.lines.getHiddenAreas();
		if (hiddenAreas.length === 0) return [visible];
		const result: Range[] = [];
		let startLine = visible.startLineNumber;
		let startColumn = visible.startColumn;
		for (const hidden of hiddenAreas) {
			if (hidden.endLineNumber < startLine) continue;
			if (hidden.startLineNumber > visible.endLineNumber) break;
			if (startLine < hidden.startLineNumber) {
				result.push(new Range(startLine, startColumn, hidden.startLineNumber - 1, this.model.getLineMaxColumn(hidden.startLineNumber - 1)));
			}
			startLine = hidden.endLineNumber + 1;
			startColumn = 1;
		}
		if (startLine < visible.endLineNumber || (startLine === visible.endLineNumber && startColumn < visible.endColumn)) {
			result.push(new Range(startLine, startColumn, visible.endLineNumber, visible.endColumn));
		}
		return result;
	}

	private revealSelection(source: string | null | undefined, selection: Selection): void {
		const position = this.toViewSelection(selection).getPosition();
		this.revealRange(source, true, Range.fromPositions(position), viewEvents.VerticalRevealType.Simple, ScrollType.Smooth);
	}
}

function escapeClipboardHtml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export interface IBatchableTarget {
	batchChanges<T>(callback: () => T): T;
}

/** @internal Used only by browser input code that has not yet moved to ViewModel commands. */
export function getViewModelCursorController(viewModel: ViewModel): CursorsController {
	const cursor = cursorOwners.get(viewModel);
	if (!cursor) throw new ReferenceError('ViewModel cursor is unavailable');
	return cursor;
}
