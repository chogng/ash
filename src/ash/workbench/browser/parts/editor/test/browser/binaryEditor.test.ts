import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { URI } from '../../../../../../base/common/uri.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { createTestFileService, registerTestComponentServices } from '../../../../../test/common/testEditorServices.js';
import { BinaryEditorTestFileSystemProvider } from '../../../../../test/common/binaryEditorTestServices.js';
import { EditorPaneMatch } from '../../editorPane.js';
import { BaseBinaryResourceEditor, binaryEditorDescriptor } from '../../binaryEditor.js';
import { FileKind } from '../../../../../../platform/files/common/files.js';
import { resetNlsResolver } from '../../../../../../nls.js';
import { initializeTestLocalization } from '../../../../../services/localization/test/common/localizationTestUtils.js';

test('Binary editor renders a bounded hexadecimal and ascii preview', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const resource = URI.file('C:\\project\\sample.bin');
	using services = new InstantiationService();
	services.registerSingleton(IFileService, () => createTestFileService(new BinaryEditorTestFileSystemProvider(new Uint8Array([0x48, 0x69, 0x00, 0xff]))));
	registerTestComponentServices(services, dom.window.document);
	const pane = await binaryEditorDescriptor().create({ instantiationService: services });
	pane.create(dom.window.document.body);
	await pane.setInput({ resource, label: 'sample.bin' }, new AbortController().signal);

	assert.match(dom.window.document.querySelector('.ash-binary-editor-summary')?.textContent ?? '', /4 B.*read-only/i);
	assert.equal(dom.window.document.querySelector('.ash-binary-editor-content')?.textContent, '00000000  48 69 00 ff                                      |Hi..|');
	assert.ok(pane instanceof BaseBinaryResourceEditor);
	assert.equal(pane.getMetadata(), '4 B');
	assert.equal(dom.window.document.querySelector('.ash-binary-editor')?.getAttribute('aria-label'), 'Binary editor: sample.bin');

	pane.dispose();
	dom.window.close();
});

test('binary editor descriptor is default for explicit binary content and optional for files', () => {
	const descriptor = binaryEditorDescriptor();
	assert.equal(descriptor.canOpen({ resource: URI.file('C:\\project\\sample.bin'), contentType: 'application/octet-stream' }), EditorPaneMatch.Default);
	assert.equal(descriptor.canOpen({ resource: URI.file('C:\\project\\sample.bin') }), EditorPaneMatch.Optional);
	assert.equal(descriptor.canOpen({ resource: URI.parse('untitled:/sample.bin') }), EditorPaneMatch.None);
});

test('Binary editor rejects missing file services during creation', () => {
	using services = new InstantiationService();
	assert.throws(() => binaryEditorDescriptor().create({ instantiationService: services }), /fileService/);
});

test('Binary editor rejects oversized files before reading their bytes', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		let reads = 0;
		class OversizedFileService extends BinaryEditorTestFileSystemProvider {
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
		using pane = await binaryEditorDescriptor().create({ instantiationService: services });
		pane.create(dom.window.document.body);
		await assert.rejects(pane.setInput({ resource: URI.file('/oversized.bin') }, new AbortController().signal), /too large/);
		assert.equal(reads, 0);
		assert.equal(dom.window.document.querySelector('.ash-binary-editor-content')?.textContent, '');
	} finally {
		dom.window.close();
	}
});

test('Binary preview translates complete and truncated summaries in Chinese', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	initializeTestLocalization('zh-CN');
	try {
		for (const [size, expected] of [[4, '4 B · 只读十六进制预览'], [65537, '64.0 KiB · 只读十六进制预览 · 前 64.0 KiB']] as const) {
			using services = new InstantiationService();
			services.registerSingleton(IFileService, () => createTestFileService(new BinaryEditorTestFileSystemProvider(new Uint8Array(size))));
			registerTestComponentServices(services, dom.window.document);
			using pane = await binaryEditorDescriptor().create({ instantiationService: services });
			pane.create(dom.window.document.body);
			await pane.setInput({ resource: URI.file('/sample.bin'), label: 'sample.bin' }, new AbortController().signal);
			assert.equal(dom.window.document.querySelector('.ash-binary-editor-summary')?.textContent, expected);
			assert.equal(dom.window.document.querySelector('.ash-binary-editor')?.getAttribute('aria-label'), '二进制编辑器：sample.bin');
		}
	} finally {
		resetNlsResolver();
		dom.window.close();
	}
});
