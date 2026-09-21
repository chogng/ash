import { Position } from "../core/position.js";
import { getTextGraphemeBoundaries } from "../core/textSegmentation.js";
import { type TextModel } from "../model/textModel.js";
import { type InjectedText } from "../modelLineProjectionData.js";
import { type EditorVisualLineProjection } from "./modelLineProjection.js";
import { type EditorScrollPosition, type TextMeasurer } from '../viewModel.js';

export interface ClientPoint {
	readonly clientX: number;
	readonly clientY: number;
}

export interface ViewportPoint {
	readonly left: number;
	readonly top: number;
}

export interface HitTestLayout {
	readonly lineHeight: number;
	readonly viewportSize: {
		readonly width: number;
		readonly height: number;
	};
	readonly scrollPosition: EditorScrollPosition;
}

export interface HitTestMetrics {
	readonly gutterWidth: number;
	readonly textLeft: number;
	readonly paddingTop?: number;
	readonly getLineIndexAtVerticalOffset?: (verticalOffset: number) => number;
}

export enum EditorHitTargetKind {
	Gutter = "gutter",
	Text = "text",
	EmptyContent = "emptyContent",
	AfterLines = "afterLines",
}

export interface EditorHitTarget {
	readonly kind: EditorHitTargetKind;
	readonly position: Position;
	readonly viewPosition?: Position;
	readonly injectedText?: InjectedText | null;
}

/** @internal */
export function hitTestStanzaEditorPoint(
	model: TextModel,
	layout: HitTestLayout,
	point: ViewportPoint,
	metrics: HitTestMetrics,
	measurer: TextMeasurer,
): EditorHitTarget | undefined {
	validatePoint(point);
	validateLayout(layout);
	validateMetrics(metrics);
	if (
		point.left < 0 ||
		point.top < 0 ||
		point.left >= layout.viewportSize.width ||
		point.top >= layout.viewportSize.height
	) {
		return undefined;
	}

	const contentTop = point.top + layout.scrollPosition.top - (metrics.paddingTop ?? 0);
	if (contentTop < 0) {
		return target(EditorHitTargetKind.EmptyContent, 0, 0);
	}
	const lineIndex = Math.floor(contentTop / layout.lineHeight);
	if (lineIndex >= model.lineCount) {
		const lastLineIndex = model.lineCount - 1;
		return target(
			EditorHitTargetKind.AfterLines,
			lastLineIndex,
			model.getLineContent((lastLineIndex) + 1).length,
		);
	}
	if (point.left < metrics.gutterWidth) {
		return target(EditorHitTargetKind.Gutter, lineIndex, 0);
	}

	const line = model.getLineContent((lineIndex) + 1);
	const textOffset =
		point.left + layout.scrollPosition.left - metrics.textLeft;
	if (textOffset < 0 || line.length === 0) {
		return target(EditorHitTargetKind.EmptyContent, lineIndex, 0);
	}
	const lineWidth = measurer.measureLineWidth(line);
	if (textOffset >= lineWidth) {
		return target(
			EditorHitTargetKind.EmptyContent,
			lineIndex,
			line.length,
		);
	}
	return target(
		EditorHitTargetKind.Text,
		lineIndex,
		nearestCursorColumn(line, textOffset, measurer),
	);
}

/** @internal */
export function hitTestStanzaVisualEditorPoint(model: TextModel, projection: EditorVisualLineProjection, layout: HitTestLayout, point: ViewportPoint, metrics: HitTestMetrics, measurer: TextMeasurer): EditorHitTarget | undefined {
	validatePoint(point);
	validateLayout(layout);
	validateMetrics(metrics);
	if (projection.modelVersion !== model.version) {
		throw new Error("Stanza visual hit testing requires the current text model projection");
	}
	if (
		point.left < 0 ||
		point.top < 0 ||
		point.left >= layout.viewportSize.width ||
		point.top >= layout.viewportSize.height
	) {
		return undefined;
	}
	const contentTop = point.top + layout.scrollPosition.top - (metrics.paddingTop ?? 0);
	if (contentTop < 0) {
		return target(EditorHitTargetKind.EmptyContent, 0, 0);
	}
	const visualLineIndex = metrics.getLineIndexAtVerticalOffset?.(contentTop + (metrics.paddingTop ?? 0)) ?? Math.floor(contentTop / layout.lineHeight);
	if (visualLineIndex >= projection.visualLineCount) {
		const logicalLineIndex = model.lineCount - 1;
		return target(EditorHitTargetKind.AfterLines, logicalLineIndex, model.getLineContent((logicalLineIndex) + 1).length);
	}
	const visualLine = projection.lineAt(visualLineIndex)!;
	if (point.left < metrics.gutterWidth) {
		return target(EditorHitTargetKind.Gutter, visualLine.logicalLineIndex, 0);
	}
	const text = projection.getViewLineData(model, visualLineIndex + 1).content;
	const textOffset = point.left + layout.scrollPosition.left - metrics.textLeft - (visualLine.projectionData ? 0 : visualLine.wrappedTextIndentWidth ?? 0);
	if (textOffset < 0 || text.length === 0) {
		return visualTarget(EditorHitTargetKind.EmptyContent, projection, visualLineIndex, 0);
	}
	const lineWidth = measurer.measureLineWidth(text);
	if (textOffset >= lineWidth) {
		return visualTarget(EditorHitTargetKind.EmptyContent, projection, visualLineIndex, text.length);
	}
	return visualTarget(EditorHitTargetKind.Text, projection, visualLineIndex, nearestCursorColumn(text, textOffset, measurer));
}

function visualTarget(kind: EditorHitTargetKind, projection: EditorVisualLineProjection, visualLineIndex: number, columnIndex: number): EditorHitTarget {
	const viewPosition = new Position(visualLineIndex + 1, columnIndex + 1);
	return Object.freeze({
		kind,
		position: projection.convertViewPositionToModelPosition(viewPosition),
		viewPosition,
		injectedText: projection.getInjectedTextAt(viewPosition),
	});
}

function nearestCursorColumn(
	line: string,
	horizontalOffset: number,
	measurer: TextMeasurer,
): number {
	const boundaries = getTextGraphemeBoundaries(line);
	let low = 0;
	let high = boundaries.length - 1;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		const leftColumn = boundaries[middle] ?? 0;
		const rightColumn = boundaries[middle + 1] ?? line.length;
		const left = measurer.measureLineWidth(line.slice(0, leftColumn));
		const right = measurer.measureLineWidth(line.slice(0, rightColumn));
		if (horizontalOffset < left + (right - left) / 2) {
			high = middle;
		} else {
			low = middle + 1;
		}
	}
	return boundaries[low] ?? line.length;
}

function target(
	kind: EditorHitTargetKind,
	lineIndex: number,
	columnIndex: number,
): EditorHitTarget {
	return Object.freeze({
		kind,
		position: new Position((lineIndex) + 1, (columnIndex) + 1),
	});
}

function validatePoint(point: ViewportPoint): void {
	if (
		!point ||
		!Number.isFinite(point.left) ||
		!Number.isFinite(point.top)
	) {
		throw new RangeError("Stanza hit-test point must contain finite coordinates");
	}
}

function validateLayout(layout: HitTestLayout): void {
	if (
		!layout ||
		!Number.isFinite(layout.lineHeight) ||
		layout.lineHeight <= 0 ||
		!layout.viewportSize ||
		!Number.isFinite(layout.viewportSize.width) ||
		layout.viewportSize.width < 0 ||
		!Number.isFinite(layout.viewportSize.height) ||
		layout.viewportSize.height < 0 ||
		!layout.scrollPosition ||
		!Number.isFinite(layout.scrollPosition.left) ||
		layout.scrollPosition.left < 0 ||
		!Number.isFinite(layout.scrollPosition.top) ||
		layout.scrollPosition.top < 0
	) {
		throw new RangeError("Stanza hit-test layout is invalid");
	}
}

function validateMetrics(metrics: HitTestMetrics): void {
	if (
		!metrics ||
		!Number.isFinite(metrics.gutterWidth) ||
		metrics.gutterWidth < 0 ||
		!Number.isFinite(metrics.textLeft) ||
		metrics.textLeft < metrics.gutterWidth ||
		!Number.isFinite(metrics.paddingTop ?? 0) ||
		(metrics.paddingTop ?? 0) < 0
	) {
		throw new RangeError("Stanza hit-test metrics are invalid");
	}
}
