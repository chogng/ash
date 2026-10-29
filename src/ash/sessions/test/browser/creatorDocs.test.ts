import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { IEditorPart } from '../../../workbench/browser/parts/editor/editorPart.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IViewsService } from '../../../workbench/services/views/common/viewsService.js';
import { IExtensionRecommendationsService } from '../../../workbench/services/extensionRecommendations/common/extensionRecommendations.js';
import { ISessionsLayoutService, type ISessionsEntry } from '../../services/layout/common/sessionsLayoutService.js';
import { TestConfigurationService } from '../../../workbench/services/configuration/test/common/testServices.js';
import { BrowserStorageService } from '../../../workbench/services/storage/browser/storageService.js';
import { CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { EditorPanes } from '../../../workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../workbench/browser/parts/editor/editorPane.js';
import { generalProfile } from '../../../../../extensions/academy/browser/generalProfile.js';
import { GENERAL_DOCUMENT_CONTENT_TYPE } from '../../../workbench/contrib/documentEditor/browser/documentEditorInput.js';
import { DOCS_EDITOR_SETTING } from '../../contrib/creator/common/creator.js';

const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://docs.test' });
for (const [key, value] of Object.entries({
	window: browser.window,
	document: browser.window.document,
	HTMLElement: browser.window.HTMLElement,
	Node: browser.window.Node,
})) {
	Object.defineProperty(globalThis, key, { configurable: true, value });
}
await import('../../contrib/creator/browser/creator.contribution.js');

for (const [preference, provider, extension, recommends] of [
	['automatic', false, '.md', true],
	['automatic', true, '.ash-doc', false],
	['markdown', true, '.md', false],
	['rich', false, '.md', true],
	['rich', true, '.ash-doc', false],
] as const)
	test(`Docs ${preference} routes creation with rich provider ${provider}`, async () => {
		using lifetime = new DisposableStore();
		const services = lifetime.add(new InstantiationService());
		const configuration = lifetime.add(
			new TestConfigurationService({ source: JSON.stringify({ [DOCS_EDITOR_SETTING]: preference }) }),
		);
		const storage = lifetime.add(
			new BrowserStorageService({
				ownerWindow: browser.window as unknown as Window,
				workspaceId: `${preference}-${provider}`,
				flushInterval: 0,
			}),
		);
		services.registerInstance(IConfigurationService, configuration);
		services.registerInstance(IStorageService, storage);
		services.registerInstance(IEditorPart, { groups: [] } as unknown as IEditorPart);
		services.registerInstance(IViewsService, { getVisibleViewContainer: () => null } as unknown as IViewsService);
		const entries: ISessionsEntry[] = [];
		services.registerInstance(ISessionsLayoutService, {
			openEntry: async (entry: ISessionsEntry) => {
				entries.push(entry);
			},
		} as unknown as ISessionsLayoutService);
		let recommended = 0;
		services.registerInstance(IExtensionRecommendationsService, {
			recommendForResource: resource => {
				assert.equal(resource.path, '/document.ash-doc');
				++recommended;
			},
		} as IExtensionRecommendationsService);
		if (provider) {
			// The admitted capability uses the real document profile; this test stops at the layout boundary.
			lifetime.add(
				EditorPanes.registerEditorPane({
					id: 'test.docs.rich',
					name: 'Rich document',
					canOpen: input =>
						input.contentType === GENERAL_DOCUMENT_CONTENT_TYPE
							? EditorPaneMatch.Default
							: EditorPaneMatch.None,
					resolveDocumentProfile: async () => generalProfile,
					create: () => {
						throw new Error('The layout boundary owns pane creation');
					},
				}),
			);
		}
		await services.invokeFunction(accessor =>
			CommandsRegistry.getCommand('sessions.creator.newDocument')!(accessor),
		);
		assert.equal(entries.length, 1);
		const input = entries[0].editorInput!;
		assert.ok(input.resource.path.endsWith(extension));
		assert.equal(input.contentType, extension === '.md' ? 'text/markdown' : GENERAL_DOCUMENT_CONTENT_TYPE);
		assert.equal(recommended, recommends ? 1 : 0);
		assert.equal(entries[0].activityContext, 'sessions.activity.creatorSelected');
	});
