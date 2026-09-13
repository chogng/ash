import assert from "node:assert/strict";
import { test } from "mocha";
import { EditorFoldingModel } from "../../browser/foldingModel.js";
import { EditorFoldingRangeSource } from "../../browser/foldingRanges.js";
import { Position } from "../../../../common/core/position.js";
import { Range } from "../../../../common/core/range.js";
import { TextModel } from "../../../../common/model/textModel.js";

test("Folding model tracks line boundaries across edits and removes deleted ranges", () => {
	const model = new TextModel("before\nheader\nbody\nend\nafter");
	using folding = new EditorFoldingModel(model);
	folding.setRanges([{ startLineIndex: 1, endLineIndex: 3, collapsed: true }]);

	model.applyEdits([{ range: Range.fromPositions(new Position((0) + 1, (0) + 1)), text: "new\n" }]);
	assert.deepEqual(folding.regions, [{
		startLineIndex: 2,
		endLineIndex: 4,
		collapsed: true,
		source: EditorFoldingRangeSource.Provider,
	}]);

	model.applyEdits([{ range: Range.fromPositions(new Position((2) + 1, (0) + 1), new Position((5) + 1, (0) + 1)), text: "" }]);
	assert.deepEqual(folding.regions, []);
});

test("Folding model rejects crossing and single-line ranges", () => {
	const model = new TextModel("0\n1\n2\n3\n4");
	using folding = new EditorFoldingModel(model);
	assert.throws(() => folding.setRanges([{ startLineIndex: 0, endLineIndex: 3 }, { startLineIndex: 2, endLineIndex: 4 }]));
	assert.throws(() => folding.setRanges([{ startLineIndex: 1, endLineIndex: 1 }]));
});

test("Folding model retains matching provider collapse state while replacing provider ranges", () => {
	const model = new TextModel("header\nbody\nend");
	using folding = new EditorFoldingModel(model);
	folding.setRanges([{ startLineIndex: 0, endLineIndex: 2, collapsed: true }]);
	folding.setProviderRanges([{ startLineIndex: 0, endLineIndex: 2 }]);
	assert.equal(folding.regions[0]?.collapsed, true);
	assert.equal(folding.toggleContainingLine(1)?.collapsed, false);
});

test("Folding model recursively changes only the innermost containing hierarchy", () => {
	using model = new TextModel("outer\nchild\ngrandchild\nend child\nend outer\nunrelated\nbody");
	using folding = new EditorFoldingModel(model);
	folding.setRanges([
		{ startLineIndex: 0, endLineIndex: 4 },
		{ startLineIndex: 1, endLineIndex: 3 },
		{ startLineIndex: 2, endLineIndex: 3 },
		{ startLineIndex: 5, endLineIndex: 6 },
	]);

	assert.equal(folding.collapseContainingRegionRecursively(1)?.startLineIndex, 1);
	assert.deepEqual(folding.regions.map(region => region.collapsed), [false, true, true, false]);
	assert.equal(folding.expandContainingRegionRecursively(1)?.startLineIndex, 1);
	assert.deepEqual(folding.regions.map(region => region.collapsed), [false, false, false, false]);
	assert.equal(folding.collapseContainingRegionRecursively(6)?.startLineIndex, 5);
	assert.deepEqual(folding.regions.map(region => region.collapsed), [false, false, false, true]);
});

test("Manual folding ranges persist through provider replacement and reject crossing boundaries", () => {
	using model = new TextModel("outer\nmanual start\nbody\nmanual end\nend");
	using folding = new EditorFoldingModel(model);
	folding.setProviderRanges([{ startLineIndex: 0, endLineIndex: 4 }]);

	assert.equal(folding.addManualRange(1, 3)?.source, EditorFoldingRangeSource.Manual);
	assert.equal(folding.addManualRange(2, 4), undefined);
	folding.setProviderRanges([{ startLineIndex: 0, endLineIndex: 4 }]);
	assert.deepEqual(folding.regions.map(region => [region.startLineIndex, region.endLineIndex, region.source]), [
		[0, 4, EditorFoldingRangeSource.Provider],
		[1, 3, EditorFoldingRangeSource.Manual],
	]);
	assert.equal(folding.removeContainingManualRange(2)?.startLineIndex, 1);
	assert.equal(folding.regions.length, 1);
});

test("Folding levels retain shallower headers and collapse nested descendants", () => {
	using model = new TextModel("outer\nchild\ngrandchild\nend grandchild\nend child\nend outer\nother\nbody");
	using folding = new EditorFoldingModel(model);
	folding.setRanges([
		{ startLineIndex: 0, endLineIndex: 5 },
		{ startLineIndex: 1, endLineIndex: 4 },
		{ startLineIndex: 2, endLineIndex: 3 },
		{ startLineIndex: 6, endLineIndex: 7 },
	]);

	assert.equal(folding.collapseToLevel(2), true);
	assert.deepEqual(folding.regions.map(region => region.collapsed), [false, true, true, false]);
	assert.equal(folding.collapseToLevel(1), true);
	assert.deepEqual(folding.regions.map(region => region.collapsed), [true, true, true, true]);
	assert.throws(() => folding.collapseToLevel(0), /positive safe integer/);
});
