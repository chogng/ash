import assert from "node:assert/strict";
import { test } from "mocha";
import { LocalSelectionTransfer } from "../../browser/dnd.js";

test("LocalSelectionTransfer isolates one renderer drag payload by token", () => {
	const transfer = LocalSelectionTransfer.getInstance<string>();
	const editorToken = {};
	const terminalToken = {};
	transfer.setData(["editor"], editorToken);

	assert.equal(transfer.hasData(editorToken), true);
	assert.deepEqual(transfer.getData(editorToken), ["editor"]);
	assert.equal(transfer.hasData(terminalToken), false);
	assert.equal(transfer.getData(terminalToken), undefined);

	transfer.clearData(terminalToken);
	assert.deepEqual(transfer.getData(editorToken), ["editor"]);
	transfer.clearData(editorToken);
	assert.equal(transfer.getData(editorToken), undefined);
});
