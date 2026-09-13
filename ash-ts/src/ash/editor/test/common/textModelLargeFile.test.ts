import assert from "node:assert/strict";
import { test } from "mocha";
import { classifyTextModelSize, TEXT_MODEL_LARGE_FILE_LIMITS } from "../../common/model/textModelLargeFile.js";

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

test("text model large-file policy validates dimensions", () => {
	assert.throws(() => classifyTextModelSize(-1, 1), /non-negative safe integer/);
	assert.throws(() => classifyTextModelSize(0, 0), /positive safe integer/);
});
