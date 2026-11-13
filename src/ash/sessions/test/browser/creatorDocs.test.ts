import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { IEditorPart } from '../../../workbench/browser/parts/editor/editorPart.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IViewsService } from '../../../workbench/services/views/common/viewsService.js';
import { ISessionsEntryService, type ISessionsEntry } from '../../services/layout/common/sessionsEntryService.js';
import { TestConfigurationService } from '../../../workbench/services/configuration/test/common/testServices.js';
import { BrowserStorageService } from '../../../workbench/services/storage/browser/storageService.js';
import { CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { EditorPanes } from '../../../workbench/browser/editor.js';
import { DOCS_ARTIFACT_EDITOR_ID, DOCS_EDITOR_SETTING, GENERAL_DOCUMENT_CONTENT_TYPE } from '../../contrib/docs/common/docs.js';

const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://docs.test' });
for (const [key, value] of Object.entries({ window: browser.window, document: browser.window.document, HTMLElement: browser.window.HTMLElement, Node: browser.window.Node })) {
	Object.defineProperty(globalThis, key, { configurable: true, value });
}
await import('../../contrib/docs/browser/docs.contribution.js');

for (const [preference, extension] of [
	[undefined, '.ash-doc'], ['automatic', '.ash-doc'], ['rich', '.ash-doc'], ['markdown', '.md'],
] as const) test(`Docs routes ${preference ?? 'default'} creation to ${extension}`, async () => {
	using lifetime = new DisposableStore();
	const services = lifetime.add(new InstantiationService());
	const configuration = lifetime.add(new TestConfigurationService({ source: JSON.stringify({ [DOCS_EDITOR_SETTING]: preference }) }));
	const storage = lifetime.add(new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: `${preference}`, flushInterval: 0 }));
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IStorageService, storage);
	services.registerInstance(IEditorPart, { groups: [] } as unknown as IEditorPart);
	services.registerInstance(IViewsService, { getVisibleViewContainer: () => null } as unknown as IViewsService);
	const entries: ISessionsEntry[] = [];
	services.registerInstance(ISessionsEntryService, { openEntry: async (entry: ISessionsEntry) => { entries.push(entry); } } as unknown as ISessionsEntryService);
	await services.invokeFunction(accessor => CommandsRegistry.getCommand('sessions.creator.newDocument')!(accessor));
	assert.equal(entries.length, 1);
	const input = entries[0].editorInput!;
	assert.ok(input.resource.path.endsWith(extension));
	assert.equal(input.contentType, extension === '.md' ? 'text/markdown' : GENERAL_DOCUMENT_CONTENT_TYPE);
	if (extension === '.ash-doc') assert.equal(EditorPanes.getEditorPane(input)?.id, DOCS_ARTIFACT_EDITOR_ID);
	assert.equal(entries[0].activityContext, 'sessions.activity.creatorSelected');
});
