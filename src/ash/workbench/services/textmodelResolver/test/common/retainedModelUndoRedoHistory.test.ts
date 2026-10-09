import { toDisposable } from '../../../../../base/common/lifecycle.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { URI } from "../../../../../base/common/uri.js";
import { UndoRedoGroup } from "../../../../../platform/undoRedo/common/undoRedo.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { TextModel } from "../../../../../editor/common/model/textModel.js";
import { RetainedModelUndoRedoHistory } from "../../common/retainedModelUndoRedoHistory.js";

test("RetainedModelUndoRedoHistory retains only the configured number of model histories", () => {
	using participant = new RetainedModelUndoRedoHistory({ maxEntries: 1 });
	const firstResource = URI.file("C:\\project\\first.ts");
	const secondResource = URI.file("C:\\project\\second.ts");
	using first = editedModel("first");
	using second = editedModel("second");
	participant.remember(firstResource, first);
	participant.remember(secondResource, second);

	using reopenedFirst = new TextModel(first.getText());
	using reopenedSecond = new TextModel(second.getText());
	assert.equal(participant.restore(firstResource, reopenedFirst), false);
	assert.equal(participant.restore(secondResource, reopenedSecond), true);
	assert.equal(reopenedSecond.canUndo(), true);
});

test("RetainedModelUndoRedoHistory does not capture an unfinished history revision", () => {
	using participant = new RetainedModelUndoRedoHistory();
	const resource = URI.file("C:\\project\\revision.ts");
	using model = new TextModel("revision");
	const group = new UndoRedoGroup();
	model.beginHistoryRevision(group);
	model.pushEditOperations(
		null,
		[{ range: Range.fromPositions(model.positionAt(model.length)), text: "!" }],
		() => null,
		group,
	);
	participant.remember(resource, model);
	assert.equal(model.finishHistoryRevision(group), true);

	using reopened = new TextModel(model.getText());
	assert.equal(participant.restore(resource, reopened), false);
	assert.equal(reopened.canUndo(), false);
});

function editedModel(text: string): TextModel {
	const model = new TextModel(text);
	model.pushEditOperations(null, [{ range: Range.fromPositions(model.positionAt(model.length)), text: "!" }], () => null);
	return model;
}


test('retained histories release identity references on eviction, restoration, forgetting and disposal', () => {
	let retained = 0;
	using histories = new RetainedModelUndoRedoHistory({ maxEntries: 1 }, resource => resource.toString(), () => {
		retained++;
		return toDisposable(() => { retained--; });
	});
	const firstResource = URI.file('/workspace/first');
	const secondResource = URI.file('/workspace/second');
	using first = editedModel('first');
	using second = editedModel('second');
	histories.remember(firstResource, first);
	histories.remember(secondResource, second);
	assert.equal(retained, 1);
	using reopened = new TextModel(second.getText());
	assert.equal(histories.restore(secondResource, reopened), true);
	assert.equal(retained, 0);
	histories.remember(firstResource, first);
	histories.forget(firstResource);
	assert.equal(retained, 0);
	histories.remember(secondResource, second);
	histories.dispose();
	assert.equal(retained, 0);
});
