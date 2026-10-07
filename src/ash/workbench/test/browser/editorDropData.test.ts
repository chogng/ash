import { URI } from '../../../base/common/uri.js';
import { isWindows } from '../../../base/common/platform.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { extractExternalEditorInputs } from "../../browser/parts/editor/editorDropData.js";

test("external editor drop data preserves URIs and snapshots browser files", async () => {
	const dataTransfer = {
		getData: (type: string) => type === "text/uri-list" ? "# resources\nfile:///C:/project/main.ts\n" : "",
		files: [{ name: "notes.txt", type: "text/plain", text: async () => "dropped notes" }],
	} as unknown as DataTransfer;

	const inputs = await extractExternalEditorInputs(dataTransfer);

	assert.equal(inputs.length, 2);
	assert.equal(inputs[0]?.resource.toString(), "file:///C:/project/main.ts");
	assert.equal(inputs[1]?.resource.scheme, "untitled");
	assert.equal(inputs[1]?.label, "notes.txt");
	assert.equal(inputs[1]?.contentType, "text/plain");
	assert.equal(inputs[1]?.initialText, "dropped notes");
});

test("external editor drop data keeps host file paths loadable", async () => {
	const path = isWindows ? "C:\\project\\dropped.ts" : "/project/dropped.ts";
	const dataTransfer = {
		getData: () => "",
		files: [{ name: "dropped.ts", type: "text/typescript", path, text: async () => "unused" }],
	} as unknown as DataTransfer;

	const [input] = await extractExternalEditorInputs(dataTransfer);

	assert.equal(input?.resource.toString(), URI.file(path).toString());
	assert.equal(input?.initialText, undefined);
});
