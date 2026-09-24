import { Emitter, type Event } from '../../../base/common/event.js';
import { Disposable, MutableDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { isFiniteNumber, isPositiveSafeInteger } from '../../../base/common/numbers.js';
import { EditorLineWrapping, isWrappingIndent, WrappingIndent } from '../config/editorOptions.js';
import { type FontInfo } from '../config/fontInfo.js';
import { IdentityCoordinatesConverter, type ICoordinatesConverter } from '../coordinatesConverter.js';
import { type ICursorSimpleModel } from '../cursorCommon.js';
import { type IPosition, Position } from '../core/position.js';
import { Range } from '../core/range.js';
import { type IModelDecoration, type ITextModel, PositionAffinity } from '../model.js';
import { type TextModel } from '../model/textModel.js';
import { type ILineBreaksComputer, type ILineBreaksComputerContext, type ILineBreaksComputerFactory, type InjectedText, type ModelLineProjectionData } from '../modelLineProjectionData.js';
import { type BracketGuideOptions, type IActiveIndentGuideInfo, type IndentGuide } from '../textModelGuides.js';
import * as viewEvents from '../viewEvents.js';
import { ViewLineData, type EditorViewportLineSource } from '../viewModel.js';
import { EditorVisualLineProjection, type EditorVisualLine } from './modelLineProjection.js';

export interface IViewModelLines extends IDisposable {
	createCoordinatesConverter(): ICoordinatesConverter;
	setWrappingSettings(fontInfo: FontInfo, wrappingStrategy: 'simple' | 'advanced', wrappingColumn: number, wrappingIndent: WrappingIndent, wordBreak: 'normal' | 'keepAll'): boolean;
	setTabSize(tabSize: number): boolean;
	getHiddenAreas(): Range[];
	setHiddenAreas(ranges: readonly Range[]): boolean;
	createLineBreaksComputer(context?: ILineBreaksComputerContext): ILineBreaksComputer;
	onModelFlushed(): void;
	onModelLinesDeleted(versionId: number | null, fromLineNumber: number, toLineNumber: number): viewEvents.ViewLinesDeletedEvent | null;
	onModelLinesInserted(versionId: number | null, fromLineNumber: number, toLineNumber: number, lineBreaks: (ModelLineProjectionData | null)[]): viewEvents.ViewLinesInsertedEvent | null;
	onModelLineChanged(versionId: number | null, lineNumber: number, lineBreakData: ModelLineProjectionData | null): [boolean, viewEvents.ViewLinesChangedEvent | null, viewEvents.ViewLinesInsertedEvent | null, viewEvents.ViewLinesDeletedEvent | null];
	acceptVersionId(versionId: number): void;
	getViewLineCount(): number;
	getActiveIndentGuide(viewLineNumber: number, minLineNumber: number, maxLineNumber: number): IActiveIndentGuideInfo;
	getViewLinesIndentGuides(viewStartLineNumber: number, viewEndLineNumber: number): number[];
	getViewLinesBracketGuides(startLineNumber: number, endLineNumber: number, activePosition: IPosition | null, options: BracketGuideOptions): IndentGuide[][];
	getViewLineContent(viewLineNumber: number): string;
	getViewLineLength(viewLineNumber: number): number;
	getViewLineMinColumn(viewLineNumber: number): number;
	getViewLineMaxColumn(viewLineNumber: number): number;
	getViewLineData(viewLineNumber: number): ViewLineData;
	getViewLinesData(viewStartLineNumber: number, viewEndLineNumber: number, needed: boolean[]): Array<ViewLineData | null>;
	getDecorationsInRange(range: Range, ownerId: number, filterOutValidation: boolean, filterFontDecorations: boolean, onlyMinimapDecorations: boolean, onlyMarginDecorations: boolean): IModelDecoration[];
	getInjectedTextAt(viewPosition: Position): InjectedText | null;
	normalizePosition(position: Position, affinity: PositionAffinity): Position;
	getLineIndentColumn(lineNumber: number): number;
}

interface ProjectedLinesOptions {
	readonly editorId?: number;
	readonly wrapping?: EditorLineWrapping;
	readonly wrapWidth?: number;
	readonly wrappingIndent?: WrappingIndent;
	/**
	 * Defers expensive initial soft-wrap measurement while preserving a usable
	 * one-row-per-logical-line projection until the complete result is ready.
	 */
	readonly initialWrappingMeasurement?: InitialMeasurementOptions;
}

/** Schedules a later, cancellable slice of initial visual-line measurement. */
type MeasurementScheduler = (callback: () => void) => IDisposable;

/** Controls non-blocking initial measurement for a large wrapped document. */
interface InitialMeasurementOptions {
	readonly initialLineCount?: number;
	readonly linesPerSlice?: number;
	readonly schedule: MeasurementScheduler;
}

interface ResolvedInitialMeasurement {
	readonly initialLineCount: number;
	readonly linesPerSlice: number;
	readonly schedule: MeasurementScheduler;
}

/**
 * Common view-model line collection for wrapping and hidden logical lines.
 *
 * This is the Stanza equivalent of VS Code's `viewModelLines.ts`: it owns the
 * model-versioned logical-to-visual mapping and combines visibility with the
 * wrapped rows. The browser supplies only the line-break computation policy.
 */
export class ViewModelLinesFromProjectedModel extends Disposable implements ICursorSimpleModel, IViewModelLines {
	private readonly changeEmitter = this._register(new Emitter<void>());
	private readonly lineCountChangeEmitter = this._register(new Emitter<void>());
	private readonly initialMeasurement: ResolvedInitialMeasurement | undefined;
	private readonly pendingMeasurement = this._register(new MutableDisposable<IDisposable>());
	private readonly editorId: number;
	private hiddenAreas: Range[] = [];
	private wrapping: EditorLineWrapping;
	private wrapWidth: number;
	private currentWrappingIndent: WrappingIndent;
	private currentWordBreak: 'normal' | 'keepAll' = 'normal';
	private wrappingProjection: EditorVisualLineProjection;
	private currentProjection: EditorVisualLineProjection;
	private projectionRevision = 0;
	private pendingBreaks: Array<ModelLineProjectionData | null> | undefined;
	private nextLineIndex = 0;
	private scanVersion = -1;

	readonly onDidChange: Event<void> = this.changeEmitter.event;
	readonly onDidChangeLineCount: Event<void> = this.lineCountChangeEmitter.event;
	readonly lineSource: EditorViewportLineSource;

	constructor(
		private readonly model: TextModel,
		private readonly lineBreaksComputerFactory: ILineBreaksComputerFactory,
		private fontInfo: FontInfo,
		private tabSize: number,
		options: ProjectedLinesOptions = {},
	) {
		super();
		if (!lineBreaksComputerFactory || typeof lineBreaksComputerFactory.createLineBreaksComputer !== 'function') {
			throw new TypeError('Editor view-model lines require a line-break computer factory');
		}
		if (!fontInfo || !isFiniteNumber(fontInfo.typicalHalfwidthCharacterWidth) || fontInfo.typicalHalfwidthCharacterWidth <= 0) throw new TypeError('Editor view-model lines require measured font information');
		if (!Number.isSafeInteger(tabSize) || tabSize < 1) throw new RangeError('Editor view-model tab size must be a positive safe integer');
		this.editorId = options.editorId ?? 0;
		this.wrapping = readWrapping(options.wrapping);
		this.wrapWidth = readWrapWidth(options.wrapWidth);
		this.currentWrappingIndent = readWrappingIndent(options.wrappingIndent);
		this.initialMeasurement = readInitialMeasurement(options.initialWrappingMeasurement);
		this.wrappingProjection = this.usesInitialMeasurement()
			? EditorVisualLineProjection.identity(this.model)
			: this.createWrappingProjection();
		this.currentProjection = this.createVisibleProjection(this.wrappingProjection);
		const projection = this;
		this.lineSource = Object.freeze({
			get lineCount(): number {
				return projection.currentProjection.visualLineCount;
			},
			onDidChange: this.onDidChange,
		});
		if (this.usesInitialMeasurement()) this.startInitialMeasurement();
		this._register(this.model.onDidChangeContent(() => this.refresh()));
	}

	get textModel(): TextModel {
		return this.model;
	}

	/** The current wrapping-plus-visibility projection. */
	get projection(): EditorVisualLineProjection {
		return this.currentProjection;
	}

	get lineCount(): number {
		return this.currentProjection.visualLineCount;
	}

	createCoordinatesConverter(): ICoordinatesConverter {
		return new ViewModelCoordinatesConverter(this.model, this);
	}

	setWrappingSettings(fontInfo: FontInfo, _wrappingStrategy: 'simple' | 'advanced', wrappingColumn: number, wrappingIndent: WrappingIndent, wordBreak: 'normal' | 'keepAll'): boolean {
		const nextWrapping = wrappingColumn > 0 ? EditorLineWrapping.On : EditorLineWrapping.Off;
		const nextWidth = Math.max(0, wrappingColumn) * fontInfo.typicalHalfwidthCharacterWidth;
		const changed = this.fontInfo !== fontInfo || this.wrapping !== nextWrapping || this.wrapWidth !== nextWidth || this.currentWrappingIndent !== wrappingIndent || this.currentWordBreak !== wordBreak;
		if (!changed) return false;
		this.fontInfo = fontInfo;
		this.wrapping = nextWrapping;
		this.wrapWidth = nextWidth;
		this.currentWrappingIndent = wrappingIndent;
		this.currentWordBreak = wordBreak;
		this.refresh();
		return true;
	}

	setTabSize(tabSize: number): boolean {
		if (!Number.isSafeInteger(tabSize) || tabSize < 1) throw new RangeError('Editor view-model tab size must be a positive safe integer');
		if (this.tabSize === tabSize) return false;
		this.tabSize = tabSize;
		if (this.usesInitialMeasurement()) this.startInitialMeasurement(false);
		else this.rebuild(false);
		return true;
	}

	getHiddenAreas(): Range[] {
		return this.hiddenAreas.map(range => Range.lift(range));
	}

	setHiddenAreas(ranges: readonly Range[]): boolean {
		const next = ranges.map(range => this.model.validateRange(range));
		if (rangesEqual(this.hiddenAreas, next)) return false;
		this.hiddenAreas = next;
		this.rebuildVisibleProjection();
		return true;
	}

	getLineCount(): number {
		return this.ensureCurrent().visualLineCount;
	}

	getViewLineCount(): number {
		return this.getLineCount();
	}

	getLineContent(lineNumber: number): string {
		return this.ensureCurrent().getViewLineData(this.model, lineNumber).content;
	}

	getViewLineContent(viewLineNumber: number): string {
		return this.getLineContent(viewLineNumber);
	}

	getViewLineLength(viewLineNumber: number): number {
		return this.ensureCurrent().getViewLineData(this.model, viewLineNumber).maxColumn - 1;
	}

	getLineMinColumn(lineNumber: number): number {
		return this.ensureCurrent().getViewLineData(this.model, lineNumber).minColumn;
	}

	getViewLineMinColumn(viewLineNumber: number): number {
		return this.getLineMinColumn(viewLineNumber);
	}

	getLineMaxColumn(lineNumber: number): number {
		return this.ensureCurrent().getViewLineData(this.model, lineNumber).maxColumn;
	}

	getViewLineMaxColumn(viewLineNumber: number): number {
		return this.getLineMaxColumn(viewLineNumber);
	}

	getLineFirstNonWhitespaceColumn(lineNumber: number): number {
		const index = this.getLineContent(lineNumber).search(/\S/u);
		return index < 0 ? 0 : index + 1;
	}

	getLineLastNonWhitespaceColumn(lineNumber: number): number {
		const content = this.getLineContent(lineNumber);
		for (let index = content.length - 1; index >= 0; index -= 1) {
			if (/\S/u.test(content[index]!)) return index + 2;
		}
		return 0;
	}

	normalizePosition(position: Position, affinity: PositionAffinity): Position {
		const lineNumber = Math.min(Math.max(position.lineNumber, 1), this.getLineCount());
		const clamped = new Position(lineNumber, Math.min(Math.max(position.column, this.getLineMinColumn(lineNumber)), this.getLineMaxColumn(lineNumber)));
		return this.ensureCurrent().normalizePosition(clamped, affinity);
	}

	getLineIndentColumn(lineNumber: number): number {
		const firstNonWhitespaceColumn = this.getLineFirstNonWhitespaceColumn(lineNumber);
		return firstNonWhitespaceColumn === 0 ? this.getLineMaxColumn(lineNumber) : firstNonWhitespaceColumn;
	}

	get wrappingIndent(): WrappingIndent {
		return this.currentWrappingIndent;
	}

	get revision(): number {
		return this.projectionRevision;
	}

	/** Whether the current soft-wrap projection includes every model line. */
	get complete(): boolean {
		return !this.pendingBreaks || this.nextLineIndex >= this.model.lineCount;
	}

	ensureCurrent(): EditorVisualLineProjection {
		if (this.wrappingProjection.modelVersion !== this.model.version) this.refresh();
		return this.currentProjection;
	}

	setWrapping(wrapping: EditorLineWrapping): void {
		const next = readWrapping(wrapping);
		if (next === this.wrapping) return;
		this.wrapping = next;
		this.refresh();
	}

	setWrapWidth(width: number, force = false): void {
		const next = readWrapWidth(width);
		if (!force && next === this.wrapWidth) return;
		this.wrapWidth = next;
		this.refresh();
	}

	setWrappingIndent(wrappingIndent: WrappingIndent): void {
		const next = readWrappingIndent(wrappingIndent);
		if (next === this.currentWrappingIndent) return;
		this.currentWrappingIndent = next;
		this.refresh();
	}

	getActiveIndentGuide(viewLineNumber: number, minLineNumber: number, maxLineNumber: number): IActiveIndentGuideInfo {
		const active = this.getVisualLine(viewLineNumber).logicalLineIndex + 1;
		const min = this.getVisualLine(minLineNumber).logicalLineIndex + 1;
		const max = this.getVisualLine(maxLineNumber).logicalLineIndex + 1;
		const guide = this.model.guides.getActiveIndentGuide(active, min, max);
		return {
			startLineNumber: this.projection.visualLineIndexAt(new Position(guide.startLineNumber, 1)) + 1,
			endLineNumber: this.projection.visualLineIndexAt(new Position(guide.endLineNumber, this.model.getLineMaxColumn(guide.endLineNumber))) + 1,
			indent: guide.indent,
		};
	}

	getViewLinesIndentGuides(viewStartLineNumber: number, viewEndLineNumber: number): number[] {
		return this.mapViewLines(viewStartLineNumber, viewEndLineNumber, lineNumber => (
			this.model.guides.getLinesIndentGuides(lineNumber, lineNumber)[0] ?? 0
		));
	}

	getViewLinesBracketGuides(viewStartLineNumber: number, viewEndLineNumber: number, activePosition: IPosition | null, options: BracketGuideOptions): IndentGuide[][] {
		return this.mapViewLines(viewStartLineNumber, viewEndLineNumber, lineNumber => (
			this.model.guides.getLinesBracketGuides(lineNumber, lineNumber, activePosition, options)[0] ?? []
		));
	}

	getViewLineData(viewLineNumber: number): ViewLineData {
		return this.ensureCurrent().getViewLineData(this.model, viewLineNumber);
	}

	getViewLinesData(viewStartLineNumber: number, viewEndLineNumber: number, needed: boolean[]): Array<ViewLineData | null> {
		const start = Math.max(1, Math.min(viewStartLineNumber, this.getViewLineCount()));
		const end = Math.max(start, Math.min(viewEndLineNumber, this.getViewLineCount()));
		return Array.from({ length: end - start + 1 }, (_, index) => needed[index] === false ? null : this.getViewLineData(start + index));
	}

	getDecorationsInRange(range: Range, ownerId: number, filterOutValidation: boolean, filterFontDecorations: boolean, onlyMinimapDecorations: boolean, onlyMarginDecorations: boolean): IModelDecoration[] {
		return this.model.getDecorationsInRange(
			this.createCoordinatesConverter().convertViewRangeToModelRange(range),
			ownerId,
			filterOutValidation,
			filterFontDecorations,
			onlyMinimapDecorations,
			onlyMarginDecorations,
		);
	}

	getInjectedTextAt(viewPosition: Position): InjectedText | null {
		return this.ensureCurrent().getInjectedTextAt(viewPosition);
	}

	public createLineBreaksComputer(context?: ILineBreaksComputerContext): ILineBreaksComputer {
		const source = context ?? {
			getLineContent: lineNumber => this.model.getLineContent(lineNumber),
			getLineInjectedText: lineNumber => this.model.getLineInjectedText(lineNumber, this.editorId),
		};
		return this.lineBreaksComputerFactory.createLineBreaksComputer(
			source,
			this.fontInfo,
			this.tabSize,
			this.wrapping === EditorLineWrapping.Off ? -1 : Math.max(1, Math.floor(this.wrapWidth / this.fontInfo.typicalHalfwidthCharacterWidth)),
			this.currentWrappingIndent,
			this.currentWordBreak,
			false,
		);
	}

	onModelFlushed(): void {
		this.refresh();
	}

	onModelLinesDeleted(_versionId: number | null, fromLineNumber: number, toLineNumber: number): viewEvents.ViewLinesDeletedEvent | null {
		this.refresh();
		return new viewEvents.ViewLinesDeletedEvent(fromLineNumber, toLineNumber);
	}

	onModelLinesInserted(_versionId: number | null, fromLineNumber: number, toLineNumber: number, _lineBreaks: (ModelLineProjectionData | null)[]): viewEvents.ViewLinesInsertedEvent | null {
		this.refresh();
		return new viewEvents.ViewLinesInsertedEvent(fromLineNumber, toLineNumber);
	}

	onModelLineChanged(_versionId: number | null, lineNumber: number, _lineBreakData: ModelLineProjectionData | null): [boolean, viewEvents.ViewLinesChangedEvent | null, viewEvents.ViewLinesInsertedEvent | null, viewEvents.ViewLinesDeletedEvent | null] {
		const previousCount = this.getViewLineCount();
		this.refresh();
		const nextCount = this.getViewLineCount();
		return [
			previousCount !== nextCount,
			new viewEvents.ViewLinesChangedEvent(lineNumber, 1),
			nextCount > previousCount ? new viewEvents.ViewLinesInsertedEvent(lineNumber + 1, lineNumber + nextCount - previousCount) : null,
			nextCount < previousCount ? new viewEvents.ViewLinesDeletedEvent(lineNumber + 1, lineNumber + previousCount - nextCount) : null,
		];
	}

	acceptVersionId(_versionId: number): void {}

	private refresh(): void {
		if (this.usesInitialMeasurement()) this.startInitialMeasurement();
		else this.rebuild();
	}

	private rebuild(emit = true): void {
		this.pendingMeasurement.clear();
		this.pendingBreaks = undefined;
		this.nextLineIndex = this.model.lineCount;
		this.scanVersion = this.model.version;
		this.replaceWrappingProjection(this.createWrappingProjection(), emit);
	}

	private startInitialMeasurement(emit = true): void {
		const options = this.initialMeasurement;
		if (!options) return;
		this.pendingMeasurement.clear();
		this.scanVersion = this.model.version;
		this.nextLineIndex = 0;
		this.pendingBreaks = Array.from({ length: this.model.lineCount }, () => null);
		this.measureNextSlice(options.initialLineCount);
		this.replaceWrappingProjection(this.createProjectionFromPendingBreaks(), emit);
		this.scheduleNextSlice();
	}

	private scheduleNextSlice(): void {
		const options = this.initialMeasurement;
		if (!options || this.complete) return;
		this.pendingMeasurement.value = options.schedule(() => {
			this.pendingMeasurement.clear();
			if (this.scanVersion !== this.model.version) {
				this.startInitialMeasurement();
				return;
			}
			this.measureNextSlice(options.linesPerSlice);
			if (this.complete) this.replaceWrappingProjection(this.createProjectionFromPendingBreaks());
			this.scheduleNextSlice();
		});
	}

	private measureNextSlice(lineCount: number): void {
		const breaks = this.pendingBreaks;
		if (!breaks) return;
		const endLineIndex = Math.min(this.model.lineCount, this.nextLineIndex + lineCount);
		const computer = this.createLineBreaksComputer();
		for (let lineIndex = this.nextLineIndex; lineIndex < endLineIndex; lineIndex += 1) computer.addRequest(lineIndex + 1, breaks[lineIndex] ?? null);
		const measured = computer.finalize();
		if (measured.length !== endLineIndex - this.nextLineIndex) throw new Error('Line-break computer returned a result count different from its requests');
		for (const result of measured) breaks[this.nextLineIndex++] = result;
	}

	private replaceWrappingProjection(next: EditorVisualLineProjection, emit = true): void {
		const previousLineCount = this.currentProjection.visualLineCount;
		this.wrappingProjection = next;
		this.currentProjection = this.createVisibleProjection(next);
		this.projectionRevision += 1;
		if (this.currentProjection.visualLineCount !== previousLineCount) this.lineCountChangeEmitter.fire();
		if (emit) this.changeEmitter.fire();
	}

	private rebuildVisibleProjection(): void {
		if (this.wrappingProjection.modelVersion !== this.model.version) {
			this.refresh();
			return;
		}
		const previousLineCount = this.currentProjection.visualLineCount;
		this.currentProjection = this.createVisibleProjection(this.wrappingProjection);
		this.projectionRevision += 1;
		if (this.currentProjection.visualLineCount !== previousLineCount) this.lineCountChangeEmitter.fire();
		this.changeEmitter.fire();
	}

	private createWrappingProjection(): EditorVisualLineProjection {
		const computer = this.createLineBreaksComputer();
		for (let lineNumber = 1; lineNumber <= this.model.lineCount; lineNumber += 1) computer.addRequest(lineNumber, null);
		return this.createProjection(computer.finalize());
	}

	private createProjectionFromPendingBreaks(): EditorVisualLineProjection {
		const breaks = this.pendingBreaks;
		if (!breaks) throw new Error('Stanza visual-line measurement is not active');
		return this.createProjection(breaks);
	}

	private createProjection(breaks: readonly (ModelLineProjectionData | null)[]): EditorVisualLineProjection {
		if (breaks.length !== this.model.lineCount) throw new Error('Line-break data must match the model line count');
		return EditorVisualLineProjection.fromLineBreakData(this.model, breaks, this.fontInfo.spaceWidth);
	}

	private createVisibleProjection(source: EditorVisualLineProjection): EditorVisualLineProjection {
		if (this.hiddenAreas.length === 0) return source;
		const visibleLogicalLines = Object.freeze(Array.from(
			{ length: source.logicalLineCount },
			(_, lineIndex) => this.isLogicalLineVisible(lineIndex),
		));
		const lines = source.lines.filter(line => visibleLogicalLines[line.logicalLineIndex]);
		const anchors = createVisualLineAnchors(source, visibleLogicalLines, lines);
		return EditorVisualLineProjection.fromVisibleLines(source.modelVersion, source.logicalLineCount, lines, anchors);
	}

	private isLogicalLineVisible(lineIndex: number): boolean {
		const lineNumber = lineIndex + 1;
		return !this.hiddenAreas.some(range => range.startLineNumber <= lineNumber && lineNumber <= range.endLineNumber);
	}

	private mapViewLines<T>(startLineNumber: number, endLineNumber: number, read: (modelLineNumber: number) => T): T[] {
		const start = Math.max(1, Math.min(startLineNumber, this.getViewLineCount()));
		const end = Math.max(start, Math.min(endLineNumber, this.getViewLineCount()));
		return Array.from({ length: end - start + 1 }, (_, index) => read(this.getVisualLine(start + index).logicalLineIndex + 1));
	}

	private usesInitialMeasurement(): boolean {
		return this.initialMeasurement !== undefined &&
			this.wrapping === EditorLineWrapping.On &&
			this.wrapWidth > 0;
	}

	private getVisualLine(lineNumber: number): EditorVisualLine {
		const line = this.ensureCurrent().lineAt(lineNumber - 1);
		if (!line) throw new RangeError('View line number is outside the visual projection');
		return line;
	}
}

export class ViewModelLinesFromModelAsIs extends Disposable implements IViewModelLines {
	constructor(private readonly model: ITextModel) {
		super();
	}

	createCoordinatesConverter(): ICoordinatesConverter {
		return new IdentityCoordinatesConverter(this.model);
	}

	setWrappingSettings(_fontInfo: FontInfo, _wrappingStrategy: 'simple' | 'advanced', _wrappingColumn: number, _wrappingIndent: WrappingIndent, _wordBreak: 'normal' | 'keepAll'): boolean {
		return false;
	}

	setTabSize(_tabSize: number): boolean {
		return false;
	}

	getHiddenAreas(): Range[] {
		return [];
	}

	setHiddenAreas(_ranges: readonly Range[]): boolean {
		return false;
	}

	createLineBreaksComputer(): ILineBreaksComputer {
		return new IdentityLineBreaksComputer();
	}

	onModelFlushed(): void {}

	onModelLinesDeleted(_versionId: number | null, fromLineNumber: number, toLineNumber: number): viewEvents.ViewLinesDeletedEvent {
		return new viewEvents.ViewLinesDeletedEvent(fromLineNumber, toLineNumber);
	}

	onModelLinesInserted(_versionId: number | null, fromLineNumber: number, toLineNumber: number, _lineBreaks: (ModelLineProjectionData | null)[]): viewEvents.ViewLinesInsertedEvent {
		return new viewEvents.ViewLinesInsertedEvent(fromLineNumber, toLineNumber);
	}

	onModelLineChanged(_versionId: number | null, lineNumber: number, _lineBreakData: ModelLineProjectionData | null): [false, viewEvents.ViewLinesChangedEvent, null, null] {
		return [false, new viewEvents.ViewLinesChangedEvent(lineNumber, 1), null, null];
	}

	acceptVersionId(_versionId: number): void {}

	getViewLineCount(): number {
		return this.model.getLineCount();
	}

	getActiveIndentGuide(viewLineNumber: number, minLineNumber: number, maxLineNumber: number): IActiveIndentGuideInfo {
		return this.model.guides.getActiveIndentGuide(viewLineNumber, minLineNumber, maxLineNumber);
	}

	getViewLinesIndentGuides(viewStartLineNumber: number, viewEndLineNumber: number): number[] {
		return this.model.guides.getLinesIndentGuides(viewStartLineNumber, viewEndLineNumber);
	}

	getViewLinesBracketGuides(startLineNumber: number, endLineNumber: number, activePosition: IPosition | null, options: BracketGuideOptions): IndentGuide[][] {
		return this.model.guides.getLinesBracketGuides(startLineNumber, endLineNumber, activePosition, options);
	}

	getViewLineContent(viewLineNumber: number): string {
		return this.model.getLineContent(viewLineNumber);
	}

	getViewLineLength(viewLineNumber: number): number {
		return this.model.getLineLength(viewLineNumber);
	}

	getViewLineMinColumn(viewLineNumber: number): number {
		return this.model.getLineMinColumn(viewLineNumber);
	}

	getViewLineMaxColumn(viewLineNumber: number): number {
		return this.model.getLineMaxColumn(viewLineNumber);
	}

	getViewLineData(viewLineNumber: number): ViewLineData {
		const tokens = this.model.tokenization.getLineTokens(viewLineNumber);
		const content = tokens.getLineContent();
		return new ViewLineData(content, false, 1, content.length + 1, 0, tokens.inflate(), null);
	}

	getViewLinesData(viewStartLineNumber: number, viewEndLineNumber: number, needed: boolean[]): Array<ViewLineData | null> {
		const start = Math.max(1, Math.min(viewStartLineNumber, this.model.getLineCount()));
		const end = Math.max(start, Math.min(viewEndLineNumber, this.model.getLineCount()));
		return Array.from({ length: end - start + 1 }, (_, index) => needed[index] === false ? null : this.getViewLineData(start + index));
	}

	getDecorationsInRange(range: Range, ownerId: number, filterOutValidation: boolean, filterFontDecorations: boolean, onlyMinimapDecorations: boolean, onlyMarginDecorations: boolean): IModelDecoration[] {
		return this.model.getDecorationsInRange(range, ownerId, filterOutValidation, filterFontDecorations, onlyMinimapDecorations, onlyMarginDecorations);
	}

	getInjectedTextAt(_viewPosition: Position): InjectedText | null {
		return null;
	}

	normalizePosition(position: Position, _affinity: PositionAffinity): Position {
		return this.model.validatePosition(position);
	}

	getLineIndentColumn(lineNumber: number): number {
		const first = this.model.getLineFirstNonWhitespaceColumn(lineNumber);
		return first === 0 ? this.model.getLineMaxColumn(lineNumber) : first;
	}
}

class IdentityLineBreaksComputer implements ILineBreaksComputer {
	private requestCount = 0;

	addRequest(_lineNumber: number, _previousLineBreakData: ModelLineProjectionData | null): void {
		this.requestCount += 1;
	}

	finalize(): null[] {
		return Array.from({ length: this.requestCount }, () => null);
	}
}

class ViewModelCoordinatesConverter implements ICoordinatesConverter {
	constructor(
		private readonly model: TextModel,
		private readonly lines: ViewModelLinesFromProjectedModel,
	) {}

	public convertViewPositionToModelPosition(viewPosition: Position): Position {
		const position = this.lines.normalizePosition(viewPosition, PositionAffinity.None);
		return this.model.validatePosition(this.lines.projection.convertViewPositionToModelPosition(position));
	}

	public convertViewRangeToModelRange(viewRange: Range): Range {
		const range = this.validateViewRange(viewRange, this.model.getFullModelRange());
		return Range.fromPositions(
			this.convertViewPositionToModelPosition(range.getStartPosition()),
			this.convertViewPositionToModelPosition(range.getEndPosition()),
		);
	}

	public validateViewPosition(viewPosition: Position, expectedModelPosition: Position): Position {
		const expected = this.convertModelPositionToViewPosition(expectedModelPosition);
		return expected.equals(viewPosition) ? expected : this.lines.normalizePosition(viewPosition, PositionAffinity.None);
	}

	public validateViewRange(viewRange: Range, expectedModelRange: Range): Range {
		const expected = this.convertModelRangeToViewRange(expectedModelRange);
		if (expected.equalsRange(viewRange)) return expected;
		return Range.fromPositions(
			this.lines.normalizePosition(viewRange.getStartPosition(), PositionAffinity.Left),
			this.lines.normalizePosition(viewRange.getEndPosition(), PositionAffinity.Right),
		);
	}

	public convertModelPositionToViewPosition(modelPosition: Position, affinity: PositionAffinity = PositionAffinity.None): Position {
		const position = this.model.validatePosition(modelPosition);
		const projection = this.lines.ensureCurrent();
		const viewLineIndex = projection.firstVisualLineIndex(position.lineNumber - 1);
		if (projection.lineAt(viewLineIndex)!.logicalLineIndex !== position.lineNumber - 1) {
			const viewLineNumber = viewLineIndex + 1;
			return new Position(viewLineNumber, projection.getViewLineData(this.model, viewLineNumber).maxColumn);
		}
		return projection.convertModelPositionToViewPosition(position, affinity);
	}

	public convertModelRangeToViewRange(modelRange: Range, affinity: PositionAffinity = PositionAffinity.None): Range {
		const range = this.model.validateRange(modelRange);
		return Range.fromPositions(
			this.convertModelPositionToViewPosition(range.getStartPosition(), affinity),
			this.convertModelPositionToViewPosition(range.getEndPosition(), affinity),
		);
	}

	public modelPositionIsVisible(modelPosition: Position): boolean {
		if (modelPosition.lineNumber < 1 || modelPosition.lineNumber > this.model.getLineCount()) return false;
		const projection = this.lines.ensureCurrent();
		return projection.lineAt(projection.visualLineIndexAt(this.model.validatePosition(modelPosition)))?.logicalLineIndex === modelPosition.lineNumber - 1;
	}

	public getModelLineViewLineCount(modelLineNumber: number): number {
		if (modelLineNumber < 1 || modelLineNumber > this.model.getLineCount()) return 1;
		return this.lines.ensureCurrent().lines.filter(line => line.logicalLineIndex === modelLineNumber - 1).length || 1;
	}

	public getViewLineNumberOfModelPosition(modelLineNumber: number, modelColumn: number): number {
		return this.convertModelPositionToViewPosition(new Position(modelLineNumber, modelColumn)).lineNumber;
	}
}

function createVisualLineAnchors(
	source: EditorVisualLineProjection,
	visibleLogicalLines: readonly boolean[],
	lines: readonly EditorVisualLine[],
): readonly number[] {
	const first = Array.from({ length: source.logicalLineCount }, () => -1);
	const last = Array.from({ length: source.logicalLineCount }, () => -1);
	for (let visualLineIndex = 0; visualLineIndex < lines.length; visualLineIndex += 1) {
		const line = lines[visualLineIndex]!;
		if (line.firstForLogicalLine) first[line.logicalLineIndex] = visualLineIndex;
		if (line.lastForLogicalLine) last[line.logicalLineIndex] = visualLineIndex;
	}
	let previousVisible = -1;
	const anchors: number[] = [];
	for (let logicalLineIndex = 0; logicalLineIndex < source.logicalLineCount; logicalLineIndex += 1) {
		if (visibleLogicalLines[logicalLineIndex]) {
			previousVisible = last[logicalLineIndex]!;
			anchors.push(first[logicalLineIndex]!);
		} else {
			if (previousVisible < 0) throw new Error('A visible-line projection must retain the first logical line');
			anchors.push(previousVisible);
		}
	}
	return Object.freeze(anchors);
}

function readWrapping(value: EditorLineWrapping | undefined): EditorLineWrapping {
	const wrapping = value ?? EditorLineWrapping.Off;
	if (!Object.values(EditorLineWrapping).includes(wrapping)) {
		throw new TypeError('Unknown Stanza editor line wrapping mode');
	}
	return wrapping;
}

function readWrappingIndent(value: WrappingIndent | undefined): WrappingIndent {
	const wrappingIndent = value ?? WrappingIndent.Same;
	if (!isWrappingIndent(wrappingIndent)) {
		throw new TypeError('Unknown Stanza wrapping indent mode');
	}
	return wrappingIndent;
}

function readWrapWidth(value: number | undefined): number {
	const width = value ?? 0;
	if (!isFiniteNumber(width) || width < 0) {
		throw new RangeError('Stanza editor wrap width must be finite and non-negative');
	}
	return width;
}

function readInitialMeasurement(value: InitialMeasurementOptions | undefined): ResolvedInitialMeasurement | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value.schedule !== 'function') {
		throw new TypeError('Stanza initial visual-line measurement requires a scheduler');
	}
	const initialLineCount = value.initialLineCount ?? 512;
	const linesPerSlice = value.linesPerSlice ?? initialLineCount;
	if (!isPositiveSafeInteger(initialLineCount)) {
		throw new RangeError('Stanza initial visual-line measurement count must be a positive safe integer');
	}
	if (!isPositiveSafeInteger(linesPerSlice)) {
		throw new RangeError('Stanza visual-line measurement slice size must be a positive safe integer');
	}
	return Object.freeze({ initialLineCount, linesPerSlice, schedule: value.schedule });
}

function rangesEqual(left: readonly Range[], right: readonly Range[]): boolean {
	return left.length === right.length && left.every((range, index) => range.equalsRange(right[index]));
}
