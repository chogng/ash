import { Emitter, type Event } from '../../../base/common/event.js';
import { type ISize } from '../../../base/common/layout.js';
import { Disposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { isFiniteNumber, isPositiveSafeInteger } from '../../../base/common/numbers.js';
import { type IScrollPosition, Scrollable, type ScrollEvent } from '../../../base/common/scrollable.js';
import { type INewScrollPosition, ScrollType } from '../editorCommon.js';
import { type IEditorConfiguration } from '../config/editorConfiguration.js';
import { type ConfigurationChangedEvent, EditorOption } from '../config/editorOptions.js';
import { type IEditorWhitespace, type ILineHeightChangeAccessor, type IPartialViewLinesViewportData, type IViewWhitespaceViewportData, type IWhitespaceChangeAccessor, Viewport, type EditorLineHeightChangeAccessor, type EditorLineRange, type EditorScrollPosition } from '../viewModel.js';
import { ContentSizeChangedEvent } from '../viewModelEventDispatcher.js';
import { type CustomLineHeightData } from './lineHeights.js';
import { LinesLayout } from './linesLayout.js';

export type { EditorLineHeightChangeAccessor, EditorLineRange, EditorScrollPosition } from '../viewModel.js';

/** Vertical space reserved around the projected line collection. */
export interface EditorViewportVerticalPadding {
	readonly top: number;
	readonly bottom: number;
}
interface LinesLayoutViewport {
	readonly lineCount: number;
	readonly contentHeight: number;
	readonly visibleLines: EditorLineRange;
	readonly renderLines: EditorLineRange;
	readonly renderTop: number;
	readonly relativeVerticalOffset: readonly number[];
}
/**
 * Owns vertical line geometry, view zones, and rendered ranges.
 *
 * The outer layout owner keeps horizontal dimensions and scroll state. This
 * helper keeps the vertical line collection and padding.
 */
class VerticalLayout {
	private readonly linesLayout: LinesLayout;
	private readonly customLineHeights = new Map<string, CustomLineHeightData>();
	private lineCountValue: number;
	private defaultLineHeight: number;
	private paddingTop: number;
	private paddingBottom: number;
	public constructor(
		lineCount: number,
		lineHeight: number,
		paddingTop = 0,
		paddingBottom = 0,
		customLineHeightData: readonly CustomLineHeightData[] = [],
	) {
		validateLineCount(lineCount);
		this.paddingTop = nonNegativeFinite(paddingTop, 'paddingTop');
		this.paddingBottom = nonNegativeFinite(paddingBottom, 'paddingBottom');
		this.defaultLineHeight = lineHeight;
		for (const data of customLineHeightData) this.customLineHeights.set(data.decorationId, data);
		this.lineCountValue = lineCount;
		this.linesLayout = new LinesLayout(lineCount, lineHeight, this.paddingTop, this.paddingBottom, [...this.customLineHeights.values()]);
	}
	public get lineCount(): number {
		return this.lineCountValue;
	}
	public get lineHeight(): number {
		return this.defaultLineHeight;
	}
	public get padding(): EditorViewportVerticalPadding {
		return Object.freeze({ top: this.paddingTop, bottom: this.paddingBottom });
	}
	public setDefaultLineHeight(lineHeight: number): void {
		this.defaultLineHeight = lineHeight;
		this.linesLayout.setDefaultLineHeight(lineHeight);
	}
	public setPadding(paddingTop: number, paddingBottom: number): void {
		this.paddingTop = nonNegativeFinite(paddingTop, 'paddingTop');
		this.paddingBottom = nonNegativeFinite(paddingBottom, 'paddingBottom');
		this.linesLayout.setPadding(this.paddingTop, this.paddingBottom);
	}
	public changeLineHeights(callback: (accessor: EditorLineHeightChangeAccessor) => void): boolean {
		if (typeof callback !== 'function') throw new TypeError('Line-height changes require a callback');
		void this.lineCount;
		let hadAChange = false;
		this.linesLayout.changeLineHeights(accessor => {
			callback({
				insertOrChangeCustomLineHeight: (decorationId, startLineNumber, endLineNumber, lineHeight) => {
					hadAChange = true;
					this.customLineHeights.set(decorationId, { decorationId, startLineNumber, endLineNumber, lineHeight });
					accessor.insertOrChangeCustomLineHeight(decorationId, startLineNumber, endLineNumber, lineHeight);
				},
				removeCustomLineHeight: decorationId => {
					hadAChange = true;
					this.customLineHeights.delete(decorationId);
					accessor.removeCustomLineHeight(decorationId);
				},
			});
		});
		return hadAChange;
	}
	public changeWhitespace(callback: (accessor: IWhitespaceChangeAccessor) => void): boolean {
		void this.lineCount;
		return this.linesLayout.changeWhitespace(callback);
	}
	public onFlushed(lineCount: number, customLineHeightData: readonly CustomLineHeightData[]): void {
		validateLineCount(lineCount);
		this.customLineHeights.clear();
		for (const data of customLineHeightData) this.customLineHeights.set(data.decorationId, data);
		this.linesLayout.onFlushed(lineCount, [...this.customLineHeights.values()]);
		this.lineCountValue = lineCount;
	}
	public onLinesDeleted(fromLineNumber: number, toLineNumber: number): void { this.linesLayout.onLinesDeleted(fromLineNumber, toLineNumber); this.lineCountValue -= toLineNumber - fromLineNumber + 1; }
	public onLinesInserted(fromLineNumber: number, toLineNumber: number): void { this.linesLayout.onLinesInserted(fromLineNumber, toLineNumber); this.lineCountValue += toLineNumber - fromLineNumber + 1; }
	public getLinesTotalHeight(): number {
		void this.lineCount;
		return this.linesLayout.getLinesTotalHeight();
	}
	public getVerticalOffsetForLineNumber(lineNumber: number, includeViewZones = false): number {
		void this.lineCount;
		return this.linesLayout.getVerticalOffsetForLineNumber(lineNumber, includeViewZones);
	}
	public getVerticalOffsetAfterLineNumber(lineNumber: number, includeViewZones = false): number {
		void this.lineCount;
		return this.linesLayout.getVerticalOffsetAfterLineNumber(lineNumber, includeViewZones);
	}
	public getLineHeightForLineNumber(lineNumber: number): number {
		void this.lineCount;
		return this.linesLayout.getLineHeightForLineNumber(lineNumber);
	}
	public isAfterLines(verticalOffset: number): boolean {
		void this.lineCount;
		return this.linesLayout.isAfterLines(verticalOffset);
	}
	public isInTopPadding(verticalOffset: number): boolean {
		return this.linesLayout.isInTopPadding(verticalOffset);
	}
	public isInBottomPadding(verticalOffset: number): boolean {
		void this.lineCount;
		return this.linesLayout.isInBottomPadding(verticalOffset);
	}
	public getPartialViewportData(scrollTop: number, height: number): IPartialViewLinesViewportData {
		void this.lineCount;
		return this.linesLayout.getLinesViewportData(scrollTop, scrollTop + height);
	}
	public getWhitespaceAtVerticalOffset(verticalOffset: number): IViewWhitespaceViewportData | null {
		void this.lineCount;
		return this.linesLayout.getWhitespaceAtVerticalOffset(verticalOffset);
	}
	public getWhitespaceViewportData(scrollTop: number, height: number): IViewWhitespaceViewportData[] {
		void this.lineCount;
		return this.linesLayout.getWhitespaceViewportData(scrollTop, scrollTop + height);
	}
	public getWhitespaces(): IEditorWhitespace[] {
		void this.lineCount;
		return this.linesLayout.getWhitespaces();
	}
	public getWhitespaceMinWidth(): number { return this.linesLayout.getWhitespaceMinWidth(); }
	public getVerticalOffsetForLineIndex(lineIndex: number): number {
		void this.lineCount;
		return this.linesLayout.getVerticalOffsetForLineNumber(lineIndex + 1);
	}
	public getLineHeightForLineIndex(lineIndex: number): number {
		if (!Number.isSafeInteger(lineIndex) || lineIndex < 0 || lineIndex >= this.lineCount) {
			throw new RangeError('Line index is outside the line collection');
		}
		return this.linesLayout.getLineHeightForLineNumber(lineIndex + 1);
	}
	public getLinesViewportData(verticalOffset: number, viewportHeight: number): LinesLayoutViewport {
		if (!isFiniteNumber(verticalOffset) || !isFiniteNumber(viewportHeight) || viewportHeight < 0) {
			throw new RangeError('Line viewport coordinates must be finite and non-negative');
		}
		const lineCount = this.lineCount;
		const visibleLines = !this.linesLayout.hasWhitespace()
			? this.getVisibleLineRange(verticalOffset, viewportHeight)
			: this.getVisibleLineRangeWithViewZones(verticalOffset, viewportHeight);
		const renderLines = visibleLines;
		return Object.freeze({
			lineCount,
			contentHeight: this.linesLayout.getLinesTotalHeight(),
			visibleLines,
			renderLines,
			renderTop: this.getVerticalOffsetForLineIndex(renderLines.startLineIndex),
			relativeVerticalOffset: Object.freeze(Array.from(
				{ length: renderLines.endLineIndexExclusive - renderLines.startLineIndex },
				(_, index) => this.getVerticalOffsetForLineIndex(renderLines.startLineIndex + index),
			)),
		});
	}
	public getLineNumberAtVerticalOffset(verticalOffset: number): number {
		if (!isFiniteNumber(verticalOffset)) throw new RangeError('Vertical offset must be finite');
		const lineCount = this.lineCount;
		if (verticalOffset < this.paddingTop) return 0;
		if (verticalOffset >= this.linesLayout.getLinesTotalHeight() - this.paddingBottom) return lineCount;
		return this.linesLayout.getLineNumberAtOrAfterVerticalOffset(verticalOffset) - 1;
	}
	private getVisibleLineRange(verticalOffset: number, viewportHeight: number): EditorLineRange {
		const lineCount = this.lineCount;
		if (viewportHeight === 0) return lineRange(0, 0);
		const visibleBottom = verticalOffset + viewportHeight;
		const linesBottom = this.linesLayout.getLinesTotalHeight() - this.paddingBottom;
		if (visibleBottom <= this.paddingTop) return lineRange(0, 0);
		if (verticalOffset >= linesBottom) return lineRange(lineCount, lineCount);
		const viewport = this.linesLayout.getLinesViewportData(verticalOffset, visibleBottom);
		return lineRange(viewport.startLineNumber - 1, viewport.endLineNumber);
	}
	private getVisibleLineRangeWithViewZones(verticalOffset: number, viewportHeight: number): EditorLineRange {
		if (viewportHeight === 0) return lineRange(0, 0);
		const visibleBottom = verticalOffset + viewportHeight;
		const startLineIndex = this.getLineNumberAtVerticalOffset(verticalOffset);
		if (startLineIndex >= this.lineCount || this.getVerticalOffsetForLineIndex(startLineIndex) >= visibleBottom) return lineRange(startLineIndex, startLineIndex);
		let endLineIndexExclusive = startLineIndex;
		while (endLineIndexExclusive < this.lineCount && this.getVerticalOffsetForLineIndex(endLineIndexExclusive) < visibleBottom) endLineIndexExclusive += 1;
		return lineRange(startLineIndex, endLineIndexExclusive);
	}
}
function lineRange(startLineIndex: number, endLineIndexExclusive: number): EditorLineRange {
	return Object.freeze({ startLineIndex, endLineIndexExclusive });
}
function validateLineCount(lineCount: number | undefined): asserts lineCount is number {
	if (!isPositiveSafeInteger(lineCount)) throw new RangeError('Line count must be a positive safe integer');
}

export interface EditorViewportLayout {
	readonly lineHeight: number;
	readonly viewportSize: ISize;
	readonly contentSize: ISize;
	readonly scrollPosition: EditorScrollPosition;
	readonly maximumScrollPosition: EditorScrollPosition;
	readonly visibleLines: EditorLineRange;
	readonly renderLines: EditorLineRange;
	readonly renderTop: number;
	readonly relativeVerticalOffset?: readonly number[];
}

export enum EditorViewportChangeReason {
	Model = 'model',
	LineProjection = 'lineProjection',
	ViewportSize = 'viewportSize',
	ContentWidth = 'contentWidth',
	LineHeight = 'lineHeight',
	Scroll = 'scroll',
	EditorViewZones = 'viewZones',
}

export interface EditorViewportChange {
	readonly reason: EditorViewportChangeReason;
	readonly layout: EditorViewportLayout;
}

/**
 * Owns the immutable layout snapshot shared by the browser view and view-model.
 *
 * Horizontal measurement and scroll state stay here, while `VerticalLayout`
 * owns line heights, padding, view zones, and rendered line ranges.
 */
export class ViewLayout extends Disposable {
	private readonly changeEmitter = this._register(new Emitter<EditorViewportChange>());
	private readonly contentSizeEmitter = this._register(new Emitter<ContentSizeChangedEvent>());
	private readonly linesLayout: VerticalLayout;
	private readonly scrollable: Scrollable;
	private viewportSize: ISize = Object.freeze({ width: 0, height: 0 });
	private maxLineWidth = 0;
	private overlayWidgetsMinWidth = 0;
	private currentLayout: EditorViewportLayout;
	private pendingReason: EditorViewportChangeReason | undefined;
	private isPublishing = false;

	public readonly onDidChange: Event<EditorViewportChange> = this.changeEmitter.event;
	public readonly onDidScroll: Event<ScrollEvent>;
	public readonly onDidContentSizeChange: Event<ContentSizeChangedEvent> = this.contentSizeEmitter.event;

	public constructor(
		private readonly configuration: IEditorConfiguration,
		lineCount: number,
		customLineHeightData: CustomLineHeightData[],
		scheduleAtNextAnimationFrame: (callback: () => void) => IDisposable,
	) {
		super();
		validateLineCount(lineCount);
		const options = configuration.options;
		const lineHeight = positiveFinite(options.get(EditorOption.lineHeight), 'lineHeight');
		const padding = readPadding(options.get(EditorOption.padding));
		const layoutInfo = options.get(EditorOption.layoutInfo);
		this.viewportSize = readSize({ width: layoutInfo.width, height: layoutInfo.height }, 'viewportSize');
		this.linesLayout = new VerticalLayout(
			lineCount,
			lineHeight,
			padding.top,
			padding.bottom,
			customLineHeightData,
		);
		this.scrollable = this._register(new Scrollable({
			forceIntegerValues: false,
			smoothScrollDuration: options.get(EditorOption.smoothScrolling) ? 125 : 0,
			scheduleAtNextAnimationFrame,
		}));
		this.onDidScroll = this.scrollable.onScroll;
		this.scrollable.setScrollDimensions(this.readScrollDimensions(), false);
		this.currentLayout = this.createLayout();
		this._register(this.scrollable.onScroll(() => this.acceptScrollableChange()));
	}

	public get layout(): EditorViewportLayout {
		return this.currentLayout;
	}

	public get lineCount(): number {
		return this.linesLayout.lineCount;
	}

	public getContentWidth(): number {
		return this.currentLayout.contentSize.width;
	}

	public getScrollable(): Scrollable {
		return this.scrollable;
	}

	public getScrollWidth(): number {
		return this.currentLayout.contentSize.width;
	}

	public getContentHeight(): number {
		return this.currentLayout.contentSize.height;
	}

	public getScrollHeight(): number {
		return this.currentLayout.contentSize.height;
	}

	public getCurrentScrollLeft(): number {
		return this.scrollable.getCurrentScrollPosition().scrollLeft;
	}

	public getCurrentScrollTop(): number {
		return this.scrollable.getCurrentScrollPosition().scrollTop;
	}

	public getCurrentViewport(): Viewport {
		const { scrollPosition, viewportSize } = this.currentLayout;
		return new Viewport(scrollPosition.top, scrollPosition.left, viewportSize.width, viewportSize.height);
	}

	public getFutureViewport(): Viewport {
		const position = this.scrollable.getFutureScrollPosition();
		return new Viewport(position.scrollTop, position.scrollLeft, this.viewportSize.width, this.viewportSize.height);
	}

	public validateScrollPosition(position: INewScrollPosition): IScrollPosition {
		return this.scrollable.validateScrollPosition(position);
	}

	public deltaScrollNow(deltaScrollLeft: number, deltaScrollTop: number): void {
		this.scrollable.setScrollPositionNow({
			scrollLeft: this.getCurrentScrollLeft() + finite(deltaScrollLeft, 'deltaScrollLeft'),
			scrollTop: this.getCurrentScrollTop() + finite(deltaScrollTop, 'deltaScrollTop'),
		});
	}

	public hasPendingScrollAnimation(): boolean {
		return this.scrollable.hasPendingScrollAnimation();
	}

	public saveState(): { scrollTop: number; scrollTopWithoutViewZones: number; scrollLeft: number } {
		const { left, top } = this.currentLayout.scrollPosition;
		return { scrollTop: top, scrollTopWithoutViewZones: top, scrollLeft: left };
	}

	public onConfigurationChanged(event: ConfigurationChangedEvent): void {
		const options = this.configuration.options;
		this.scrollable.setSmoothScrollDuration(options.get(EditorOption.smoothScrolling) ? 125 : 0);
		let reason = EditorViewportChangeReason.ViewportSize;
		let changed = false;
		let scrollPosition: INewScrollPosition | undefined;
		if (event.hasChanged(EditorOption.lineHeight)) {
			const lineHeight = positiveFinite(options.get(EditorOption.lineHeight), 'lineHeight');
			if (lineHeight !== this.linesLayout.lineHeight) {
				const currentTop = this.getCurrentScrollTop();
				const paddingTop = this.linesLayout.padding.top;
				scrollPosition = {
					scrollLeft: this.getCurrentScrollLeft(),
					scrollTop: currentTop <= paddingTop ? currentTop : paddingTop + (currentTop - paddingTop) / this.linesLayout.lineHeight * lineHeight,
				};
				this.linesLayout.setDefaultLineHeight(lineHeight);
				reason = EditorViewportChangeReason.LineHeight;
				changed = true;
			}
		}
		if (event.hasChanged(EditorOption.padding)) {
			const padding = readPadding(options.get(EditorOption.padding));
			if (padding.top !== this.linesLayout.padding.top || padding.bottom !== this.linesLayout.padding.bottom) {
				this.linesLayout.setPadding(padding.top, padding.bottom);
				changed = true;
			}
		}
		if (event.hasChanged(EditorOption.layoutInfo)) {
			const layoutInfo = options.get(EditorOption.layoutInfo);
			const size = readSize({ width: layoutInfo.width, height: layoutInfo.height }, 'viewportSize');
			if (!sizesEqual(this.viewportSize, size)) {
				this.viewportSize = size;
				changed = true;
			}
		}
		if (changed) this.publish(reason, scrollPosition);
	}

	public getVerticalOffsetForLineNumber(lineNumber: number, includeViewZones = false): number {
		return this.linesLayout.getVerticalOffsetForLineNumber(lineNumber, includeViewZones);
	}

	public getVerticalOffsetAfterLineNumber(lineNumber: number, includeViewZones = false): number {
		return this.linesLayout.getVerticalOffsetAfterLineNumber(lineNumber, includeViewZones);
	}

	public getLineHeightForLineNumber(lineNumber: number): number {
		return this.linesLayout.getLineHeightForLineNumber(lineNumber);
	}

	public getLineNumberAtVerticalOffset(verticalOffset: number): number {
		return this.linesLayout.getLineNumberAtVerticalOffset(verticalOffset) + 1;
	}

	public isAfterLines(verticalOffset: number): boolean {
		return this.linesLayout.isAfterLines(verticalOffset);
	}

	public isInTopPadding(verticalOffset: number): boolean {
		return this.linesLayout.isInTopPadding(verticalOffset);
	}

	public isInBottomPadding(verticalOffset: number): boolean {
		return this.linesLayout.isInBottomPadding(verticalOffset);
	}

	public getLinesViewportData(): IPartialViewLinesViewportData {
		return this.linesLayout.getPartialViewportData(this.currentLayout.scrollPosition.top, this.viewportSize.height);
	}

	public getLinesViewportDataAtScrollTop(scrollTop: number): IPartialViewLinesViewportData {
		return this.linesLayout.getPartialViewportData(scrollTop, this.viewportSize.height);
	}

	public getWhitespaceAtVerticalOffset(verticalOffset: number): IViewWhitespaceViewportData | null {
		return this.linesLayout.getWhitespaceAtVerticalOffset(verticalOffset);
	}

	public getWhitespaceViewportData(): IViewWhitespaceViewportData[] {
		return this.linesLayout.getWhitespaceViewportData(this.currentLayout.scrollPosition.top, this.viewportSize.height);
	}

	public getWhitespaces(): IEditorWhitespace[] {
		return this.linesLayout.getWhitespaces();
	}

	public setViewportSize(size: ISize): EditorViewportLayout {
		const next = readSize(size, 'viewportSize');
		if (sizesEqual(this.viewportSize, next)) return this.currentLayout;
		this.viewportSize = next;
		this.publish(EditorViewportChangeReason.ViewportSize);
		return this.currentLayout;
	}

	public setMaxLineWidth(width: number): void {
		const next = nonNegativeFinite(width, 'contentWidth');
		if (this.maxLineWidth === next) return;
		this.maxLineWidth = next;
		this.publish(EditorViewportChangeReason.ContentWidth);
	}

	public setOverlayWidgetsMinWidth(width: number): void {
		const next = nonNegativeFinite(width, 'overlayWidgetsMinWidth');
		if (this.overlayWidgetsMinWidth === next) return;
		this.overlayWidgetsMinWidth = next;
		this.publish(EditorViewportChangeReason.ContentWidth);
	}

	public setLineHeight(lineHeight: number): EditorViewportLayout {
		const next = positiveFinite(lineHeight, 'lineHeight');
		if (this.linesLayout.lineHeight === next) return this.currentLayout;
		const currentTop = this.currentLayout.scrollPosition.top;
		const paddingTop = this.linesLayout.padding.top;
		const nextTop = currentTop <= paddingTop
			? currentTop
			: paddingTop + (currentTop - paddingTop) / this.linesLayout.lineHeight * next;
		this.linesLayout.setDefaultLineHeight(next);
		this.publish(EditorViewportChangeReason.LineHeight, {
			scrollLeft: this.currentLayout.scrollPosition.left,
			scrollTop: nextTop,
		});
		return this.currentLayout;
	}

	public changeSpecialLineHeights(callback: (accessor: ILineHeightChangeAccessor) => void): boolean {
		if (!this.linesLayout.changeLineHeights(callback)) return false;
		this.publish(EditorViewportChangeReason.LineHeight);
		return true;
	}

	public changeWhitespace(callback: (accessor: IWhitespaceChangeAccessor) => void): boolean {
		if (!this.linesLayout.changeWhitespace(callback)) return false;
		this.publish(EditorViewportChangeReason.EditorViewZones);
		return true;
	}

	public onHeightMaybeChanged(): void {
		this.publish(EditorViewportChangeReason.LineHeight);
	}

	public onFlushed(lineCount: number, customLineHeightData: CustomLineHeightData[]): void {
		this.linesLayout.onFlushed(lineCount, customLineHeightData);
		this.publish(EditorViewportChangeReason.Model);
	}

	public onLinesDeleted(fromLineNumber: number, toLineNumber: number): void {
		this.linesLayout.onLinesDeleted(fromLineNumber, toLineNumber);
		this.publish(EditorViewportChangeReason.Model);
	}

	public onLinesInserted(fromLineNumber: number, toLineNumber: number): void {
		this.linesLayout.onLinesInserted(fromLineNumber, toLineNumber);
		this.publish(EditorViewportChangeReason.Model);
	}

	public getVerticalOffsetForLineIndex(lineIndex: number): number {
		return this.linesLayout.getVerticalOffsetForLineIndex(lineIndex);
	}

	public getLineIndexAtVerticalOffset(verticalOffset: number): number {
		return this.linesLayout.getLineNumberAtVerticalOffset(verticalOffset);
	}

	public setScrollPosition(position: INewScrollPosition, type: ScrollType): void {
		if (type === ScrollType.Immediate) {
			this.scrollable.setScrollPositionNow(position);
			return;
		}
		this.scrollable.setScrollPositionSmooth(position);
	}

	private publish(reason: EditorViewportChangeReason, scrollPosition?: INewScrollPosition): void {
		this.pendingReason = reason;
		this.isPublishing = true;
		try {
			this.scrollable.setScrollDimensions(this.readScrollDimensions(), false);
			if (scrollPosition) this.scrollable.setScrollPositionNow(scrollPosition);
		} finally {
			this.isPublishing = false;
		}
		this.acceptScrollableChange();
		this.pendingReason = undefined;
	}

	private acceptScrollableChange(): void {
		if (this.isPublishing) return;
		const previous = this.currentLayout;
		const next = this.createLayout();
		if (layoutsEqual(previous, next)) return;
		this.currentLayout = next;
		if (!sizesEqual(previous.contentSize, next.contentSize)) {
			this.contentSizeEmitter.fire(new ContentSizeChangedEvent(
				previous.contentSize.width,
				previous.contentSize.height,
				next.contentSize.width,
				next.contentSize.height,
			));
		}
		this.changeEmitter.fire(Object.freeze({
			reason: this.pendingReason ?? EditorViewportChangeReason.Scroll,
			layout: next,
		}));
	}

	private readScrollDimensions(): { width: number; scrollWidth: number; height: number; scrollHeight: number } {
		const contentWidth = Math.max(this.viewportSize.width, this.maxLineWidth, this.overlayWidgetsMinWidth, this.linesLayout.getWhitespaceMinWidth());
		const contentHeight = Math.max(this.viewportSize.height, this.linesLayout.getLinesTotalHeight());
		return {
			width: this.viewportSize.width,
			scrollWidth: contentWidth,
			height: this.viewportSize.height,
			scrollHeight: contentHeight,
		};
	}

	private createLayout(): EditorViewportLayout {
		const contentSize = Object.freeze({
			width: Math.max(this.viewportSize.width, this.maxLineWidth, this.overlayWidgetsMinWidth, this.linesLayout.getWhitespaceMinWidth()),
			height: Math.max(this.viewportSize.height, this.linesLayout.getLinesTotalHeight()),
		});
		const maximumScrollPosition = Object.freeze({
			left: Math.max(0, contentSize.width - this.viewportSize.width),
			top: Math.max(0, contentSize.height - this.viewportSize.height),
		});
		const currentScrollPosition = this.scrollable.getCurrentScrollPosition();
		const scrollPosition = Object.freeze({ left: currentScrollPosition.scrollLeft, top: currentScrollPosition.scrollTop });
		const viewportData = this.linesLayout.getLinesViewportData(scrollPosition.top, this.viewportSize.height);
		return Object.freeze({
			lineHeight: this.linesLayout.lineHeight,
			viewportSize: this.viewportSize,
			contentSize,
			scrollPosition,
			maximumScrollPosition,
			visibleLines: viewportData.visibleLines,
			renderLines: viewportData.renderLines,
			renderTop: viewportData.renderTop,
			...(this.linesLayout.getWhitespaces().length > 0 ? { relativeVerticalOffset: viewportData.relativeVerticalOffset } : {}),
		});
	}
}

function readPadding(padding: EditorViewportVerticalPadding | undefined): EditorViewportVerticalPadding {
	return Object.freeze({
		top: nonNegativeFinite(padding?.top ?? 0, 'padding.top'),
		bottom: nonNegativeFinite(padding?.bottom ?? 0, 'padding.bottom'),
	});
}

function readSize(size: ISize, name: string): ISize {
	if (!size || typeof size !== 'object') throw new TypeError(`${name} must be a size`);
	return Object.freeze({
		width: nonNegativeFinite(size.width, `${name}.width`),
		height: nonNegativeFinite(size.height, `${name}.height`),
	});
}

function positiveFinite(value: number, name: string): number {
	const result = finite(value, name);
	if (result <= 0) throw new RangeError(`${name} must be positive`);
	return result;
}

function nonNegativeFinite(value: number, name: string): number {
	const result = finite(value, name);
	if (result < 0) throw new RangeError(`${name} must be non-negative`);
	return result;
}

function finite(value: number, name: string): number {
	if (!isFiniteNumber(value)) throw new RangeError(`${name} must be finite`);
	return value;
}

function sizesEqual(left: ISize, right: ISize): boolean {
	return left.width === right.width && left.height === right.height;
}

function scrollPositionsEqual(left: EditorScrollPosition, right: EditorScrollPosition): boolean {
	return left.left === right.left && left.top === right.top;
}

function layoutsEqual(left: EditorViewportLayout, right: EditorViewportLayout): boolean {
	return left.lineHeight === right.lineHeight &&
		sizesEqual(left.viewportSize, right.viewportSize) &&
		sizesEqual(left.contentSize, right.contentSize) &&
		scrollPositionsEqual(left.scrollPosition, right.scrollPosition) &&
		scrollPositionsEqual(left.maximumScrollPosition, right.maximumScrollPosition) &&
		lineRangesEqual(left.visibleLines, right.visibleLines) &&
		lineRangesEqual(left.renderLines, right.renderLines) &&
		left.renderTop === right.renderTop &&
		numberArraysEqual(left.relativeVerticalOffset, right.relativeVerticalOffset);
}

function numberArraysEqual(left: readonly number[] | undefined, right: readonly number[] | undefined): boolean {
	if (left === right) return true;
	if (!left || !right || left.length !== right.length) return false;
	return left.every((value, index) => value === right[index]);
}

function lineRangesEqual(left: EditorLineRange, right: EditorLineRange): boolean {
	return left.startLineIndex === right.startLineIndex && left.endLineIndexExclusive === right.endLineIndexExclusive;
}
