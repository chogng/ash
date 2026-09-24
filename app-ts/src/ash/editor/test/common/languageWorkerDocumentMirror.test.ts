import { strict as assert } from "node:assert";
import { test } from "mocha";
import { LanguageWorkerDocumentMirror } from '../../common/services/textModelSync/textModelSync.impl.js';
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import type { TextModelChange } from '../../common/core/textChange.js';
import type { IIdentifiedSingleEditOperation } from '../../common/model.js';
import { TextModel } from "../../common/model/textModel.js";
import { EndOfLineSequence } from '../../common/model.js';

test("Worker document mirror applies model transactions through its Piece Tree", () => {
	using model = new TextModel("abc\ndef");
	const mirror = new LanguageWorkerDocumentMirror(model.createVersionedSnapshot());
	const captured = mirror.createSnapshot();
	const change = pushEdits(model, [
		{
			range: Range.fromPositions(new Position((0) + 1, (1) + 1), new Position((0) + 1, (2) + 1)),
			text: "XYZ",
		},
		{
			range: Range.fromPositions(new Position((1) + 1, (3) + 1)),
			text: "\nlast",
		},
	])!;

	mirror.synchronize(change.version - 1, change.version, change.changes);

	const current = mirror.createSnapshot();
	assert.equal(current.version, model.version);
	assert.equal(current.getText(), model.getText());
	assert.equal(current.length, model.getText().length);
	assert.equal(current.lineCount, model.lineCount);
	assert.equal(captured.version, 1);
	assert.equal(captured.getText(), "abc\ndef");

	const undo = model.undo()!;
	mirror.synchronize(undo.version - 1, undo.version, undo.changes);
	assert.equal(mirror.createSnapshot().getText(), "abc\ndef");
});

function pushEdits(model: TextModel, edits: IIdentifiedSingleEditOperation[]): TextModelChange | undefined {
	let change: TextModelChange | undefined;
	const listener = model.onDidChangeContent(event => {
		change = event;
	});
	try {
		model.pushEditOperations(null, edits, () => null);
	} finally {
		listener.dispose();
	}
	return change;
}

test("Worker document mirror rejects invalid synchronization atomically", () => {
	using model = new TextModel("value");
	const mirror = new LanguageWorkerDocumentMirror(model.createVersionedSnapshot());

	assert.throws(() => mirror.synchronize(2, 3, [{
		rangeOffset: 0,
		rangeLength: 1,
		text: "V",
	}]), /version does not follow/);
	assert.throws(() => mirror.synchronize(1, 2, [{
		rangeOffset: 99,
		rangeLength: 0,
		text: "!",
	}]), /inside the mirror/);
	assert.equal(mirror.version, 1);
	assert.equal(mirror.createSnapshot().getText(), "value");
});

test('Worker document mirror synchronizes CRLF and EOL-only model versions', () => {
	using model = new TextModel('first\r\nsecond');
	const mirror = new LanguageWorkerDocumentMirror(model.createVersionedSnapshot());
	assert.equal(mirror.createSnapshot().getText(), 'first\r\nsecond');

	model.setEOL(EndOfLineSequence.LF);
	const lfChange = model.getVersionId();
	mirror.synchronize(lfChange - 1, lfChange, [], model.getEOL() as '\n');
	assert.equal(mirror.createSnapshot().getText(), 'first\nsecond');

	model.pushEOL(EndOfLineSequence.CRLF);
	const crlfChange = model.getVersionId();
	mirror.synchronize(crlfChange - 1, crlfChange, [], model.getEOL() as '\r\n');
	assert.equal(mirror.createSnapshot().getText(), model.getText());
});
