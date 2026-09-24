import "./decorations.css";
import { Range } from '../../../common/core/range.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { HorizontalRange, type RenderingContext } from "../../view/renderingContext.js";
import { DynamicViewOverlay } from '../../view/dynamicViewOverlay.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import * as viewEvents from '../../../common/viewEvents.js';
import { type ViewModelDecoration } from '../../../common/viewModel/viewModelDecoration.js';

export class DecorationsOverlay extends DynamicViewOverlay {
	private _typicalHalfwidthCharacterWidth: number;
	private _renderResult: string[] | null = null;

	constructor(private readonly _context: ViewContext) {
		super();
		this._typicalHalfwidthCharacterWidth = this._context.configuration.options.get(EditorOption.fontInfo).typicalHalfwidthCharacterWidth;
		this._context.addEventHandler(this);
	}

	public override dispose(): void {
		this._context.removeEventHandler(this);
		this._renderResult = null;
		super.dispose();
	}

	public override onConfigurationChanged(_event: viewEvents.ViewConfigurationChangedEvent): boolean {
		this._typicalHalfwidthCharacterWidth = this._context.configuration.options.get(EditorOption.fontInfo).typicalHalfwidthCharacterWidth;
		return true;
	}
	public override onDecorationsChanged(_event: viewEvents.ViewDecorationsChangedEvent): boolean { return true; }
	public override onFlushed(_event: viewEvents.ViewFlushedEvent): boolean { return true; }
	public override onLinesChanged(_event: viewEvents.ViewLinesChangedEvent): boolean { return true; }
	public override onLinesDeleted(_event: viewEvents.ViewLinesDeletedEvent): boolean { return true; }
	public override onLinesInserted(_event: viewEvents.ViewLinesInsertedEvent): boolean { return true; }
	public override onScrollChanged(event: viewEvents.ViewScrollChangedEvent): boolean { return event.scrollTopChanged || event.scrollWidthChanged; }
	public override onZonesChanged(_event: viewEvents.ViewZonesChangedEvent): boolean { return true; }

	public prepareRender(context: RenderingContext): void {
		const decorations = context.getDecorationsInViewport()
			.filter(decoration => Boolean(decoration.options.className))
			.sort(compareModelDecorations);
		const output = Array.from({ length: context.visibleRange.endLineNumber - context.visibleRange.startLineNumber + 1 }, () => '');
		this.renderWholeLineDecorations(context, decorations, output);
		this.renderNormalDecorations(context, decorations, output);
		this._renderResult = output;
	}

	public render(startLineNumber: number, lineNumber: number): string {
		return this._renderResult?.[lineNumber - startLineNumber] ?? '';
	}

	private renderWholeLineDecorations(context: RenderingContext, decorations: readonly ViewModelDecoration[], output: string[]): void {
		for (const decoration of decorations) {
			if (!decoration.options.isWholeLine) continue;
			const html = `<div class="cdr ${escapeAttribute(decoration.options.className!)}" style="left:0;width:100%;"></div>`;
			const startLineNumber = Math.max(decoration.range.startLineNumber, context.visibleRange.startLineNumber);
			const endLineNumber = Math.min(decoration.range.endLineNumber, context.visibleRange.endLineNumber);
			for (let lineNumber = startLineNumber; lineNumber <= endLineNumber; lineNumber += 1) {
				output[lineNumber - context.visibleRange.startLineNumber] += html;
			}
		}
	}

	private renderNormalDecorations(context: RenderingContext, decorations: readonly ViewModelDecoration[], output: string[]): void {
		let previousClassName: string | undefined;
		let previousRange: Range | undefined;
		let previousShowIfCollapsed = false;
		let previousShouldFillLineOnLineBreak = false;
		const flush = (): void => {
			if (!previousClassName || !previousRange) return;
			this.renderNormalDecoration(context, previousRange, previousClassName, previousShouldFillLineOnLineBreak, previousShowIfCollapsed, output);
		};
		for (const decoration of decorations) {
			if (decoration.options.isWholeLine) continue;
			const className = decoration.options.className!;
			const showIfCollapsed = Boolean(decoration.options.showIfCollapsed);
			let range = decoration.range;
			if (showIfCollapsed && range.endColumn === 1 && range.endLineNumber !== range.startLineNumber) {
				range = new Range(range.startLineNumber, range.startColumn, range.endLineNumber - 1, this._context.viewModel.getLineMaxColumn(range.endLineNumber - 1));
			}
			if (previousClassName === className && previousShowIfCollapsed === showIfCollapsed && previousRange && Range.areIntersectingOrTouching(previousRange, range)) {
				previousRange = Range.plusRange(previousRange, range);
				continue;
			}
			flush();
			previousClassName = className;
			previousRange = range;
			previousShowIfCollapsed = showIfCollapsed;
			previousShouldFillLineOnLineBreak = decoration.options.shouldFillLineOnLineBreak ?? false;
		}
		flush();
	}

	private renderNormalDecoration(context: RenderingContext, range: Range, className: string, shouldFillLineOnLineBreak: boolean, showIfCollapsed: boolean, output: string[]): void {
		const linesVisibleRanges = context.linesVisibleRangesForRange(range, className === 'findMatch');
		if (!linesVisibleRanges) return;
		for (const lineVisibleRanges of linesVisibleRanges) {
			if (lineVisibleRanges.outsideRenderedLine) continue;
			if (showIfCollapsed && lineVisibleRanges.ranges.length === 1 && lineVisibleRanges.ranges[0]!.width < this._typicalHalfwidthCharacterWidth) {
				const rangeCenter = Math.round(lineVisibleRanges.ranges[0]!.left + lineVisibleRanges.ranges[0]!.width / 2);
				const left = Math.max(0, Math.round(rangeCenter - this._typicalHalfwidthCharacterWidth / 2));
				lineVisibleRanges.ranges[0] = new HorizontalRange(left, this._typicalHalfwidthCharacterWidth);
			}
			for (let index = 0; index < lineVisibleRanges.ranges.length; index += 1) {
				const visibleRange = lineVisibleRanges.ranges[index]!;
				const fillToLineEnd = shouldFillLineOnLineBreak && lineVisibleRanges.continuesOnNextLine && lineVisibleRanges.ranges.length === 1;
				output[lineVisibleRanges.lineNumber - context.visibleRange.startLineNumber] += `<div class="cdr ${escapeAttribute(className)}" style="left:${visibleRange.left}px;width:${fillToLineEnd ? '100%' : `${visibleRange.width}px`};"></div>`;
			}
		}
	}
}

function compareModelDecorations(left: ViewModelDecoration, right: ViewModelDecoration): number {
	return (left.options.zIndex ?? 0) - (right.options.zIndex ?? 0)
		|| left.options.className!.localeCompare(right.options.className!)
		|| Range.compareRangesUsingStarts(left.range, right.range);
}

function escapeAttribute(value: string): string {
	return value.replace(/[&"<>]/gu, character => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[character]!);
}
