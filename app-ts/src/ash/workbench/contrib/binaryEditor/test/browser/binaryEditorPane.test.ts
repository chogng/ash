import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { URI } from "../../../../../base/common/uri.js";
import { FileKind, type IFileService, type IFileWriteRequest } from "../../../../../platform/files/common/files.js";
import { EditorPaneMatch } from "../../../../../workbench/browser/parts/editor/editorPane.js";
import { BinaryEditorPane, binaryEditorDescriptor } from "../../../../../workbench/contrib/binaryEditor/browser/binaryEditorPane.js";

test("BinaryEditorPane renders a bounded hexadecimal and ascii preview", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const resource = URI.file("C:\\project\\sample.bin");
	const pane = new BinaryEditorPane(new TestFileService(new Uint8Array([0x48, 0x69, 0x00, 0xff])));
	pane.create(dom.window.document.body);
	await pane.setInput({ resource }, new AbortController().signal);

	assert.match(dom.window.document.querySelector(".ash-binary-editor-summary")?.textContent ?? "", /4 B.*read-only/i);
	assert.equal(dom.window.document.querySelector(".ash-binary-editor-content")?.textContent, "00000000  48 69 00 ff                                      |Hi..|");

	pane.dispose();
	dom.window.close();
});

test("binary editor descriptor is default for explicit binary content and optional for files", () => {
	const descriptor = binaryEditorDescriptor();
	assert.equal(descriptor.canOpen({ resource: URI.file("C:\\project\\sample.bin"), contentType: "application/octet-stream" }), EditorPaneMatch.Default);
	assert.equal(descriptor.canOpen({ resource: URI.file("C:\\project\\sample.bin") }), EditorPaneMatch.Optional);
	assert.equal(descriptor.canOpen({ resource: URI.parse("untitled:/sample.bin") }), EditorPaneMatch.None);
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
