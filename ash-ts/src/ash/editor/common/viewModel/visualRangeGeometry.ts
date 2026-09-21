import { type Range } from "../core/range.js";
import { type TextModel } from "../model/textModel.js";
import { type EditorVisualLineProjection } from "./modelLineProjection.js";
import { type EditorLineRange, type TextMeasurer } from '../viewModel.js';

enum EmptyRangeRendering {
	Ignore = "ignore",
	RenderAsSpace = "render-as-space",
}

export interface VisualRangeGeometryEntry<T> {
	readonly range: Range;
	readonly value: T;
}

export interface VisualRangeRectangle<T> {
	readonly value: T;
	readonly visualLineIndex: number;
	readonly left: number;
	readonly width: number;
}

/** @internal */
export function createStanzaVisualRangeRectangles<T>(model: TextModel, entries: readonly VisualRangeGeometryEntry<T>[], projection: EditorVisualLineProjection, renderLines: EditorLineRange, textLeft: number, measurer: TextMeasurer, emptyRangeRendering = EmptyRangeRendering.Ignore): readonly VisualRangeRectangle<T>[] {
	if (projection.modelVersion !== model.version) {
		throw new Error("Visual range geometry requires the current text model projection");
	}
	const rectangles: VisualRangeRectangle<T>[] = [];
	const newlineWidth = measurer.measureLineWidth(" ");
	for (const entry of entries) {
		if (entry.range.isEmpty() && emptyRangeRendering === EmptyRangeRendering.RenderAsSpace) {
			const visualLineIndex = projection.visualLineIndexAt(entry.range.getStartPosition());
			const visualLine = projection.lineAt(visualLineIndex);
			if (!visualLine || visualLineIndex < renderLines.startLineIndex || visualLineIndex >= renderLines.endLineIndexExclusive) continue;
			const logicalText = model.getLineContent((visualLine.logicalLineIndex) + 1);
			rectangles.push(Object.freeze({
				value: entry.value,
				visualLineIndex,
				left: textLeft + (visualLine.wrappedTextIndentWidth ?? 0) + measurer.measureLineWidth(logicalText.slice(visualLine.startColumn, entry.range.startColumn - 1)),
				width: Math.max(1, newlineWidth),
			}));
			continue;
		}
		if (entry.range.isEmpty()) continue;
		for (let visualLineIndex = renderLines.startLineIndex; visualLineIndex < renderLines.endLineIndexExclusive; visualLineIndex += 1) {
			const visualLine = projection.lineAt(visualLineIndex);
			if (!visualLine || !intersectsLogicalLine(entry.range, visualLine.logicalLineIndex)) continue;
			const logicalText = model.getLineContent((visualLine.logicalLineIndex) + 1);
			const startsOnLogicalLine = visualLine.logicalLineIndex === entry.range.startLineNumber - 1;
			const endsOnLogicalLine = visualLine.logicalLineIndex === entry.range.endLineNumber - 1;
			const startColumn = startsOnLogicalLine
				? Math.max(visualLine.startColumn, entry.range.startColumn - 1)
				: visualLine.startColumn;
			const endColumn = endsOnLogicalLine
				? Math.min(visualLine.endColumn, entry.range.endColumn - 1)
				: visualLine.endColumn;
			if (endColumn < startColumn) continue;
			if (endsOnLogicalLine && endColumn === 0 && !startsOnLogicalLine) continue;
			const indent = visualLine.wrappedTextIndentWidth ?? 0;
			const left = textLeft + indent + measurer.measureLineWidth(logicalText.slice(visualLine.startColumn, startColumn));
			let right = textLeft + indent + measurer.measureLineWidth(logicalText.slice(visualLine.startColumn, endColumn));
			if (!endsOnLogicalLine && visualLine.lastForLogicalLine) right += newlineWidth;
			if (right <= left) continue;
			rectangles.push(Object.freeze({
				value: entry.value,
				visualLineIndex,
				left,
				width: right - left,
			}));
		}
	}
	return Object.freeze(rectangles);
}

function intersectsLogicalLine(range: Range, lineIndex: number): boolean {
	return lineIndex >= range.startLineNumber - 1 && lineIndex <= range.endLineNumber - 1;
}
