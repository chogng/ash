import assert from "node:assert/strict";
import { test } from "mocha";
import { TEXT_FILE_TRANSFER_MAX_BYTES, selectTextFileTransfer, type TextFileTransfer } from "../../browser/textFileTransfer.js";

function file(name: string, type: string, size = 1): TextFileTransfer {
	return {
		name,
		type,
		size,
		text: async () => "text",
	};
}

test("Text file transfer accepts one bounded textual browser file", () => {
	const rust = file("snippet.rs", "");
	const plain = file("untitled", "text/plain");
	assert.equal(selectTextFileTransfer([rust]), rust);
	assert.equal(selectTextFileTransfer([plain]), plain);
});

test("Text file transfer leaves binary, unknown, multi-file, and oversized transfers to the host", () => {
	assert.equal(selectTextFileTransfer([file("image.png", "image/png")]), undefined);
	assert.equal(selectTextFileTransfer([file("unknown", "")]), undefined);
	assert.equal(selectTextFileTransfer([file("a.txt", "text/plain"), file("b.txt", "text/plain")]), undefined);
	assert.equal(selectTextFileTransfer([file("large.txt", "text/plain", TEXT_FILE_TRANSFER_MAX_BYTES + 1)]), undefined);
});
