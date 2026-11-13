import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IEditorPart } from '../../../../../workbench/browser/parts/editor/editorPart.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IViewsService } from '../../../../../workbench/services/views/common/viewsService.js';
import { ISessionsEntryService, type ISessionsEntry } from '../../../../services/layout/common/sessionsEntryService.js';
import { TestConfigurationService } from '../../../../../workbench/services/configuration/test/common/testServices.js';
import { BrowserStorageService } from '../../../../../workbench/services/storage/browser/storageService.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { EditorPanes } from '../../../../../workbench/browser/editor.js';
import { DOCS_MARKDOWN_EDITOR_ID, DOCS_EDITOR_SETTING, GENERAL_DOCUMENT_CONTENT_TYPE } from '../../common/docs.js';
import { restoredDocsResource } from '../../browser/documentActions.js';

const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://docs.test' });
for (const [key, value] of Object.entries({ window: browser.window, document: browser.window.document, HTMLElement: browser.window.HTMLElement, Node: browser.window.Node })) {
	Object.defineProperty(globalThis, key, { configurable: true, value });
}
await import('../../browser/docs.contribution.js');

for (const [preference, extension] of [
	[undefined, '.md'], ['automatic', '.md'], ['rich', '.md'], ['markdown', '.md'],
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
	await services.invokeFunction(accessor => CommandsRegistry.getCommand('sessions.docs.newDocument')!(accessor));
	assert.equal(entries.length, 1);
	const input = entries[0].editorInput!;
	assert.ok(input.resource.path.endsWith(extension));
	assert.equal(input.contentType, 'text/markdown');
	assert.equal(EditorPanes.getEditorPane(input)?.id, DOCS_MARKDOWN_EDITOR_ID);
	assert.equal(entries[0].activityContext, 'sessions.activity.artifactsSelected');
});

test('Docs restores its own document pointer and migrates the former Artifacts state', () => {
	using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'docs-state', flushInterval: 0 });
	const resource = 'file:///tmp/readme.md';
	storage.store('sessions.artifacts.activeDocument', resource, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	assert.equal(restoredDocsResource(storage)?.toString(), resource);
	assert.equal(storage.get('sessions.docs.activeDocument', StorageScope.WORKSPACE), resource);
	assert.equal(storage.get('sessions.artifacts.activeDocument', StorageScope.WORKSPACE), undefined);
	storage.store('sessions.artifacts.activeDocument', 'file:///tmp/stale.ash-doc', StorageScope.WORKSPACE, StorageTarget.MACHINE);
	assert.equal(restoredDocsResource(storage)?.toString(), resource);
});

test('Docs imports editable structured text without a spatial canvas', async () => {
	const { docsEditorProfile, importDocsHtml } = await import('../../browser/docsEditorProfile.js');
	const document = importDocsHtml('<h1>Editable document</h1><p>Body text</p><script>alert(1)</script>', browser.window.document);
	assert.ok(document);
	const profile = docsEditorProfile.create();
	assert.match(profile.exportText!(document, 'markdown'), /Editable document[\s\S]*Body text/u);
	assert.doesNotMatch(profile.exportText!(document, 'markdown'), /alert\(1\)/u);
	assert.equal(docsEditorProfile.contentType, GENERAL_DOCUMENT_CONTENT_TYPE);
});
