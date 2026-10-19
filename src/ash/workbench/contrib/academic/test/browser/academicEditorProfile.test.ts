import { startAcademyExtension } from '../../../../../../../test/fixtures/academyExtension.js';
import { MainThreadClientEditors } from '../../../../api/browser/mainThreadClientEditors.js';
import type { IExtensionHostApi, ExtensionHostFleetSnapshot } from '../../../../../platform/agentHost/common/extensionHostApi.js';
import { AdapterManager } from '../../../debug/browser/debugAdapterManager.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { academicProfile } from "../../../../../../../extensions/academic/browser/editorProfile.js";
import { createDocumentEditorPaneOptions } from "../../../documentEditor/browser/editorProfile.js";
import { deserializeDocument } from '../../../../../../../extensions/academic/common/model/documentSerialization.js';

test("Stanza profile materialization keeps schema and browser extensions together", () => {
	const options = createDocumentEditorPaneOptions(academicProfile);
	assert.equal(options.schema?.getNodeSpec("citation")?.kind, "inline");
	assert.equal(options.schema?.getNodeSpec("title")?.kind, "group");
	assert.equal(options.schema?.getNodeSpec("section")?.kind, "group");
	assert.equal(options.schema?.getNodeSpec("bibliography")?.kind, "group");
	assert.equal(options.outlineNavigator, true);
	assert.equal(options.plugins?.length, 1);
	assert.ok(options.nodeViews?.bibliography);
	assert.ok(options.inlineNodeViews?.citation);
	assert.deepEqual(options.createEmptyDocument?.().content.map(node => node.type), ["title", "abstract"]);
});

for (const [locale, label] of [['en', 'Academic Document'], ['zh-CN', '学术论文文档']] as const) {
	test(`Academic package enablement controls editor and file routing in ${locale}`, async () => {
		const { readFile } = await import('node:fs/promises');
		const { JSDOM } = await import('jsdom');
		const { URI } = await import('../../../../../base/common/uri.js');
		const { toDisposable } = await import('../../../../../base/common/lifecycle.js');
		const { resetNlsResolver } = await import('../../../../../nls.js');
		const { initializeTestLocalization, createEmptyTestLanguagePacks } = await import('../../../../services/localization/test/common/localizationTestUtils.js');
		const { GlobalExtensionEnablementService } = await import('../../../../../platform/extensionManagement/common/extensionEnablementService.js');
		const { BrowserStorageService } = await import('../../../../services/storage/browser/storageService.js');
		const { withEnabledBuiltInExtensions } = await import('../../../../../platform/extensions/browser/extensionApi.js');
		const { ExtensionResourceLoaderService } = await import('../../../../../platform/extensionResourceLoader/browser/extensionResourceLoaderService.js');
		const { AppServerExtensionService } = await import('../../../../services/extensions/browser/appServerExtensionService.js');
		const { EditorPanes } = await import('../../../../browser/editor.js');
		const { DocumentTypes } = await import('../../../../services/documentEditor/common/documentTypes.js');
		const { matchCodeEditor } = await import('../../../codeEditor/browser/codeEditorInput.js');
		const { EditorPaneMatch } = await import('../../../../browser/parts/editor/editorPane.js');
		using localization = toDisposable(resetNlsResolver);
		initializeTestLocalization(locale);
		assert.throws(() => deserializeDocument({ format: 'ash.document', version: 2, documentType: 'general' }, academicProfile.createSchema()), {
			message: locale === 'zh-CN' ? '结构化文档类型必须为“academic”。' : "Structured document type must be 'academic'",
		});
		assert.throws(() => deserializeDocument({ format: 'ash.document', version: 1, documentType: 'academic' }, academicProfile.createSchema()), {
			message: locale === 'zh-CN' ? '旧版结构化文档不能声明文档类型。' : 'Legacy structured documents cannot declare a document type',
		});
		const dom = new JSDOM('', { url: 'https://ash.test' });
		try {
			using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: `academic-${locale}`, flushInterval: 0 });
			using enablement = new GlobalExtensionEnablementService(storage);
			const fixture = JSON.parse(await readFile('.build/builtin/fixture.json', 'utf8'));
			const entry = fixture.catalog.extensions.find((entry: { id: string; }) => entry.id === 'ash.academic');
			assert.ok(entry, 'Academic must be staged as an extension package');
			const api = withEnabledBuiltInExtensions({
				list: async () => ({ generation: 1, extensions: [entry], diagnostics: [] }),
				resources: new ExtensionResourceLoaderService(async request => Uint8Array.from(Buffer.from(fixture.resources[request.extensionId][request.path], 'base64'))),
			}, enablement);
			using adapters = new AdapterManager();
			using service = new AppServerExtensionService({
				api,
			}, createEmptyTestLanguagePacks(), adapters);
			const inputs = [
				{ resource: URI.file('/paper.ash-academic') },
				{ resource: URI.file('/paper.ASH-PAPER') },
				{ resource: URI.file('/paper.bin'), contentType: academicProfile.contentType },
			];
			assert.equal(DocumentTypes.find(inputs[0]), undefined);
			await service.start();
			assert.equal(DocumentTypes.find(inputs[0]), undefined, 'a declaration alone does not install an editor');
			const provider = await startAcademyExtension(locale);
			try {
				using bridge = new MainThreadClientEditors(30_000, async () => import('../../../../../../../extensions/academic/browser/editor.js'), {
					invoke: (request, signal) => provider.invoke(request.registrationId, request.operation, request.payload, signal),
				} as IExtensionHostApi, api);
				const snapshot: ExtensionHostFleetSnapshot = {
					generation: 1, extensions: [{
						id: 'ash.academic', version: '1.0.0', packageDigest: `sha256:${'a'.repeat(64)}`, runtimeApiVersion: 1,
						activationGeneration: 1, incarnation: 1, lifecycle: 'ready', failure: undefined, stderr: '', outputEvents: [], registrations: provider.registrations,
					}]
				};
				await bridge.update(snapshot);
				for (const input of inputs) {
					assert.equal(EditorPanes.getEditorPane(input)?.name, label);
					assert.equal(DocumentTypes.find(input)?.id, 'academic');
					assert.equal(matchCodeEditor(input), EditorPaneMatch.None);
				}
				await enablement.disableExtension({ id: entry.id });
				await service.reload();
				await bridge.update({ generation: 2, extensions: [] });
				for (const input of inputs) {
					assert.throws(() => EditorPanes.getEditorPane(input), { message: locale === 'zh-CN' ? '编辑器扩展包不可用。' : 'The editor extension package is unavailable.' });
					assert.equal(DocumentTypes.find(input), undefined);
					assert.equal(matchCodeEditor(input), EditorPaneMatch.None);
				}
				await enablement.enableExtension({ id: entry.id });
				await service.reload();
				await bridge.update({ ...snapshot, generation: 3 });
				assert.equal(EditorPanes.getEditorPane(inputs[0])?.name, label);
				service.dispose();
				bridge.clear();
				assert.equal(DocumentTypes.find(inputs[0]), undefined);
			} finally { await provider.dispose(); }
			assert.equal(EditorPanes.getEditorPane(inputs[0]), undefined);
		} finally { dom.window.close(); }
	});
}
