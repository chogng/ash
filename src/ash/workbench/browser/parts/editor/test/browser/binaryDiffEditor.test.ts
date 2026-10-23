import "../../../../../../editor/test/browser/testEditorDom.js";
import { registerCodeEditorServices } from "../../../../../../editor/test/browser/testCodeEditor.js";
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { URI } from '../../../../../../base/common/uri.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { createTestFileService, registerTestComponentServices } from '../../../../../test/common/testEditorServices.js';
import { BinaryEditorTestFileSystemProvider } from '../../../../../test/common/binaryEditorTestServices.js';
import { createBinaryDiffEditorInput } from '../../../../../common/editor/diffEditorInput.js';
import { EditorPaneMatch } from '../../editorPane.js';
import { BinaryResourceDiffEditor, binaryDiffEditorDescriptor } from '../../binaryDiffEditor.js';
import { BaseBinaryResourceEditor } from '../../binaryEditor.js';
import { EditorInputSerializers } from '../../../../../services/editor/common/editorInputSerializer.js';
import { initializeTestLocalization } from '../../../../../services/localization/test/common/localizationTestUtils.js';
import { resetNlsResolver } from '../../../../../../nls.js';

test('Binary diff keeps both byte previews and metadata through working-set serialization', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const original = { resource: URI.file('C:\\project\\before.bin'), label: 'before.bin' };
	const modified = { resource: URI.file('C:\\project\\after.bin'), label: 'after.bin' };
	const input = createBinaryDiffEditorInput(original, modified);
	const restored = EditorInputSerializers.deserialize(EditorInputSerializers.serialize(input));
	assert.equal(binaryDiffEditorDescriptor().canOpen(restored), EditorPaneMatch.Default);
	using services = new InstantiationService();
	services.registerSingleton(IFileService, () => createTestFileService(new BinaryEditorTestFileSystemProvider(new Uint8Array([0x48, 0x69, 0x00, 0xff]))));
	registerTestComponentServices(services, dom.window.document);
	registerCodeEditorServices(services);
	const pane = binaryDiffEditorDescriptor().create({ instantiationService: services });
	assert.ok(pane instanceof BinaryResourceDiffEditor);
	pane.create(dom.window.document.body);
	await pane.setInput(restored, new AbortController().signal);
	pane.layout({ width: 640, height: 480 });
	assert.equal(dom.window.document.querySelectorAll('.ash-side-by-side-editor .ash-binary-editor-content').length, 2);
	assert.equal(pane.getMetadata(), '4 B ↔ 4 B');
	pane.clearInput();
	assert.equal(pane.getMetadata(), undefined);
	pane.dispose();
	dom.window.close();
});

test('historical binary comparisons restore immutable bytes without a filesystem provider', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	try {
		const input = createBinaryDiffEditorInput(
			{ resource: URI.parse('git-commit:/repo/base/image.bin'), initialBytes: new Uint8Array([0, 1]), readOnly: true },
			{ resource: URI.parse('git-commit:/repo/head/image.bin'), initialBytes: new Uint8Array([0, 255, 2]), readOnly: true },
		);
		const restored = EditorInputSerializers.deserialize(JSON.parse(JSON.stringify(EditorInputSerializers.serialize(input))));
		using services = new InstantiationService();
		registerTestComponentServices(services, dom.window.document);
		registerCodeEditorServices(services);
		const pane = await binaryDiffEditorDescriptor().create({ instantiationService: services });
		assert.ok(pane instanceof BinaryResourceDiffEditor);
		pane.create(dom.window.document.body);
		await pane.setInput(restored, new AbortController().signal);
		assert.equal(pane.getMetadata(), '2 B ↔ 3 B');
		const before = pane.getSecondaryEditorPane() as BaseBinaryResourceEditor;
		const after = pane.getPrimaryEditorPane() as BaseBinaryResourceEditor;
		assert.match(before.getControl()!.getModel()!.getValue(), /00 01 --/);
		assert.match(after.getControl()!.getModel()!.getValue(), /00 ff 02/);
		assert.equal(before.getControl()!.getModel()!.getAllDecorations().length, 2);
		assert.equal(after.getControl()!.getModel()!.getAllDecorations().length, 2);
		assert.deepEqual(before.getControl()!.getModel()!.getAllDecorations().map(decoration => decoration.range.toString()), ['[1,14 -> 1,19]', '[1,62 -> 1,64]']);
		assert.match(dom.window.document.querySelector('.ash-binary-editor-summary')!.textContent!, /Original.*2 differing bytes/);
		initializeTestLocalization('zh-CN');
		try {
			await pane.setInput(restored, new AbortController().signal);
			const summaries = dom.window.document.querySelectorAll('.ash-binary-editor-summary');
			assert.equal(summaries[0].textContent, '原始 · 2 B · 预览中 2 个字节不同（按偏移比较）');
			assert.equal(summaries[1].textContent, '修改后 · 3 B · 预览中 2 个字节不同（按偏移比较）');
		} finally { resetNlsResolver(); }
		pane.dispose();
		assert.throws(() => EditorInputSerializers.deserialize({ typeId: 'workbench.editorInput.resource', value: { resource: 'git-commit:/broken', initialBytes: '!not base64!' } }), /bounded base64/);
	} finally { dom.window.close(); }
});
