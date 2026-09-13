import assert from "node:assert/strict";
import { test } from "mocha";
import { toDisposable } from "../../../base/common/lifecycle.js";
import { Range } from "../../common/core/range.js";
import { TextModel } from "../../common/model/textModel.js";

test("TextModel snapshots remain immutable across edits and disposal", () => {
	const model = new TextModel("alpha\nbeta");
	const snapshot = model.createVersionedSnapshot();

	model.applyOperations([{
		range: Range.fromPositions(model.positionAt(0), model.positionAt(5)),
		text: "ALPHA",
	}]);
	model.undo();
	model.dispose();

	assert.deepEqual({
		frozen: Object.isFrozen(snapshot),
		version: snapshot.version,
		length: snapshot.length,
		lineCount: snapshot.lineCount,
		text: snapshot.getText(),
		range: snapshot.getTextBetweenOffsets(2, 8),
	}, {
		frozen: true,
		version: 1,
		length: 10,
		lineCount: 2,
		text: "alpha\nbeta",
		range: "pha\nbe",
	});
	assert.throws(
		() => snapshot.getTextBetweenOffsets(-1, 2),
		/Offsets must satisfy/,
	);
});

test("TextModel bounds history by transaction count", () => {
	using model = new TextModel("", {
		historyLimit: {
			transactions: 2,
			textUnits: 100,
		},
	});

	for (const character of "abc") {
		const end = model.positionAt(model.getText().length);
		model.applyOperations([{
			range: Range.fromPositions(end),
			text: character,
		}]);
	}

	model.undo();
	model.undo();
	assert.deepEqual({
		text: model.getText(),
		canUndo: model.canUndo(),
		canRedo: model.canRedo(),
	}, {
		text: "a",
		canUndo: false,
		canRedo: true,
	});

	model.redo();
	model.redo();
	assert.equal(model.getText(), "abc");
});

test("TextModel drops history that exceeds the text-unit budget", () => {
	using replacement = new TextModel("abcdef", {
		historyLimit: {
			transactions: 10,
			textUnits: 3,
		},
	});
	replacement.applyOperations([{
		range: Range.fromPositions(
			replacement.positionAt(0),
			replacement.positionAt(6),
		),
		text: "x",
	}]);
	assert.deepEqual({
		text: replacement.getText(),
		canUndo: replacement.canUndo(),
	}, {
		text: "x",
		canUndo: false,
	});

	using insertion = new TextModel("", {
		historyLimit: {
			transactions: 10,
			textUnits: 3,
		},
	});
	insertion.applyOperations([{
		range: Range.fromPositions(insertion.positionAt(0)),
		text: "abcdef",
	}]);
	assert.equal(insertion.canUndo(), true);
	insertion.undo();
	assert.deepEqual({
		text: insertion.getText(),
		canRedo: insertion.canRedo(),
	}, {
		text: "",
		canRedo: false,
	});
});

test("TextModel validates explicit history limits", () => {
	assert.throws(
		() => new TextModel("", {
			historyLimit: {
				transactions: -1,
			},
		}),
		/historyLimit.transactions/,
	);
	assert.throws(
		() => new TextModel("", {
			historyLimit: {
				textUnits: Number.POSITIVE_INFINITY,
			},
		}),
		/historyLimit.textUnits/,
	);
});

test("TextModel compaction remains transparent to snapshots and history", () => {
	using model = new TextModel("");
	let eventCount = 0;
	using listener = model.onDidChangeContent(() => eventCount += 1);
	const insertedText = "0123456789".repeat(10_000);
	const retainedText = insertedText.slice(-10_000);

	model.applyOperations([{
		range: Range.fromPositions(model.positionAt(0)),
		text: insertedText,
	}]);
	const snapshot = model.createVersionedSnapshot();
	model.applyOperations([{
		range: Range.fromPositions(
			model.positionAt(0),
			model.positionAt(insertedText.length - retainedText.length),
		),
		text: "",
	}]);

	assert.equal(model.getText(), retainedText);
	model.undo();
	assert.equal(model.getText(), insertedText);
	model.redo();
	assert.deepEqual({
		text: model.getText(),
		version: model.version,
		eventCount,
		snapshotVersion: snapshot.version,
		snapshotText: snapshot.getText(),
	}, {
		text: retainedText,
		version: 5,
		eventCount: 4,
		snapshotVersion: 2,
		snapshotText: insertedText,
	});
});

test("TextModel defers reclaiming piece-tree storage through product-owned maintenance", () => {
	const scheduled: (() => void)[] = [];
	const model = new TextModel("", {
		maintenance: {
			schedule: callback => {
				scheduled.push(callback);
				return toDisposable(() => {
					const index = scheduled.indexOf(callback);
					if (index >= 0) scheduled.splice(index, 1);
				});
			},
		},
	});
	const insertedText = "0123456789".repeat(10_000);
	const retainedText = insertedText.slice(-10_000);
	model.applyOperations([{
		range: Range.fromPositions(model.positionAt(0)),
		text: insertedText,
	}]);
	const snapshot = model.createVersionedSnapshot();
	model.applyOperations([{
		range: Range.fromPositions(model.positionAt(0), model.positionAt(insertedText.length - retainedText.length)),
		text: "",
	}]);

	assert.equal(scheduled.length, 1);
	assert.equal(model.getText(), retainedText);
	assert.equal(snapshot.getText(), insertedText);
	const maintenance = scheduled.shift();
	assert.ok(maintenance);
	maintenance();
	assert.equal(model.getText(), retainedText);
	model.undo();
	assert.equal(model.getText(), insertedText);
	model.dispose();
});

test("TextModel cancels queued maintenance when disposed", () => {
	const scheduled: (() => void)[] = [];
	const model = new TextModel("", {
		maintenance: {
			schedule: callback => {
				scheduled.push(callback);
				return toDisposable(() => {
					const index = scheduled.indexOf(callback);
					if (index >= 0) scheduled.splice(index, 1);
				});
			},
		},
	});
	const insertedText = "0123456789".repeat(10_000);
	model.applyOperations([{ range: Range.fromPositions(model.positionAt(0)), text: insertedText }]);
	model.applyOperations([{
		range: Range.fromPositions(model.positionAt(0), model.positionAt(90_000)),
		text: "",
	}]);

	assert.equal(scheduled.length, 1);
	model.dispose();
	assert.equal(scheduled.length, 0);
});
