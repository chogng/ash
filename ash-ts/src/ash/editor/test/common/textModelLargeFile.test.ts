import assert from "node:assert/strict";
import { test } from "mocha";
import { classifyTextModelSize, TEXT_MODEL_LARGE_FILE_LIMITS } from "../../common/model/textModelLargeFile.js";
import { TextModel } from '../../common/model/textModel.js';

test("text model large-file policy follows the fixed editor limits", () => {
	assert.deepEqual(classifyTextModelSize(1, 1), {
		tooLargeForTokenization: false,
		tooLargeForSynchronization: false,
		tooLargeForHeapOperation: false,
	});
	assert.equal(classifyTextModelSize(TEXT_MODEL_LARGE_FILE_LIMITS.tokenizationTextUnits + 1, 1).tooLargeForTokenization, true);
	assert.equal(classifyTextModelSize(1, TEXT_MODEL_LARGE_FILE_LIMITS.tokenizationLineCount + 1).tooLargeForTokenization, true);
	assert.equal(classifyTextModelSize(TEXT_MODEL_LARGE_FILE_LIMITS.synchronizationTextUnits + 1, 1).tooLargeForSynchronization, true);
	assert.equal(classifyTextModelSize(TEXT_MODEL_LARGE_FILE_LIMITS.heapOperationTextUnits + 1, 1).tooLargeForHeapOperation, true);
});

test('text model large-file optimizations leave the synchronization limit in force', () => {
	assert.deepEqual(classifyTextModelSize(TEXT_MODEL_LARGE_FILE_LIMITS.heapOperationTextUnits + 1, 1, false), {
		tooLargeForTokenization: false,
		tooLargeForSynchronization: true,
		tooLargeForHeapOperation: false,
	});
	assert.equal(classifyTextModelSize(1, TEXT_MODEL_LARGE_FILE_LIMITS.tokenizationLineCount + 1, false).tooLargeForTokenization, false);
});

test("text model large-file policy validates dimensions", () => {
	assert.throws(() => classifyTextModelSize(-1, 1), /non-negative safe integer/);
	assert.throws(() => classifyTextModelSize(0, 0), /positive safe integer/);
});

test('TextModel bounds whole-document reads while keeping snapshots available', () => {
	class HeapLimitedTextModel extends TextModel {
		override isTooLargeForHeapOperation(): boolean { return true; }
	}
	using model = new HeapLimitedTextModel('alpha\nbeta');
	assert.throws(() => model.getValue(), /heap memory limits/);
	assert.throws(() => model.getLinesContent(), /heap memory limits/);
	assert.throws(() => model.getText(), /heap memory limits/);
	const snapshot = model.createSnapshot();
	assert.equal(snapshot.read(), 'alpha\nbeta');
});
