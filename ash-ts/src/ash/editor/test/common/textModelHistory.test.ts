import assert from "node:assert/strict";
import { test } from "mocha";
import { Range } from "../../common/core/range.js";
import { Selection } from "../../common/core/selection.js";
import { TextModel } from "../../common/model/textModel.js";
import { UndoRedoGroup } from "../../../platform/undoRedo/common/undoRedo.js";

test("TextModel applyEdits bypasses history and returns identified inverse operations", () => {
	using model = new TextModel("abc");
	const identifier = { major: 7, minor: 3 };
	const inverse = model.applyEdits([{
		identifier,
		range: new Range(1, 2, 1, 3),
		text: "X",
		forceMoveMarkers: true,
		isAutoWhitespaceEdit: true,
		_isTracked: true,
	}], true);

	assert.equal(model.getText(), "aXc");
	assert.equal(model.canUndo(), false);
	assert.deepEqual(inverse.map(operation => ({
		identifier: operation.identifier,
		range: operation.range,
		text: operation.text,
	})), [{
		identifier,
		range: new Range(1, 2, 1, 3),
		text: "b",
	}]);

	model.applyEdits(inverse);
	assert.equal(model.getText(), "abc");
	assert.equal(model.canUndo(), false);
});

test("TextModel history restores cursor state through undo, redo, and cancellation", () => {
	using model = new TextModel("abc");
	const before = [new Selection(1, 2, 1, 2)];
	const after = [new Selection(1, 3, 1, 3)];
	const identifier = { major: 2, minor: 4 };
	const resulting = model.pushEditOperations(before, [{
		identifier,
		range: new Range(1, 2, 1, 2),
		text: "X",
	}], inverseOperations => {
		assert.deepEqual(inverseOperations.map(operation => operation.identifier), [identifier]);
		return after;
	});
	model.pushStackElement();

	assert.deepEqual(resulting, after);
	assert.equal(model.getText(), "aXbc");
	const undo = model.undo();
	assert.equal(model.getText(), "abc");
	assert.deepEqual(undo?.resultingSelection, before);
	const redo = model.redo();
	assert.equal(model.getText(), "aXbc");
	assert.deepEqual(redo?.resultingSelection, after);

	model.pushStackElement();
	const group = new UndoRedoGroup();
	const cancellationBefore = [new Selection(1, 1, 1, 1)];
	model.beginHistoryRevision(group);
	model.pushEditOperations(cancellationBefore, [{
		range: new Range(1, 1, 1, 1),
		text: "Y",
	}], () => [new Selection(1, 2, 1, 2)], group);
	const cancellation = model.cancelHistoryRevision(group);

	assert.equal(model.getText(), "aXbc");
	assert.deepEqual(cancellation?.resultingSelection, cancellationBefore);
});

test("TextModel pushStackElement and popStackElement control the current undo step", () => {
	using model = new TextModel("abcd");
	model.pushEditOperations(null, [{ range: new Range(1, 1, 1, 2), text: "A" }], () => null);
	model.pushStackElement();
	model.pushEditOperations(null, [{ range: new Range(1, 4, 1, 5), text: "D" }], () => null);
	model.popStackElement();
	model.pushEditOperations(null, [{ range: new Range(1, 2, 1, 3), text: "B" }], () => null);

	model.undo();
	assert.equal(model.getText(), "Abcd");
	model.undo();
	assert.equal(model.getText(), "abcd");
});

test("TextModel replays deterministic history across changing line maps", () => {
	using model = new TextModel("seed\ntext");
	const states = [model.getText()];
	const random = createRandom(0x5e7a);

	for (let index = 0; index < 200; index += 1) {
		const length = model.getText().length;
		const startOffset = Math.floor(random() * (length + 1));
		const deleteLength = index % 3 === 0 && startOffset < length
			? 1
			: 0;
		const insertedText = deleteLength > 0
			? ""
			: index % 5 === 0
				? `\r\n${index}`
				: String.fromCharCode(97 + index % 26);
		model.applyOperations([{
			range: Range.fromPositions(
				model.positionAt(startOffset),
				model.positionAt(startOffset + deleteLength),
			),
			text: insertedText,
		}]);
		states.push(model.getText());
	}

	for (let index = states.length - 2; index >= 0; index -= 1) {
		model.undo();
		assert.equal(model.getText(), states[index]);
	}
	for (let index = 1; index < states.length; index += 1) {
		model.redo();
		assert.equal(model.getText(), states[index]);
	}
});

test("TextModel keeps transaction identity across undo and redo", () => {
	using model = new TextModel("abc");
	const first = model.applyOperations([{
		range: Range.fromPositions(model.positionAt(0)),
		text: "X",
	}]);
	const second = model.applyOperations([{
		range: Range.fromPositions(model.positionAt(2)),
		text: "Y",
	}]);
	const undoSecond = model.undo();
	const undoFirst = model.undo();
	const redoFirst = model.redo();

	assert.deepEqual({
		first: first?.transactionId,
		second: second?.transactionId,
		undoSecond: undoSecond?.transactionId,
		undoFirst: undoFirst?.transactionId,
		redoFirst: redoFirst?.transactionId,
	}, {
		first: 1,
		second: 2,
		undoSecond: 2,
		undoFirst: 1,
		redoFirst: 1,
	});
});

function createRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}
