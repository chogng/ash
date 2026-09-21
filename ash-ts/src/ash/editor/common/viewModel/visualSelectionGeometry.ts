import { type Selection } from "../core/selection.js";
import { type TextModel } from "../model/textModel.js";
import { type EditorVisualLineProjection } from "./modelLineProjection.js";
import { type EditorLineRange, type TextMeasurer } from '../viewModel.js';

export interface VisualSelectionRectangle {
	readonly selectionIndex: number;
	readonly visualLineIndex: number;
	readonly left: number;
	readonly width: number;
}

export interface VisualCaretRectangle {
	readonly selectionIndex: number;
	readonly visualLineIndex: number;
	readonly left: number;
	readonly primary: boolean;
}

export interface VisualSelectionGeometry {
	readonly selections: readonly VisualSelectionRectangle[];
	readonly carets: readonly VisualCaretRectangle[];
}

/** @internal */
export function createStanzaVisualSelectionGeometry(model: TextModel, selectionSet: readonly Selection[], projection: EditorVisualLineProjection, renderLines: EditorLineRange, textLeft: number, measurer: TextMeasurer): VisualSelectionGeometry {
	if (projection.modelVersion !== model.version) {
		throw new Error("Visual selection geometry requires the current text model projection");
	}
	const carets: VisualCaretRectangle[] = [];
	for (let selectionIndex = 0; selectionIndex < selectionSet.length; selectionIndex += 1) {
		const selection = selectionSet[selectionIndex];
		if (!selection) continue;
		const visualLineIndex = projection.visualLineIndexAt(selection.getPosition());
		if (visualLineIndex < renderLines.startLineIndex || visualLineIndex >= renderLines.endLineIndexExclusive) continue;
		const visualLine = projection.lineAt(visualLineIndex)!;
		const text = model.getLineContent((visualLine.logicalLineIndex) + 1);
		carets.push(Object.freeze({
			selectionIndex,
			visualLineIndex,
			left: textLeft + (visualLine.wrappedTextIndentWidth ?? 0) + measurer.measureLineWidth(text.slice(visualLine.startColumn, selection.getPosition().column - 1)),
			primary: selectionIndex === 0,
		}));
	}
	const selections = selectionRectangles(model, selectionSet, projection, renderLines, textLeft, measurer);
	return Object.freeze({
		selections,
		carets: Object.freeze(carets),
	});
}

function selectionRectangles(model: TextModel, selections: readonly Selection[], projection: EditorVisualLineProjection, renderLines: EditorLineRange, textLeft: number, measurer: TextMeasurer): readonly VisualSelectionRectangle[] {
	const rectangles: VisualSelectionRectangle[] = [];
	const newlineWidth = measurer.measureLineWidth(" ");
	for (let selectionIndex = 0; selectionIndex < selections.length; selectionIndex += 1) {
		const range = selections[selectionIndex]!;
		if (range.isEmpty()) continue;
		for (let visualLineIndex = renderLines.startLineIndex; visualLineIndex < renderLines.endLineIndexExclusive; visualLineIndex += 1) {
			const visualLine = projection.lineAt(visualLineIndex);
			if (!visualLine || (visualLine.logicalLineIndex < range.startLineNumber - 1 || visualLine.logicalLineIndex > range.endLineNumber - 1)) continue;
			const logicalText = model.getLineContent((visualLine.logicalLineIndex) + 1);
			const startsOnLogicalLine = visualLine.logicalLineIndex === range.startLineNumber - 1;
			const endsOnLogicalLine = visualLine.logicalLineIndex === range.endLineNumber - 1;
			const startColumn = startsOnLogicalLine
				? Math.max(visualLine.startColumn, range.startColumn - 1)
				: visualLine.startColumn;
			const endColumn = endsOnLogicalLine
				? Math.min(visualLine.endColumn, range.endColumn - 1)
				: visualLine.endColumn;
			if (endColumn < startColumn) continue;
			if (endsOnLogicalLine && endColumn === 0 && !startsOnLogicalLine) continue;
			const indent = visualLine.wrappedTextIndentWidth ?? 0;
			const left = textLeft + indent + measurer.measureLineWidth(logicalText.slice(visualLine.startColumn, startColumn));
			let right = textLeft + indent + measurer.measureLineWidth(logicalText.slice(visualLine.startColumn, endColumn));
			if (!endsOnLogicalLine && visualLine.lastForLogicalLine) right += newlineWidth;
			if (right <= left) continue;
			rectangles.push(Object.freeze({
				selectionIndex,
				visualLineIndex,
				left,
				width: right - left,
			}));
		}
	}
	return Object.freeze(rectangles);
}
