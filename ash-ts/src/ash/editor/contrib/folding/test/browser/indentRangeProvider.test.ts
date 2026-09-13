import assert from "node:assert/strict";
import { test } from "mocha";
import { EditorFoldingRangeSource } from "../../browser/foldingRanges.js";
import { computeEditorIndentFoldingRanges } from "../../browser/indentRangeProvider.js";
import { TextModel } from "../../../../common/model/textModel.js";

test("Indent folding creates nested ranges and keeps blank lines in their parent body", () => {
	using model = new TextModel("root\n  child\n    body\n\n  sibling\nafter");
	assert.deepEqual(computeEditorIndentFoldingRanges(model), [{
		startLineIndex: 1,
		endLineIndex: 3,
		collapsed: false,
		source: EditorFoldingRangeSource.Provider,
	}, {
		startLineIndex: 0,
		endLineIndex: 4,
		collapsed: false,
		source: EditorFoldingRangeSource.Provider,
	}]);
});

test("Indent folding expands tabs and validates tab size", () => {
	using model = new TextModel("root\n\tchild\nlast");
	assert.deepEqual(computeEditorIndentFoldingRanges(model, { tabSize: 2 }), [{
		startLineIndex: 0,
		endLineIndex: 1,
		collapsed: false,
		source: EditorFoldingRangeSource.Provider,
	}]);
	assert.throws(() => computeEditorIndentFoldingRanges(model, { tabSize: 0 }));
});
