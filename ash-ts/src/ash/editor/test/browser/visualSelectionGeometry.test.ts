import assert from "node:assert/strict";
import { test } from "mocha";
import { Selection } from "../../common/core/selection.js";
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import { TextModel } from "../../common/model/textModel.js";
import { EditorVisualLineProjection } from "../../common/viewModel/modelLineProjection.js";
import { createStanzaVisualRangeRectangles } from "../../common/viewModel/visualRangeGeometry.js";
import { createStanzaVisualSelectionGeometry } from "../../common/viewModel/visualSelectionGeometry.js";
import { type TextMeasurer } from '../../common/viewModel.js';

test("visual selection geometry splits one logical range across wrapped fragments", () => {
	using model = new TextModel("abcdef\ngh");
	const projection = EditorVisualLineProjection.fromBreakColumns(model, [[2, 4, 6], [2]]);
	const selections = [Selection.fromPositions(new Position((0) + 1, (1) + 1), new Position((1) + 1, (1) + 1))];
	const geometry = createStanzaVisualSelectionGeometry(model, selections, projection, {
		startLineIndex: 0,
		endLineIndexExclusive: 4,
	}, 10, new FixedTextMeasurer());

	assert.deepEqual(geometry.selections, [
		{ selectionIndex: 0, visualLineIndex: 0, left: 20, width: 10 },
		{ selectionIndex: 0, visualLineIndex: 1, left: 10, width: 20 },
		{ selectionIndex: 0, visualLineIndex: 2, left: 10, width: 30 },
		{ selectionIndex: 0, visualLineIndex: 3, left: 10, width: 10 },
	]);
	assert.deepEqual(geometry.carets, [{
		selectionIndex: 0,
		visualLineIndex: 3,
		left: 20,
		primary: true,
	}]);
});

test("visual selection geometry offsets continuation rows by their wrapping indent", () => {
	using model = new TextModel("abcdef");
	const projection = EditorVisualLineProjection.fromBreakColumns(model, [[2, 4, 6]], [20]);
	const selections = [Selection.fromPositions(new Position((0) + 1, (4) + 1), new Position((0) + 1, (2) + 1))];
	const geometry = createStanzaVisualSelectionGeometry(model, selections, projection, {
		startLineIndex: 0,
		endLineIndexExclusive: 3,
	}, 10, new FixedTextMeasurer());

	assert.deepEqual(geometry.selections, [{
		selectionIndex: 0,
		visualLineIndex: 1,
		left: 30,
		width: 20,
	}]);
	assert.deepEqual(geometry.carets, [{
		selectionIndex: 0,
		visualLineIndex: 1,
		left: 30,
		primary: true,
	}]);
});

test("visual range geometry rejects a projection from another model version", () => {
	using model = new TextModel("abc");
	const projection = EditorVisualLineProjection.fromBreakColumns(model, [[3]]);
	model.applyEdits([{ range: Range.fromPositions(new Position((0) + 1, (3) + 1)), text: "d" }]);
	assert.throws(() => createStanzaVisualRangeRectangles(model, [{
		range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (1) + 1)),
		value: undefined,
	}], projection, { startLineIndex: 0, endLineIndexExclusive: 1 }, 0, new FixedTextMeasurer()), /current text model projection/);
});

class FixedTextMeasurer implements TextMeasurer {
	readonly horizontalPadding = 0;
	readonly contentLeftPadding = 0;

	refresh(): boolean {
		return false;
	}

	measureLineWidth(text: string): number {
		return text.length * 10;
	}
}
