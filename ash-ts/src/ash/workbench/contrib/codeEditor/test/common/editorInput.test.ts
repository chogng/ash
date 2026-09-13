import assert from "node:assert/strict";
import { test } from "mocha";
import { URI } from "../../../../../base/common/uri.js";
import { ACADEMIC_DOCUMENT_CONTENT_TYPE } from "../../../../services/documentEditor/common/documentTypes.js";
import { EditorPaneMatch } from "../../../../browser/parts/editor/editorPane.js";
import { CODE_EDITOR_ID, languageForEditorInput, matchCodeEditor } from "../../browser/codeEditorInput.js";
import { DIFF_EDITOR_ID, createDiffEditorInput, matchDiffEditor } from "../../browser/diffEditorInput.js";

test("Stanza is the default text editor with canonical language IDs", () => {
	assert.equal(CODE_EDITOR_ID, "stanza.editor.code");
	assert.equal(matchCodeEditor({ resource: URI.file("C:\\project\\view.tsx") }), EditorPaneMatch.Default);
	assert.equal(languageForEditorInput({ resource: URI.file("C:\\project\\view.tsx") }), "typescriptreact");
	assert.equal(languageForEditorInput({ resource: URI.file("C:\\project\\settings.jsonc") }), "jsonc");
	assert.equal(matchCodeEditor({ resource: URI.parse("untitled:/Untitled-1") }), EditorPaneMatch.Default);
	assert.equal(languageForEditorInput({ resource: URI.parse("untitled:/Untitled-1"), languageId: "typescript" }), "typescript");
	assert.equal(matchCodeEditor({ resource: URI.file("C:\\project\\script") }), EditorPaneMatch.Optional);
	assert.equal(matchCodeEditor({ resource: URI.file("C:\\project\\script.cgi") }), EditorPaneMatch.Optional);
	assert.equal(matchCodeEditor({ resource: URI.file("C:\\project\\.env") }), EditorPaneMatch.Optional);
	assert.equal(matchCodeEditor({ resource: URI.file("C:\\project\\binary.bin") }), EditorPaneMatch.Optional);
});

test("Stanza excludes structured Academic documents", () => {
	assert.equal(matchCodeEditor({
		resource: URI.file("C:\\papers\\research.ash-paper"),
		contentType: ACADEMIC_DOCUMENT_CONTENT_TYPE,
	}), EditorPaneMatch.None);
});

test("Stanza diff inputs have one stable tab identity and select only the diff pane", () => {
	const original = { resource: URI.file("C:\\project\\before.ts"), label: "before.ts" };
	const modified = { resource: URI.file("C:\\project\\after.ts"), label: "after.ts" };
	const input = createDiffEditorInput(original, modified, "Review changes");

	assert.equal(DIFF_EDITOR_ID, "stanza.editor.diff");
	assert.equal(input.label, "Review changes");
	assert.equal(input.readOnly, true);
	assert.equal(matchDiffEditor(input), EditorPaneMatch.Default);
	assert.equal(matchCodeEditor(input), EditorPaneMatch.None);
	assert.match(input.resource.toString(), /^ash-diff:\/compare\?/);
});
