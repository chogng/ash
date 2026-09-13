import assert from "node:assert/strict";
import { test } from "mocha";
import { EditorFoldingModel } from "../../browser/foldingModel.js";
import { EditorFoldingRangeSource } from "../../browser/foldingRanges.js";
import { EditorHiddenRangeModel } from "../../browser/hiddenRangeModel.js";
import { TextModel } from "../../../../common/model/textModel.js";

test("Hidden range model derives visible lines from collapsed folding regions", () => {
	const model = new TextModel("outer\ninner\nbody\nend\nlast");
	using folding = new EditorFoldingModel(model);
	using hidden = new EditorHiddenRangeModel(model, folding);
	folding.setRanges([
		{ startLineIndex: 0, endLineIndex: 3, collapsed: true },
		{ startLineIndex: 1, endLineIndex: 2, source: EditorFoldingRangeSource.Manual },
	]);

	assert.deepEqual(hidden.getVisibleLineIndexes(), [0, 4]);
	assert.equal(hidden.isLineHidden(0), false);
	assert.equal(hidden.isLineHidden(1), true);
	assert.equal(folding.toggleAtLine(1)?.collapsed, true);
	assert.equal(folding.regions[1]?.collapsed, true);
	assert.equal(folding.toggleAtLine(4), undefined);
	assert.equal(folding.setAllCollapsed(false), true);
	assert.deepEqual(hidden.getVisibleLineIndexes(), [0, 1, 2, 3, 4]);
});
