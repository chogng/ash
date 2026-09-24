import assert from "node:assert/strict";
import { test } from "mocha";
import { TextDecorationChangeReason, TextDecorationCollection } from "../../common/model/decorationCollection.js";
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import { TextModel } from "../../common/model/textModel.js";
import { TrackedRangeStickiness } from '../../common/model.js';


const position = (lineIndex: number, columnIndex: number): Position => new Position(lineIndex + 1, columnIndex + 1);
const range = (
	startColumn: number,
	endColumn: number,
): Range => Range.fromPositions(
	position(0, startColumn),
	position(0, endColumn),
);

test("TextDecorationCollection owns stable IDs and opaque metadata", () => {
	using model = new TextModel("abcdef");
	using decorations =
		new TextDecorationCollection<{ readonly kind: string }>(model);
	const reasons: TextDecorationChangeReason[] = [];
	using listener = decorations.onDidChange(
		event => reasons.push(event.reason),
	);
	assert.equal(decorations.textModel, model);

	const id = decorations.add({
		range: range(1, 3),
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		metadata: { kind: "search" },
	});
	decorations.update(id, {
		range: range(2, 5),
		stickiness: TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges,
		metadata: { kind: "diagnostic" },
	});
	const updated = decorations.get(id);
	const snapshot = decorations.decorations;
	const deleted = decorations.delete(id);

	assert.deepEqual({
		id,
		updated,
		snapshot,
		snapshotFrozen: Object.isFrozen(snapshot),
		entryFrozen: Object.isFrozen(snapshot[0]),
		deleted,
		missing: decorations.get(id),
		reasons,
	}, {
		id,
		updated: {
			id,
			range: range(2, 5),
			metadata: { kind: "diagnostic" },
		},
		snapshot: [{
			id,
			range: range(2, 5),
			metadata: { kind: "diagnostic" },
		}],
		snapshotFrozen: true,
		entryFrozen: true,
		deleted: true,
		missing: undefined,
		reasons: [
			TextDecorationChangeReason.Content,
			TextDecorationChangeReason.Content,
			TextDecorationChangeReason.Content,
		],
	});
});

test("TextDecorationCollection reports tracked range movement", () => {
	using model = new TextModel("abc");
	using decorations = new TextDecorationCollection<string>(model);
	const id = decorations.add({
		range: range(1, 2),
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		metadata: "match",
	});
	const events: unknown[] = [];
	using listener = decorations.onDidChange(event => events.push(event));

	model.applyOperations([{ range: range(0, 0), text: "X" }]);
	model.undo();

	assert.deepEqual(events, [
		{
			reason: TextDecorationChangeReason.Range,
			modelVersion: 2,
			decorations: [{
				id,
				range: range(2, 3),
				metadata: "match",
			}],
		},
		{
			reason: TextDecorationChangeReason.Range,
			modelVersion: 3,
			decorations: [{
				id,
				range: range(1, 2),
				metadata: "match",
			}],
		},
	]);
});

test("TextDecorationCollection exposes tracked ranges before change listeners finish", () => {
	using model = new TextModel("abc");
	let decorations: TextDecorationCollection<string>;
	let observedRange: Range | undefined;
	using earlyListener = model.onDidChangeContent(() => {
		observedRange = decorations.decorations[0]?.range;
	});
	decorations = new TextDecorationCollection<string>(model);
	using ownedDecorations = decorations;
	decorations.add({
		range: range(1, 2),
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		metadata: "match",
	});

	model.applyOperations([{ range: range(0, 0), text: "X" }]);

	assert.deepEqual(observedRange, range(2, 3));
});

test("TextDecorationCollection validates replaceAll atomically", () => {
	using model = new TextModel("abc");
	using decorations = new TextDecorationCollection<string>(model);
	const originalId = decorations.add({
		range: range(0, 1),
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		metadata: "original",
	});
	let eventCount = 0;
	using listener = decorations.onDidChange(() => eventCount += 1);

	assert.throws(() => decorations.replaceAll([
		{
			range: range(1, 2),
			stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			metadata: "valid",
		},
		{
			range: Range.fromPositions(position(2, 0)),
			stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			metadata: "invalid",
		},
	]), /lineNumber/);
	assert.deepEqual(decorations.decorations, [{
		id: originalId,
		range: range(0, 1),
		metadata: "original",
	}]);
	assert.equal(eventCount, 0);

	const ids = decorations.replaceAll([
		{
			range: range(0, 1),
			stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			metadata: "first",
		},
		{
			range: range(2, 3),
			stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			metadata: "second",
		},
	]);
	assert.deepEqual({
		idCount: ids.length,
		uniqueIds: new Set(ids).size,
		replacedOriginal: ids.includes(originalId),
		size: decorations.size,
		eventCount,
	}, {
		idCount: 2,
		uniqueIds: 2,
		replacedOriginal: true,
		size: 2,
		eventCount: 1,
	});
});

test("TextDecorationCollection applies a delta in one event and retains reusable IDs", () => {
	using model = new TextModel("abc");
	using decorations = new TextDecorationCollection<string>(model);
	const first = decorations.add({ range: range(0, 1), stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges, metadata: "first" });
	const second = decorations.add({ range: range(1, 2), stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges, metadata: "second" });
	let eventCount = 0;
	using listener = decorations.onDidChange(() => eventCount += 1);

	const ids = decorations.deltaDecorations([first, second], [{
		range: range(2, 3),
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		metadata: "updated",
	}]);

	assert.deepEqual(ids, [first]);
	assert.deepEqual(decorations.decorations, [{ id: first, range: range(2, 3), metadata: "updated" }]);
	assert.equal(eventCount, 1);
});

test("Decoration owners remain independent over a shared model", () => {
	using model = new TextModel("abc");
	using diagnostics =
		new TextDecorationCollection<{ readonly severity: number }>(model);
	using search = new TextDecorationCollection<string>(model);
	const diagnosticId = diagnostics.add({
		range: range(0, 1),
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		metadata: { severity: 2 },
	});
	const searchId = search.add({
		range: range(2, 3),
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		metadata: "result",
	});

	diagnostics.delete(diagnosticId);

	assert.deepEqual({
		diagnostics: diagnostics.decorations,
		search: search.decorations,
	}, {
		diagnostics: [],
		search: [{
			id: searchId,
			range: range(2, 3),
			metadata: "result",
		}],
	});
});

test("TextDecorationCollection disposal does not own the model", () => {
	using model = new TextModel("abc");
	const decorations = new TextDecorationCollection<string>(model);
	decorations.add({
		range: range(0, 1),
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		metadata: "owned",
	});
	decorations.dispose();

	assert.throws(() => decorations.decorations, /already disposed/);
	model.applyEdits([{ range: range(0, 1), text: "A" }]);
	assert.equal(model.getText(), "Abc");
});
