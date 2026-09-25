import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { URI } from "../../../../../base/common/uri.js";
import { FileKind, type IFileService, type IFileWriteRequest } from "../../../../../platform/files/common/files.js";
import { EditorPaneMatch } from "../../../../../workbench/browser/parts/editor/editorPane.js";
import { BaseBinaryResourceEditor, binaryEditorDescriptor } from "../../../../../workbench/browser/parts/editor/binaryEditor.js";
import { BinaryResourceDiffEditor, binaryDiffEditorDescriptor, createBinaryDiffEditorInput } from "../../../../../workbench/browser/parts/editor/binaryDiffEditor.js";
import { EditorInputSerializers } from "../../../../../workbench/services/editor/common/editorInputSerializer.js";
import { BinaryFileEditor } from '../../../files/browser/editors/binaryFileEditor.js';
import { CODE_EDITOR_ID } from '../../../../common/editor/codeEditorId.js';
import { emptyEditorServiceState } from '../../../../test/common/testEditorService.js';
import type { EditorInput, EditorOpenOptions } from '../../../../services/editor/common/editorService.js';
import type { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';

test("BinaryEditorPane renders a bounded hexadecimal and ascii preview", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const resource = URI.file("C:\\project\\sample.bin");
	const pane = new BaseBinaryResourceEditor(new TestFileService(new Uint8Array([0x48, 0x69, 0x00, 0xff])));
	pane.create(dom.window.document.body);
	await pane.setInput({ resource }, new AbortController().signal);

	assert.match(dom.window.document.querySelector(".ash-binary-editor-summary")?.textContent ?? "", /4 B.*read-only/i);
	assert.equal(dom.window.document.querySelector(".ash-binary-editor-content")?.textContent, "00000000  48 69 00 ff                                      |Hi..|");
	assert.equal(pane.getMetadata(), "4 B");

	pane.dispose();
	dom.window.close();
});

test("binary editor descriptor is default for explicit binary content and optional for files", () => {
	const descriptor = binaryEditorDescriptor();
	assert.equal(descriptor.canOpen({ resource: URI.file("C:\\project\\sample.bin"), contentType: "application/octet-stream" }), EditorPaneMatch.Default);
	assert.equal(descriptor.canOpen({ resource: URI.file("C:\\project\\sample.bin") }), EditorPaneMatch.Optional);
	assert.equal(descriptor.canOpen({ resource: URI.parse("untitled:/sample.bin") }), EditorPaneMatch.None);
});

test('Binary file editor opens a bounded read-only text preview', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const resource = URI.file('C:\\project\\sample.bin');
	let opened: EditorInput | undefined;
	let openOptions: EditorOpenOptions | undefined;
	const dialogs: IDialogService = {
		showMessage: async () => {},
		confirm: async () => { throw new Error('Unexpected confirm'); },
		prompt: async () => { throw new Error('Unexpected prompt'); },
		input: async () => { throw new Error('Unexpected input'); },
	};
	const pane = new BinaryFileEditor(new TestFileService(new Uint8Array([0x48, 0x69, 0x00, 0xff])), {
		...emptyEditorServiceState,
		openEditor: async (input, options) => { opened = input; openOptions = options; },
		focusActiveEditor: () => {},
	}, dialogs);
	pane.create(dom.window.document.body);
	await pane.setInput({ resource }, new AbortController().signal);
	dom.window.document.querySelector<HTMLButtonElement>('.ash-binary-open-as-text')!.click();
	await waitFor(() => opened !== undefined);
	assert.equal(opened?.resource.toString(), resource.toString());
	assert.equal(opened?.readOnly, true);
	assert.equal(opened?.initialText, 'Hi\u0000�');
	assert.equal(openOptions?.preferredEditorId, CODE_EDITOR_ID);
	pane.dispose();
	dom.window.close();
});

test("Binary diff keeps both byte previews and metadata through working-set serialization", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const original = { resource: URI.file("C:\\project\\before.bin"), label: "before.bin" };
	const modified = { resource: URI.file("C:\\project\\after.bin"), label: "after.bin" };
	const input = createBinaryDiffEditorInput(original, modified);
	const restored = EditorInputSerializers.deserialize(EditorInputSerializers.serialize(input));
	assert.equal(binaryDiffEditorDescriptor().canOpen(restored), EditorPaneMatch.Default);
	const pane = new BinaryResourceDiffEditor(new TestFileService(new Uint8Array([0x48, 0x69, 0x00, 0xff])));
	pane.create(dom.window.document.body);
	await pane.setInput(restored, new AbortController().signal);
	pane.layout({ width: 640, height: 480 });
	assert.equal(dom.window.document.querySelectorAll(".ash-side-by-side-editor .ash-binary-editor-content").length, 2);
	assert.equal(pane.getMetadata(), "4 B ↔ 4 B");
	pane.clearInput();
	assert.equal(pane.getMetadata(), undefined);
	pane.dispose();
	dom.window.close();
});

class TestFileService implements IFileService {
	readonly onDidChangeFiles = () => ({ dispose() {}, [Symbol.dispose]() {} });
	constructor(private readonly bytes: Uint8Array) {}
	async stat(resource: URI) { return { resource, kind: FileKind.File, sizeBytes: this.bytes.length, readonly: true, modifiedAtMillis: undefined }; }
	async readFileBytes(resource: URI) { return { resource, bytes: this.bytes, revision: "revision-1" }; }
	async readFile(resource: URI) { return { resource, content: "", revision: "revision-1" }; }
	async readDirectory() { return []; }
	async writeFile(_request: IFileWriteRequest): Promise<never> { throw new Error("read only"); }
	async createFile(): Promise<never> { throw new Error("read only"); }
	async rename(): Promise<never> { throw new Error("read only"); }
	async delete(): Promise<never> { throw new Error("read only"); }
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 0));
	}
	assert.fail('Timed out waiting for binary text preview');
}
