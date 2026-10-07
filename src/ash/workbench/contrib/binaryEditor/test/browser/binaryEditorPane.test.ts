import type { IFileSystemProvider } from '../../../../../platform/files/common/files.js';
import { createTestFileService, registerTestComponentServices } from '../../../../test/common/testEditorServices.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import { createBinaryDiffEditorInput } from '../../../../common/editor/diffEditorInput.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { URI } from "../../../../../base/common/uri.js";
import { Event } from '../../../../../base/common/event.js';
import { FileKind, IFileService, type IFileWriteRequest } from "../../../../../platform/files/common/files.js";
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { EditorPaneMatch } from '../../../../../workbench/browser/parts/editor/editorPane.js';
import { BaseBinaryResourceEditor, binaryEditorDescriptor } from "../../../../../workbench/browser/parts/editor/binaryEditor.js";
import { BinaryResourceDiffEditor, binaryDiffEditorDescriptor } from "../../../../../workbench/browser/parts/editor/binaryDiffEditor.js";
import { EditorInputSerializers } from "../../../../../workbench/services/editor/common/editorInputSerializer.js";
import { BinaryFileEditor } from '../../../files/browser/editors/binaryFileEditor.js';
import { CODE_EDITOR_ID } from '../../../../common/editor/codeEditorId.js';
import { emptyEditorServiceState } from '../../../../test/common/testEditorService.js';
import { IEditorService, type EditorOpenOptions } from '../../../../services/editor/common/editorService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';

test("BinaryEditorPane renders a bounded hexadecimal and ascii preview", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const resource = URI.file("C:\\project\\sample.bin");
	using services = new InstantiationService();
	services.registerSingleton(IFileService, () => createTestFileService(new TestFileService(new Uint8Array([0x48, 0x69, 0x00, 0xff]))));
	registerTestComponentServices(services, dom.window.document);
	const pane = binaryEditorDescriptor().create({ instantiationService: services });
	pane.create(dom.window.document.body);
	await pane.setInput({ resource, label: 'sample.bin' }, new AbortController().signal);

	assert.match(dom.window.document.querySelector(".ash-binary-editor-summary")?.textContent ?? "", /4 B.*read-only/i);
	assert.equal(dom.window.document.querySelector(".ash-binary-editor-content")?.textContent, "00000000  48 69 00 ff                                      |Hi..|");
	assert.ok(pane instanceof BaseBinaryResourceEditor);
	assert.equal(pane.getMetadata(), "4 B");
	assert.equal(dom.window.document.querySelector('.ash-binary-editor')?.getAttribute('aria-label'), 'Binary editor: sample.bin');

	pane.dispose();
	dom.window.close();
});

test("binary editor descriptor is default for explicit binary content and optional for files", () => {
	const descriptor = binaryEditorDescriptor();
	assert.equal(descriptor.canOpen({ resource: URI.file("C:\\project\\sample.bin"), contentType: "application/octet-stream" }), EditorPaneMatch.Default);
	assert.equal(descriptor.canOpen({ resource: URI.file("C:\\project\\sample.bin") }), EditorPaneMatch.Optional);
	assert.equal(descriptor.canOpen({ resource: URI.parse("untitled:/sample.bin") }), EditorPaneMatch.None);
});

test('Binary editor rejects missing file services during creation', () => {
	using services = new InstantiationService();
	assert.throws(() => binaryEditorDescriptor().create({ instantiationService: services }), /fileService/);
});

test('Binary editor rejects oversized files before reading their bytes', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		let reads = 0;
		class OversizedFileService extends TestFileService {
			override async stat(resource: URI) {
				return { resource, kind: FileKind.File, sizeBytes: 129 * 1024 * 1024, readonly: true, modifiedAtMillis: undefined };
			}
			override async readFile(resource: URI) {
				reads++;
				return super.readFile(resource);
			}
		}
		using services = new InstantiationService();
		services.registerSingleton(IFileService, () => createTestFileService(new OversizedFileService(new Uint8Array())));
		registerTestComponentServices(services, dom.window.document);
		using pane = binaryEditorDescriptor().create({ instantiationService: services });
		pane.create(dom.window.document.body);
		await assert.rejects(pane.setInput({ resource: URI.file('/oversized.bin') }, new AbortController().signal), /too large/);
		assert.equal(reads, 0);
		assert.equal(dom.window.document.querySelector('.ash-binary-editor-content')?.textContent, '');
	} finally {
		dom.window.close();
	}
});

test('Binary file editor opens a bounded read-only text preview', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const resource = URI.file('C:\\project\\sample.bin');
	let opened: IResourceEditorInput | undefined;
	let openOptions: EditorOpenOptions | undefined;
	const dialogs: IDialogService = {
		onWillShowDialog: Event.None,
		onDidShowDialog: Event.None,
		about: async () => { throw new Error('Unexpected about dialog'); },
		showMessage: async () => { },
		info: async () => { },
		warn: async () => { },
		error: async () => { },
		confirm: async () => { throw new Error('Unexpected confirm'); },
		prompt: async () => { throw new Error('Unexpected prompt'); },
		input: async () => { throw new Error('Unexpected input'); },
	};
	using services = new InstantiationService();
	services.registerSingleton(IFileService, () => createTestFileService(new TestFileService(new Uint8Array([0x48, 0x69, 0x00, 0xff]))));
	registerTestComponentServices(services, dom.window.document);
	services.registerInstance(IEditorService, {
		...emptyEditorServiceState,
		openEditor: async (input, options) => { opened = input; openOptions = options; },
		focusActiveEditor: () => { },
	});
	services.registerInstance(IDialogService, dialogs);
	const pane = services.createInstance(BinaryFileEditor);
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
	using services = new InstantiationService();
	services.registerSingleton(IFileService, () => createTestFileService(new TestFileService(new Uint8Array([0x48, 0x69, 0x00, 0xff]))));
	registerTestComponentServices(services, dom.window.document);
	const pane = binaryDiffEditorDescriptor().create({ instantiationService: services });
	assert.ok(pane instanceof BinaryResourceDiffEditor);
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

class TestFileService implements IFileSystemProvider {
	readonly onDidChangeFiles = () => ({ dispose() { }, [Symbol.dispose]() { } });
	constructor(private readonly bytes: Uint8Array) { }
	async stat(resource: URI) { return { resource, kind: FileKind.File, sizeBytes: this.bytes.length, readonly: true, modifiedAtMillis: undefined }; }
	async readFile(resource: URI) { return { resource, bytes: this.bytes, revision: "revision-1" }; }
	async readDirectory() { return []; }
	async writeFile(_request: IFileWriteRequest): Promise<never> { throw new Error("read only"); }
	async writeFileBytes(): Promise<never> { throw new Error("read only"); }
	async createFile(): Promise<never> { throw new Error("read only"); }
	async createDirectory(): Promise<never> { throw new Error("read only"); }
	async copy(): Promise<void> { throw new Error("Copy is not used in this test"); }
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
