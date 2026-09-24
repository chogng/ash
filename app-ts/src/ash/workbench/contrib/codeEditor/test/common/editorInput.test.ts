import assert from "node:assert/strict";
import { test } from "mocha";
import { URI } from "../../../../../base/common/uri.js";
import { ACADEMIC_DOCUMENT_CONTENT_TYPE } from "../../../../services/documentEditor/common/documentTypes.js";
import { EditorPaneRegistry } from "../../../../browser/parts/editor/editorRegistry.js";
import { binaryEditorDescriptor, BINARY_EDITOR_ID } from "../../../binaryEditor/browser/binaryEditorPane.js";
import { matchPdfEditor, PDF_EDITOR_ID } from "../../../pdf/browser/pdfEditorInput.js";
import { EditorPaneMatch } from "../../../../browser/parts/editor/editorPane.js";
import { CODE_EDITOR_ID, languageForEditorInput, matchCodeEditor } from "../../browser/codeEditorInput.js";
import { LanguageService } from '../../../../../editor/common/services/languageService.js';
import { DIFF_EDITOR_ID, createDiffEditorInput, matchDiffEditor } from "../../browser/diffEditorInput.js";

test("Stanza opens text files while registered languages own resource detection", () => {
	using languages = new LanguageService();
	using tsx = languages.registerLanguage({ id: 'typescriptreact', extensions: ['.tsx'] });
	using jsonc = languages.registerLanguage({ id: 'jsonc', extensions: ['.jsonc'] });
	assert.equal(CODE_EDITOR_ID, "stanza.editor.code");
	assert.equal(matchCodeEditor({ resource: URI.file("C:\\project\\view.tsx") }), EditorPaneMatch.Builtin);
	assert.equal(languageForEditorInput({ resource: URI.file("C:\\project\\view.tsx") }, languages), "typescriptreact");
	assert.equal(languageForEditorInput({ resource: URI.file("C:\\project\\settings.jsonc") }, languages), "jsonc");
	assert.equal(matchCodeEditor({ resource: URI.parse("untitled:/Untitled-1") }), EditorPaneMatch.Default);
	assert.equal(languageForEditorInput({ resource: URI.parse("untitled:/Untitled-1"), languageId: "typescript" }), "typescript");
	assert.equal(matchCodeEditor({ resource: URI.file("C:\\project\\script") }), EditorPaneMatch.Builtin);
	assert.equal(matchCodeEditor({ resource: URI.file("C:\\project\\script.cgi") }), EditorPaneMatch.Builtin);
	assert.equal(matchCodeEditor({ resource: URI.file("C:\\project\\.env") }), EditorPaneMatch.Builtin);
	assert.equal(matchCodeEditor({ resource: URI.file("C:\\project\\binary.bin") }), EditorPaneMatch.Builtin);
});

test('resource detection follows registrations instead of a hardcoded MIME or suffix table', () => {
	using languages = new LanguageService();
	const input = { resource: URI.file('/project/demo.ts'), contentType: 'application/typescript' };
	assert.equal(languageForEditorInput(input, languages), 'plaintext');
	const registration = languages.registerLanguage({ id: 'custom', extensions: ['.ts'], mimetypes: ['application/typescript'] });
	assert.equal(languageForEditorInput(input, languages), 'custom');
	registration.dispose();
	assert.equal(languageForEditorInput(input, languages), 'plaintext');
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


test('files select the text editor before language extensions load while specialized editors keep priority', () => {
	const registry = new EditorPaneRegistry();
	using binary = registry.register(binaryEditorDescriptor());
	using code = registry.register({
		id: CODE_EDITOR_ID,
		name: 'Code',
		canOpen: matchCodeEditor,
		create: () => { throw new Error('Only editor selection is exercised'); },
	});
	using pdf = registry.register({
		id: PDF_EDITOR_ID,
		name: 'PDF',
		canOpen: matchPdfEditor,
		create: () => { throw new Error('Only editor selection is exercised'); },
	});

	for (const filename of ['main.ts', 'main.rs', 'custom.unknown', 'README', 'sample.bin']) {
		const input = { resource: URI.file(`/project/${filename}`) };
		assert.equal(registry.resolve(input).id, CODE_EDITOR_ID, filename);
		assert.equal(registry.resolve(input, { preferredEditorId: BINARY_EDITOR_ID }).id, BINARY_EDITOR_ID);
	}
	assert.equal(registry.resolve({ resource: URI.file('/project/paper.pdf') }).id, PDF_EDITOR_ID);
	assert.equal(registry.resolve({ resource: URI.file('/project/sample.bin'), contentType: 'application/octet-stream' }).id, BINARY_EDITOR_ID);
});
