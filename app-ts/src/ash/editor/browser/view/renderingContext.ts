import { type Position } from '../../common/core/position.js';
import { type Range } from '../../common/core/range.js';
import { type IViewLayout } from '../../common/viewModel.js';
import { type ViewModelDecoration } from '../../common/viewModel/viewModelDecoration.js';
import { ViewportData } from '../../common/viewLayout/viewLinesViewportData.js';

export interface IViewLines {
	linesVisibleRangesForRange(range: Range, includeNewLines: boolean): LineVisibleRanges[] | null;
	visibleRangeForPosition(position: Position): HorizontalPosition | null;
}

export abstract class RestrictedRenderingContext {
	_restrictedRenderingContextBrand: void = undefined;
	public readonly scrollWidth: number;
	public readonly scrollHeight: number;
	public readonly visibleRange: Range;
	public readonly bigNumbersDelta: number;
	public readonly scrollTop: number;
	public readonly scrollLeft: number;
	public readonly viewportWidth: number;
	public readonly viewportHeight: number;

	constructor(private readonly viewLayout: IViewLayout, public readonly viewportData: ViewportData) {
		this.scrollWidth = viewLayout.getScrollWidth();
		this.scrollHeight = viewLayout.getScrollHeight();
		this.visibleRange = viewportData.visibleRange;
		this.bigNumbersDelta = viewportData.bigNumbersDelta;
		const viewport = viewLayout.getCurrentViewport();
		this.scrollTop = viewport.top;
		this.scrollLeft = viewport.left;
		this.viewportWidth = viewport.width;
		this.viewportHeight = viewport.height;
	}

	public getScrolledTopFromAbsoluteTop(absoluteTop: number): number {
		return absoluteTop - this.scrollTop;
	}

	public getVerticalOffsetForLineNumber(lineNumber: number, includeViewZones?: boolean): number {
		return this.viewLayout.getVerticalOffsetForLineNumber(lineNumber, includeViewZones);
	}

	public getVerticalOffsetAfterLineNumber(lineNumber: number, includeViewZones?: boolean): number {
		return this.viewLayout.getVerticalOffsetAfterLineNumber(lineNumber, includeViewZones);
	}

	public getLineHeightForLineNumber(lineNumber: number): number {
		return this.viewLayout.getLineHeightForLineNumber(lineNumber);
	}

	public getDecorationsInViewport(): ViewModelDecoration[] {
		return this.viewportData.getDecorationsInViewport();
	}
}

export class RenderingContext extends RestrictedRenderingContext {
	_renderingContextBrand: void = undefined;

	constructor(viewLayout: IViewLayout, viewportData: ViewportData, private readonly viewLines: IViewLines, private readonly viewLinesGpu?: IViewLines) {
		super(viewLayout, viewportData);
	}

	public linesVisibleRangesForRange(range: Range, includeNewLines: boolean): LineVisibleRanges[] | null {
		const domRanges = this.viewLines.linesVisibleRangesForRange(range, includeNewLines);
		const gpuRanges = this.viewLinesGpu?.linesVisibleRangesForRange(range, includeNewLines) ?? null;
		if (!domRanges) return gpuRanges;
		if (!gpuRanges) return domRanges;
		return domRanges.concat(gpuRanges).sort((left, right) => left.lineNumber - right.lineNumber);
	}

	public visibleRangeForPosition(position: Position): HorizontalPosition | null {
		return this.viewLines.visibleRangeForPosition(position) ?? this.viewLinesGpu?.visibleRangeForPosition(position) ?? null;
	}
}

export class FloatHorizontalRange {
	_floatHorizontalRangeBrand: void = undefined;
	public left: number;
	public width: number;

	constructor(left: number, width: number) {
		this.left = left;
		this.width = width;
	}

	public toString(): string {
		return `[${this.left},${this.width}]`;
	}

	public static compare(left: FloatHorizontalRange, right: FloatHorizontalRange): number {
		return left.left - right.left;
	}
}

export class HorizontalRange {
	_horizontalRangeBrand: void = undefined;
	public left: number;
	public width: number;

	public static from(ranges: FloatHorizontalRange[]): HorizontalRange[] {
		return ranges.map(range => new HorizontalRange(range.left, range.width));
	}

	constructor(left: number, width: number) {
		this.left = Math.round(left);
		this.width = Math.round(width);
	}

	public toString(): string {
		return `[${this.left},${this.width}]`;
	}
}

export class HorizontalPosition {
	public outsideRenderedLine: boolean;
	public left: number;
	public originalLeft: number;

	constructor(outsideRenderedLine: boolean, left: number) {
		this.outsideRenderedLine = outsideRenderedLine;
		this.originalLeft = left;
		this.left = Math.round(left);
	}
}

export class VisibleRanges {
	constructor(
		public readonly outsideRenderedLine: boolean,
		public readonly ranges: FloatHorizontalRange[],
	) { }
}

export class LineVisibleRanges {
	public static firstLine(ranges: LineVisibleRanges[] | null): LineVisibleRanges | null {
		return ranges?.reduce<LineVisibleRanges | null>((first, range) => !first || range.lineNumber < first.lineNumber ? range : first, null) ?? null;
	}

	public static lastLine(ranges: LineVisibleRanges[] | null): LineVisibleRanges | null {
		return ranges?.reduce<LineVisibleRanges | null>((last, range) => !last || range.lineNumber > last.lineNumber ? range : last, null) ?? null;
	}

	constructor(
		public readonly outsideRenderedLine: boolean,
		public readonly lineNumber: number,
		public readonly ranges: HorizontalRange[],
		public readonly continuesOnNextLine: boolean,
	) { }
}
