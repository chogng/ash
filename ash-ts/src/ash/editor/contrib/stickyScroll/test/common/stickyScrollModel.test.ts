import assert from "node:assert/strict";
import { test } from "mocha";
import { buildStickyScrollEntries } from "../../common/stickyScrollModel.js";
import { TextModel } from "../../../../common/model/textModel.js";

test("Sticky scroll returns active folding ancestors in nesting order", () => {
	using model = new TextModel("outer\ninner\nbody\nend\nout");
	assert.deepEqual(buildStickyScrollEntries(model, 2, [{ startLineIndex: 0, endLineIndex: 3 }, { startLineIndex: 1, endLineIndex: 2 }]).map(entry => entry.lineIndex), [0, 1]);
});
