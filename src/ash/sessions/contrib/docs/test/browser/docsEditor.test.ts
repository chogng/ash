import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IUserDataProfileService } from '../../../../../workbench/services/userDataProfile/common/userDataProfile.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { OpenerService } from '../../../../../editor/browser/services/openerService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IEditorPart } from '../../../../../workbench/browser/parts/editor/editorPart.js';
import type { IResourceEditorInput } from '../../../../../workbench/common/editor.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileTextModelService } from '../../../../../workbench/services/textmodelResolver/common/textModelResourceService.js';
import type { ITextResourceEditorInput } from '../../../../../platform/editor/common/editor.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IViewsService } from '../../../../../workbench/services/views/common/viewsService.js';
import { ISessionsEntryService, type ISessionsEntry } from '../../../../services/layout/common/sessionsEntryService.js';
import { TestConfigurationService } from '../../../../../workbench/services/configuration/test/common/testServices.js';
import { BrowserStorageService } from '../../../../../workbench/services/storage/browser/storageService.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { EditorPanes } from '../../../../../workbench/browser/editor.js';
import { DOCS_ARKDOWN_EDITOR_ID, DOCS_DEFAULT_MODE_SETTING, LEGACY_DOCS_EDITOR_ID, LEGACY_DOCS_FILE_EDITOR_ID } from '../../common/docs.js';
import { createDocsOpener, newDocsResource, restoredDocsResource } from '../../browser/documentActions.js';
import { createArkdownDocsInput } from '../../browser/docsEditorInput.js';
import { SessionsWorkspaceModeContext } from '../../../../common/contextkeys.js';
import { IGeneratedFilesService } from '../../../../services/generatedFiles/common/generatedFilesService.js';
import { IWorkingCopyBackupService, InMemoryWorkingCopyBackupService } from '../../../../../workbench/services/workingCopy/common/workingCopyBackupService.js';
import { IWorkingCopyService } from '../../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { ILifecycleService } from '../../../../../workbench/services/lifecycle/common/lifecycle.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { isRetainedDocsInput } from '../../browser/docsArtifactCatalog.js';

const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://docs.test' });
for (const [key, value] of Object.entries({ window: browser.window, document: browser.window.document, HTMLElement: browser.window.HTMLElement, Node: browser.window.Node })) {
	Object.defineProperty(globalThis, key, { configurable: true, value });
}
await import('../../browser/docs.contribution.js');


function draftPersistence(services: InstantiationService, previous: Partial<IFileService> = {}, backups?: IWorkingCopyBackupService): Map<string, string> {
	const contents = new Map<string, string>();
	services.registerInstance(IUserDataProfileService, { currentProfile: { location: URI.file('/profile') } } as IUserDataProfileService);
	services.registerInstance(IWorkspaceContextService, { getWorkspace: () => ({ id: 'docs-test' }) } as IWorkspaceContextService);
	services.registerInstance(IWorkingCopyBackupService, backups ?? { resolve: async () => undefined, delete: async () => { } } as unknown as IWorkingCopyBackupService);
	services.registerInstance(IFileService, { ...previous, createDirectory: async () => { }, writeFile: async ({ resource, content }: { resource: URI; content: string; }) => { contents.set(resource.toString(), content); return { revision: '1' }; } } as unknown as IFileService);
	return contents;
}

test('Docs resource creation always uses Markdown', () => {
	assert.ok(newDocsResource('Document').path.endsWith('.md'));
	assert.equal(DOCS_DEFAULT_MODE_SETTING, 'sessions.docs.editor');
	assert.equal(DOCS_ARKDOWN_EDITOR_ID, 'sessions.editor.docs.markdown');
});

for (const failOpen of [false, true]) test(`Docs recovers an untitled backup and retires it only after opening succeeds: ${!failOpen}`, async () => {
	using lifetime = new DisposableStore();
	const services = lifetime.add(new InstantiationService());
	const backups = lifetime.add(new InMemoryWorkingCopyBackupService('backup-docs'));
	const persisted = draftPersistence(services, {}, backups);
	services.registerInstance(IStorageService, lifetime.add(new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: `backup-${failOpen}`, flushInterval: 0 })));
	const original = newDocsResource('Recovered');
	await backups.store({ resource: original, kind: 'text', content: 'Recovered content', updatedAt: 1 });
	services.registerInstance(ISessionsEntryService, {
		openEntry: async (entry: ISessionsEntry) => {
			assert.equal(persisted.get(entry.editorInput!.resource.toString()), 'Recovered content');
			assert.ok(await backups.resolve(original));
			if (failOpen) throw new Error('Open failed');
		}
	} as ISessionsEntryService);
	const open = services.invokeFunction(createDocsOpener);
	if (failOpen) await assert.rejects(open(original), /Open failed/);
	else await open(original);
	assert.equal(!!await backups.resolve(original), failOpen);
});

test('Docs catalog retains Markdown inputs with uppercase extensions and explicit content types', () => {
	const generated = { isProfileGeneratedPath: () => false, isGeneratedResource: () => false } as unknown as IGeneratedFilesService;
	assert.equal(isRetainedDocsInput({ resource: URI.file('/notes/UPPER.MD') }, generated), true);
	assert.equal(isRetainedDocsInput({ resource: URI.parse('untitled:/draft'), contentType: 'text/markdown' }, generated), true);
	assert.equal(isRetainedDocsInput({ resource: URI.file('/notes/plain.txt') }, generated), false);
});

test('retired Docs identities expose one legacy importer and remain absent from Markdown editor choices', () => {
	const legacyChoices = (input: IResourceEditorInput) => EditorPanes.getEditorPanesForInput(input)
		.filter(pane => pane.id === LEGACY_DOCS_EDITOR_ID || pane.id === LEGACY_DOCS_FILE_EDITOR_ID);
	const resource = URI.file('/legacy.ash-doc');
	assert.deepEqual(legacyChoices({ resource }).map(pane => pane.id), [LEGACY_DOCS_FILE_EDITOR_ID]);
	assert.deepEqual(legacyChoices({ resource, editorId: LEGACY_DOCS_EDITOR_ID }).map(pane => pane.id), [LEGACY_DOCS_EDITOR_ID]);
	assert.deepEqual(legacyChoices({ resource: URI.file('/notes.md') }), []);
});

for (const [createInput, editorId, contentType] of [
	[createArkdownDocsInput, DOCS_ARKDOWN_EDITOR_ID, 'text/markdown'],
] as const) test(`Docs input adapter owns ${editorId} identity and rename`, () => {
	const source = { resource: URI.parse('untitled:/initial'), editorId: 'test.source', rename: (resource: URI) => ({ resource }) };
	const input = createInput(source);
	assert.equal(input.editorId, editorId);
	assert.equal(input.contentType, contentType);
	assert.equal(createInput(input), input);
	const renamed = input.rename!(URI.parse('file:///renamed'));
	assert.equal(renamed.editorId, editorId);
	assert.equal(renamed.contentType, contentType);
});

for (const initialMode of ['chat', 'code'] as const) {
	for (const finalMode of ['chat', 'code'] as const) {
		test(`generated Markdown uses ${finalMode} presentation after refreshing from ${initialMode}`, async () => {
			using lifetime = new DisposableStore();
			const services = lifetime.add(new InstantiationService());
			const contextKeys = lifetime.add(new ContextKeyService());
			const mode = SessionsWorkspaceModeContext.bindTo(contextKeys);
			mode.set(initialMode);
			const storage = lifetime.add(new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: `${initialMode}-${finalMode}`, flushInterval: 0 }));
			const resource = URI.parse('file:///generated/report.md');
			const refreshed = new DeferredPromise<void>();
			const opened: ITextResourceEditorInput[] = [];
			const entries: ISessionsEntry[] = [];
			services.registerInstance(IContextKeyService, contextKeys);
			services.registerInstance(IStorageService, storage);
			services.registerInstance(IEditorPart, { groups: [] } as unknown as IEditorPart);
			services.registerInstance(ICodeEditorService, {
				getFocusedCodeEditor: () => null,
				openCodeEditor: async (input: ITextResourceEditorInput) => { opened.push(input); return {}; },
			} as unknown as ICodeEditorService);
			services.registerInstance(ICommandService, {} as ICommandService);
			services.registerInstance(ISessionsEntryService, {
				openEntry: async (entry: ISessionsEntry) => { entries.push(entry); },
			} as unknown as ISessionsEntryService);
			services.registerInstance(IGeneratedFilesService, {
				isProfileGeneratedPath: () => true,
				refresh: () => refreshed.p,
				files: [{ resource, title: 'Report', contentType: 'text/markdown' }],
			} as unknown as IGeneratedFilesService);
			const opener = lifetime.add(services.createInstance(OpenerService));
			services.registerInstance(IOpenerService, opener);
			using host = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['sessions.generatedFileOpener']);
			host.advance(WorkbenchPhase.BlockRestore);
			const pending = opener.open(resource);
			mode.set(finalMode);
			await refreshed.complete();
			assert.equal(await pending, true);
			if (finalMode === 'code') {
				assert.equal(entries.length, 0);
				assert.deepEqual(opened, [{ resource, options: { selection: undefined } }]);
			} else {
				assert.equal(opened.length, 0);
				assert.equal(entries.length, 1);
				assert.equal(entries[0].workspaceMode, 'chat');
				assert.equal(entries[0].editorInput?.editorId, DOCS_ARKDOWN_EDITOR_ID);
				assert.equal(entries[0].editorInput?.resource.toString(), resource.toString());
			}
			assert.equal(contextKeys.getValue(SessionsWorkspaceModeContext.key), finalMode);
		});
	}
}

for (const [preference, extension] of [
	[undefined, '.md'], ['automatic', '.md'], ['rich', '.md'], ['markdown', '.md'],
] as const) test(`Docs routes ${preference ?? 'default'} creation to ${extension}`, async () => {
	using lifetime = new DisposableStore();
	const services = lifetime.add(new InstantiationService());
	const configuration = lifetime.add(new TestConfigurationService({ source: JSON.stringify({ [DOCS_DEFAULT_MODE_SETTING]: preference }) }));
	assert.equal(configuration.getValue(DOCS_DEFAULT_MODE_SETTING), preference === 'markdown' ? 'markdown' : 'rich');
	const storage = lifetime.add(new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: `${preference}`, flushInterval: 0 }));
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IStorageService, storage);
	services.registerInstance(IEditorPart, { groups: [] } as unknown as IEditorPart);
	services.registerInstance(IViewsService, { getVisibleViewContainer: () => null } as unknown as IViewsService);
	const entries: ISessionsEntry[] = [];
	services.registerInstance(ISessionsEntryService, { openEntry: async (entry: ISessionsEntry) => { entries.push(entry); } } as unknown as ISessionsEntryService);
	const persisted = draftPersistence(services);
	await services.invokeFunction(accessor => CommandsRegistry.getCommand('sessions.docs.newDocument')!(accessor));
	assert.equal(entries.length, 1);
	const input = entries[0].editorInput!;
	assert.ok(input.resource.path.endsWith(extension));
	assert.equal(input.resource.scheme, 'file');
	assert.ok(input.resource.path.startsWith('/profile/creator/docs-test/docs/'));
	assert.equal(persisted.get(input.resource.toString()), '');
	assert.equal(input.contentType, 'text/markdown');
	assert.equal(EditorPanes.getEditorPane(input)?.id, DOCS_ARKDOWN_EDITOR_ID);
	assert.equal(entries[0].activityContext, 'sessions.activity.artifactsSelected');
	assert.equal(entries[0].workspaceMode, 'chat');
	assert.ok(!EditorPanes.getEditorPanesForInput({ resource: input.resource, languageId: 'markdown' }).some(pane => pane.id === DOCS_ARKDOWN_EDITOR_ID));
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

test('Docs imports sanitized HTML directly into Markdown', async () => {
	const { importDocsHtml } = await import('../../browser/docsImport.js');
	const markdown = importDocsHtml('<h1>Editable document</h1><p>Body text</p><script>alert(1)</script>', browser.window.document);
	assert.ok(markdown);
	assert.match(markdown, /Editable document[\s\S]*Body text/u);
	assert.doesNotMatch(markdown, /alert\(1\)/u);
});

test('Docs text conversion captures unsaved source and embeds local images into a Markdown draft', async () => {
	using lifetime = new DisposableStore();
	const services = lifetime.add(new InstantiationService());
	const storage = lifetime.add(new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'convert-docs', flushInterval: 0 }));
	const resource = URI.file('/source/notes.md');
	let text = '# Unsaved title\n\n![Diagram](diagram.png)\n';
	const reads: string[] = [];
	const entries: ISessionsEntry[] = [];
	services.registerInstance(IStorageService, storage);
	services.registerInstance(IEditorPart, { activeInput: { resource }, domNode: browser.window.document.body } as IEditorPart);
	services.registerInstance(IFileTextModelService, { getModel: () => ({ getValue: () => text }) } as unknown as IFileTextModelService);
	const persisted = draftPersistence(services, { readFileBytes: async (resource: URI) => { reads.push(resource.toString()); return { bytes: new Uint8Array([0, 127, 255]) }; } } as Partial<IFileService>);
	services.registerInstance(ISessionsEntryService, { openEntry: async (entry: ISessionsEntry) => { entries.push(entry); } } as ISessionsEntryService);
	const { convertActiveTextToDocument } = await import('../../browser/documentActions.js');
	const pending = services.invokeFunction(accessor => convertActiveTextToDocument(accessor, 'markdown'));
	text = 'Edited while conversion awaits';
	await pending;
	assert.deepEqual(reads, ['file:///source/diagram.png']);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].editorInput?.editorId, DOCS_ARKDOWN_EDITOR_ID);
	assert.ok(entries[0].editorInput?.resource.path.endsWith('.md'));
	assert.match(persisted.get(entries[0].editorInput!.resource.toString())!, /# Unsaved title[\s\S]*data:image\/png;base64,AH\/\//u);
	assert.doesNotMatch(persisted.get(entries[0].editorInput!.resource.toString())!, /Edited while conversion awaits/u);
});

test('Docs imports a general DOCX directly into an Arkdown Markdown draft', async () => {
	const { createDefaultDocumentSchema } = await import('../../../../../../../extensions/academy/common/model/documentSchema.js');
	const { exportDocx } = await import('../../../../../../../extensions/academy/browser/contrib/documentOutput/docx.js');
	const schema = createDefaultDocumentSchema();
	const document = schema.createDocument([schema.createNode('paragraph', { content: [schema.createText('Imported Word document')] })]);
	const bytes = await exportDocx(document, schema, new AbortController().signal);
	using lifetime = new DisposableStore();
	const services = lifetime.add(new InstantiationService());
	const storage = lifetime.add(new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'import-docx', flushInterval: 0 }));
	const entries: ISessionsEntry[] = [];
	services.registerInstance(IStorageService, storage);
	services.registerInstance(IEditorPart, { domNode: browser.window.document.body } as IEditorPart);
	services.registerInstance(IFileDialogService, { showOpenDialog: async () => [URI.file('/import.docx')] } as unknown as IFileDialogService);
	const persisted = draftPersistence(services, { stat: async () => ({ sizeBytes: bytes.length }), readFileBytes: async () => ({ bytes }) } as unknown as Partial<IFileService>);
	services.registerInstance(ISessionsEntryService, { openEntry: async (entry: ISessionsEntry) => { entries.push(entry); } } as ISessionsEntryService);
	const { importDocumentArtifact } = await import('../../browser/documentActions.js');
	await services.invokeFunction(importDocumentArtifact);
	assert.equal(entries[0].editorInput?.editorId, DOCS_ARKDOWN_EDITOR_ID);
	assert.ok(entries[0].editorInput?.resource.path.endsWith('/import.md'));
	assert.equal(persisted.get(entries[0].editorInput!.resource.toString())?.trim(), 'Imported Word document');
});

test('Docs recovery checks the refreshed account catalog and retains Code source presentation', async () => {
	using lifetime = new DisposableStore();
	const services = lifetime.add(new InstantiationService());
	const backups = lifetime.add(new InMemoryWorkingCopyBackupService('sessions-docs'));
	const generatedResource = URI.file('/generated/previous-account.md');
	const localResource = URI.file('/notes/local-docs.md');
	const codeResource = URI.file('/notes/source.md');
	await backups.store({ resource: generatedResource, kind: 'text', content: 'Previous account draft', contentType: 'text/markdown', updatedAt: 1 });
	await backups.store({ resource: localResource, kind: 'text', content: 'Local Docs draft', contentType: 'text/markdown', updatedAt: 2 });
	await backups.store({ resource: codeResource, kind: 'text', content: 'Code source draft', updatedAt: 3 });
	let currentCatalog = [generatedResource];
	const opened: { input: IResourceEditorInput; groupId: number; }[] = [];
	const restored = new Map<string, string>();
	services.registerInstance(IWorkingCopyBackupService, backups);
	services.registerInstance(IWorkingCopyService, { get: () => [], getAll: () => [], onDidRegister: Event.None, onDidUnregister: Event.None } as unknown as IWorkingCopyService);
	services.registerInstance(IFileTextModelService, { addSaveCompletionParticipant: () => Disposable.None, hasPendingSaveRecovery: () => false } as unknown as IFileTextModelService);
	services.registerInstance(ILifecycleService, { onWillShutdown: Event.None, onDidShutdown: Event.None, onDidShutdownError: Event.None, onBeforeShutdownError: Event.None } as unknown as ILifecycleService);
	services.registerInstance(ILogService, new NullLoggerService());
	services.registerInstance(INotificationService, { error: (error: unknown) => assert.fail(String(error)) } as unknown as INotificationService);
	services.registerInstance(IGeneratedFilesService, {
		isProfileGeneratedPath: () => false,
		isGeneratedResource: (resource: URI) => currentCatalog.some(file => file.toString() === resource.toString()),
		refresh: async () => { currentCatalog = []; },
		get files() { return []; },
	} as unknown as IGeneratedFilesService);
	services.registerInstance(IEditorPart, {
		domNode: browser.window.document.body, pageGroupId: 1, groups: [{ id: 0 }, { id: 1 }],
		openEditor: async (input: IResourceEditorInput, _options: unknown, target: { groupId: number; }) => {
			opened.push({ input, groupId: target.groupId });
			return { workingCopy: { isDirty: false, restoreBackup: (content: string) => restored.set(input.resource.toString(), content) } };
		},
	} as unknown as IEditorPart);
	const { createDocsBackupContribution } = await import('../../browser/docsBackupContribution.js');
	using contribution = services.invokeFunction(createDocsBackupContribution);
	await contribution.onWorkspaceRestored!();
	assert.deepEqual(opened.map(entry => entry.input.resource.toString()), [localResource.toString(), codeResource.toString()]);
	assert.equal(opened[0].input.editorId, DOCS_ARKDOWN_EDITOR_ID);
	assert.equal(opened[0].groupId, 1);
	assert.equal(opened[1].input.editorId, undefined);
	assert.equal(opened[1].groupId, 0);
	assert.equal(restored.get(codeResource.toString()), 'Code source draft');
	assert.equal((await backups.resolve(generatedResource))?.content, 'Previous account draft');
});
