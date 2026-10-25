import { IOutputService } from '../../../../../workbench/services/output/common/output.js';
import { ViewContainerLocation, WorkbenchViewContainerId } from '../../../../../workbench/common/views.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { CustomViewService, ICustomViewService } from '../../../../services/customView/browser/customViewService.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { constObservable } from '../../../../../base/common/observable.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { AbstractCustomView } from '../../../../services/customView/browser/customView.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { CommandService } from '../../../../../workbench/services/commands/common/commandService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { NullLoggerService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { BrowserStorageService } from '../../../../../workbench/services/storage/browser/storageService.js';
import { TestWorkspaceService } from '../../../../../workbench/services/configuration/test/common/testServices.js';
import { IEditorPart } from '../../../../../workbench/browser/parts/editor/editorPart.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import type { EditorPartChangeEvent } from '../../../../../workbench/services/editor/common/editorState.js';
import type { IResourceEditorInput } from '../../../../../workbench/common/editor.js';
import { ILifecycleService } from '../../../../../workbench/services/lifecycle/common/lifecycle.js';
import { AbstractLifecycleService } from '../../../../../workbench/services/lifecycle/common/lifecycleService.js';
import { IViewsService } from '../../../../../workbench/services/views/common/viewsService.js';
import { IPaneCompositePartService } from '../../../../../workbench/services/panecomposite/browser/panecomposite.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { SESSIONS_NAVIGATION_CONTAINER_ID } from '../../../../browser/parts/sidebarPart.js';
import { ISessionsConversationService } from '../../../../services/sessions/common/sessionsConversation.js';
import { ISessionChangesService } from '../../../changes/common/sessionChangesService.js';
import { SessionsLayoutService, documentEntry } from '../../browser/sessionsLayoutService.js';
import type { ISessionsEntry } from '../../../../services/layout/common/sessionsLayoutService.js';

suite('SessionsLayoutService lifecycle and focus', () => {
	for (const command of ['sessions.show.library', 'sessions.show.removedFeature']) {
		test(`discards the unavailable saved entry ${command} and restores Chat`, async () => {
			using fixture = new EntryFixture();
			fixture.storage.store('sessions.layout.activeEntry', command, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			const calls: (readonly unknown[])[] = [];
			using chat = CommandsRegistry.register('sessions.open.chat', async (_accessor, ...args) => {
				calls.push(args);
				assert.equal(fixture.storage.get('sessions.layout.activeEntry', StorageScope.WORKSPACE), undefined);
				await fixture.service.openEntry(chatEntry);
			});
			await fixture.service.restore();
			assert.deepEqual(calls, [['restore']]);
			assert.equal(fixture.storage.get('sessions.layout.activeEntry', StorageScope.WORKSPACE), 'sessions.open.chat');
			assert.equal(fixture.contextKeys.getValue('sessions.activity.chatSelected'), true);
			assert.deepEqual(fixture.errors, []);
		});
	}

	test('restores an available saved entry without replacing it with Chat', async () => {
		using fixture = new EntryFixture();
		const command = 'test.sessions.restoreEntry';
		fixture.storage.store('sessions.layout.activeEntry', command, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		const calls: (readonly unknown[])[] = [];
		using entry = CommandsRegistry.register(command, (_accessor, ...args) => { calls.push(args); });
		await fixture.service.restore();
		assert.deepEqual(calls, [['restore']]);
		assert.equal(fixture.storage.get('sessions.layout.activeEntry', StorageScope.WORKSPACE), command);
	});

	test('does not hide a failure from an available restore command', async () => {
		using fixture = new EntryFixture();
		const command = 'test.sessions.failingRestore';
		fixture.storage.store('sessions.layout.activeEntry', command, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		const failure = new Error('Restore handler failed');
		using entry = CommandsRegistry.register(command, () => { throw failure; });
		await assert.rejects(fixture.service.restore(), error => error === failure);
		assert.equal(fixture.storage.get('sessions.layout.activeEntry', StorageScope.WORKSPACE), command);
	});

	test('reveals Output beside the current conversation without navigating to another entry', async () => {
		using fixture = new EntryFixture();
		await fixture.service.openEntry({ id: 'chat', activityContext: 'sessions.activity.chatSelected', content: 'conversation', focus: 'conversation', restoreCommand: 'sessions.open.chat' });
		fixture.partChanges.length = 0;
		fixture.viewVisibility.fire({ id: WorkbenchViewContainerId.Output, location: ViewContainerLocation.Panel, visible: true });
		assert.equal(fixture.visible.get('panel'), true);
		assert.equal(fixture.service.isDocumentContent, false);
		assert.deepEqual(fixture.partChanges, ['available:panel', 'show:panel']);
		fixture.visible.set('panel', false);
		fixture.outputReveal.fire();
		assert.equal(fixture.visible.get('panel'), true);
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reopening an already active document leaves the conversation entry even without an editor change', async () => {
		using fixture = new EntryFixture();
		await fixture.service.openEntry(chatEntry);
		fixture.activeInput = { resource: URI.parse('untitled:/channel-notes/restored') };
		fixture.revealActiveEditor.fire();
		await fixture.service.runOperation(async () => { });
		await fixture.service.runOperation(async () => { });
		assert.equal(fixture.service.isDocumentContent, true);
		assert.equal(fixture.visible.get('editor'), true);
		assert.equal(fixture.storage.get('sessions.layout.activeEntry', StorageScope.WORKSPACE), documentEntry.restoreCommand);
	});

	test('disposal during conversation preparation stops queued entries and Part mutations', async () => {
		using fixture = new EntryFixture();
		const gate = new DeferredPromise<void>();
		fixture.conversationGate = gate.p;
		const pending = fixture.service.openEntry(chatEntry);
		await fixture.conversationStarted.p;
		const queued = fixture.service.openEntry(documentEntry);
		fixture.service.dispose();
		await gate.complete();
		await Promise.all([pending, queued]);
		assert.deepEqual({ groups: fixture.groupChanges, parts: fixture.partChanges, entries: fixture.opened, errors: fixture.errors }, { groups: [], parts: [], entries: [], errors: [] });
		assert.equal(fixture.storage.get('sessions.layout.activeEntry', StorageScope.WORKSPACE), undefined);
	});

	test('disposal while opening navigation prevents later visibility, focus and persistence', async () => {
		using fixture = new EntryFixture();
		const gate = new DeferredPromise<void>();
		fixture.navigationGate = gate.p;
		const pending = fixture.service.openEntry(chatEntry);
		await fixture.navigationStarted.p;
		const beforeDispose = fixture.partChanges.length;
		fixture.service.dispose();
		await gate.complete();
		await pending;
		assert.equal(fixture.partChanges.length, beforeDispose);
		assert.equal(fixture.focused, undefined);
		assert.equal(fixture.storage.get('sessions.layout.activeEntry', StorageScope.WORKSPACE), undefined);
	});

	test('shared Settings modal opening and closing preserves the current conversation entry', async () => {
		using fixture = new EntryFixture();
		await fixture.service.openEntry(chatEntry);
		const before = fixture.partChanges.length;
		fixture.activeInput = { resource: URI.parse('ash-settings:/user') };
		fixture.modalVisible = true;
		fixture.activeEditorChanged.fire();
		fixture.editorChanged.fire({ kind: 'modalEditorChanged', visible: true });
		await fixture.service.runOperation(async () => { });
		fixture.modalVisible = false;
		fixture.activeEditorChanged.fire();
		fixture.editorChanged.fire({ kind: 'modalEditorChanged', visible: false });
		await fixture.service.runOperation(async () => { });
		assert.equal(fixture.storage.get('sessions.layout.activeEntry', StorageScope.WORKSPACE), chatEntry.restoreCommand);
		assert.equal(fixture.partChanges.length, before);
		fixture.editorChanged.fire({ kind: 'activeGroupChanged', groupId: 1 });
		await fixture.service.runOperation(async () => { });
		assert.equal(fixture.storage.get('sessions.layout.activeEntry', StorageScope.WORKSPACE), documentEntry.restoreCommand);
	});

	test('Code Details-only focuses its visible pane instead of hidden editor content', async () => {
		using fixture = new EntryFixture();
		await fixture.service.openEntry(documentEntry);
		assert.equal(fixture.visible.get('editor'), false);
		assert.equal(fixture.visible.get('auxiliarybar'), true);
		assert.equal(fixture.focused, 'details');
	});

	test('background entry restoration preserves the Custom View, focus and activity selection', async () => {
		using fixture = new EntryFixture();
		using registration = fixture.customViews.registerCustomView({ id: 'automations', ctor: new SyncDescriptor(TestCustomView) });
		fixture.customViews.showCustomView('automations');
		await fixture.service.openEntry(documentEntry, undefined, { source: 'restore' });
		assert.equal(fixture.customViews.activeCustomView.get()?.id, 'automations');
		assert.equal(fixture.focused, undefined);
		assert.equal(fixture.contextKeys.getContext().getValue('sessions.activity.codeSelected'), false);
		fixture.activeInput = { resource: URI.file('/background.ts') };
		fixture.editorChanged.fire({ kind: 'activeGroupChanged', groupId: 1 });
		await fixture.service.runOperation(async () => { });
		assert.equal(fixture.customViews.activeCustomView.get()?.id, 'automations');
		assert.equal(fixture.storage.get('sessions.layout.activeEntry', StorageScope.WORKSPACE), documentEntry.restoreCommand);
		await fixture.service.openEntry(chatEntry);
		assert.equal(fixture.customViews.activeCustomView.get(), undefined);
		assert.equal(fixture.focused, 'conversation');
		assert.equal(fixture.contextKeys.getContext().getValue('sessions.activity.chatSelected'), true);
	});

	test('Code child entries retain the Code workspace and a declared Custom View restores its underlying entry', async () => {
		using fixture = new EntryFixture();
		await fixture.service.openEntry(chatEntry);
		assert.equal(fixture.contextKeys.getValue('sessions.workspaceMode'), 'chat');
		await fixture.service.openEntry({ ...chatEntry, id: 'collaboration', workspaceMode: 'code', activityContext: 'sessions.activity.collaborationSelected' });
		assert.equal(fixture.contextKeys.getValue('sessions.workspaceMode'), 'code');
		using command = CommandsRegistry.register('sessions.open.code', async () => fixture.service.openEntry(documentEntry, undefined, { source: 'restore' }));
		using registration = fixture.customViews.registerCustomView({ id: 'automations', ctor: new SyncDescriptor(TestCustomView), entryCommand: 'sessions.open.code' });
		fixture.customViews.showCustomView('automations');
		await fixture.service.restore();
		assert.equal(fixture.customViews.activeCustomView.get()?.id, 'automations');
		assert.equal(fixture.contextKeys.getValue('sessions.workspaceMode'), 'code');
		assert.equal(fixture.contextKeys.getValue('sessions.activity.codeSelected'), false);
		assert.equal(fixture.storage.get('sessions.layout.activeEntry', StorageScope.WORKSPACE), 'sessions.open.code');
		await fixture.service.openEntry(chatEntry);
		assert.equal(fixture.contextKeys.getValue('sessions.workspaceMode'), 'chat');
		assert.equal(fixture.customViews.activeCustomView.get(), undefined);
	});

	test('a Custom View opened while navigation awaits keeps its focus after navigation completes', async () => {
		using fixture = new EntryFixture();
		using registration = fixture.customViews.registerCustomView({ id: 'automations', ctor: new SyncDescriptor(TestCustomView) });
		const gate = new DeferredPromise<void>();
		fixture.navigationGate = gate.p;
		const restoring = fixture.service.openEntry(chatEntry, undefined, { source: 'restore' });
		await fixture.navigationStarted.p;
		fixture.customViews.showCustomView('automations');
		await gate.complete();
		await restoring;
		assert.equal(fixture.customViews.activeCustomView.get()?.id, 'automations');
		assert.equal(fixture.focused, undefined);
	});

	test('a remembered hidden sidebar does not take focus during entry restoration', async () => {
		using fixture = new EntryFixture({ teams: { sidebar: true, details: false, panel: false, documents: false } });
		fixture.visible.set('sidebar', false);
		await fixture.service.openEntry({ ...chatEntry, id: 'teams', focus: 'sidebar' });
		assert.deepEqual(fixture.opened, [{ id: chatEntry.sidebarContainerId, focus: false }]);
		assert.equal(fixture.visible.get('sidebar'), false);
		assert.equal(fixture.focused, 'conversation');
	});

	test('a product page without a navigation container keeps global navigation and its own selected entry', async () => {
		using fixture = new EntryFixture({ website: { sidebar: false, details: false, panel: false, documents: false } });
		await fixture.service.openEntry({ ...chatEntry, id: 'website', activityContext: 'sessions.activity.websiteSelected', restoreCommand: 'sessions.show.website', content: 'editor', sidebarContainerId: undefined, showEditorTabs: false, focus: 'editor' });
		assert.equal(fixture.visible.get('sidebar'), true);
		assert.equal(fixture.pageTitleVisible, false);
		assert.deepEqual(fixture.opened, [{ id: SESSIONS_NAVIGATION_CONTAINER_ID, focus: false }]);
		assert.equal(fixture.focused, 'editor');
		assert.equal(fixture.contextKeys.getValue('sessions.activity.websiteSelected'), true);
		assert.equal(fixture.contextKeys.getValue(chatEntry.activityContext), undefined);
		assert.equal(fixture.storage.get('sessions.layout.activeEntry', StorageScope.WORKSPACE), 'sessions.show.website');
		await fixture.service.openEntry(chatEntry);
		assert.equal(fixture.visible.get('sidebar'), true);
		assert.equal(fixture.pageTitleVisible, true);
		assert.deepEqual(fixture.opened, [{ id: SESSIONS_NAVIGATION_CONTAINER_ID, focus: false }, { id: chatEntry.sidebarContainerId, focus: false }]);
	});

	test('sidebar visibility follows the window across pages and is removed from legacy entry preferences', async () => {
		using fixture = new EntryFixture({
			chat: { sidebar: false, details: false, panel: false, documents: false },
			website: { sidebar: true, details: false, panel: false, documents: false },
		});
		const page = { ...chatEntry, id: 'website', content: 'editor', sidebarContainerId: undefined, focus: 'editor' } as const;
		await fixture.service.openEntry(chatEntry);
		assert.equal(fixture.visible.get('sidebar'), true, 'A legacy per-entry value cannot collapse global navigation');
		fixture.visible.set('sidebar', false);
		await fixture.service.openEntry(page);
		assert.equal(fixture.visible.get('sidebar'), false);
		await fixture.service.openEntry(chatEntry);
		assert.equal(fixture.visible.get('sidebar'), false);
		fixture.visible.set('sidebar', true);
		await fixture.service.openEntry(page);
		assert.equal(fixture.visible.get('sidebar'), true);
		assert.deepEqual(JSON.parse(fixture.storage.get('sessions.layout.entryVisibility', StorageScope.PROFILE)!), {
			chat: { details: false, panel: false, documents: false },
			website: { details: false, panel: false, documents: false },
		});
	});

	test('shutdown joins entry navigation then stops periodic storage callbacks', async () => {
		using fixture = new EntryFixture();
		await fixture.service.openEntry(chatEntry);
		await fixture.lifecycle.shutdown('reload');
		const saved = fixture.storage.get('sessions.layout.entryVisibility', StorageScope.PROFILE);
		fixture.visible.set('sidebar', false);
		await fixture.storage.flush();
		assert.equal(fixture.service.isDisposed, true);
		assert.equal(fixture.storage.get('sessions.layout.entryVisibility', StorageScope.PROFILE), saved);
	});
});

const chatEntry: ISessionsEntry = { id: 'chat', content: 'conversation', activityContext: 'sessions.activity.chatSelected', sidebarContainerId: 'navigation', restoreCommand: 'sessions.open.chat', focus: 'conversation' };
class TestLifecycle extends AbstractLifecycleService { }
class TestCustomView extends AbstractCustomView {
	readonly title = constObservable('Automations');
	render(): void { }
	layout(): void { }
}

class EntryFixture extends Disposable {
	private readonly dom = new JSDOM('', { url: 'https://entry-layout.test' });
	private readonly services = this._register(new InstantiationService());
	public readonly storage = this._register(new BrowserStorageService({ ownerWindow: browserEnvironment.window as unknown as Window, workspaceId: 'sessions', backend: this.dom.window.localStorage, flushInterval: 0 }));
	public readonly lifecycle = this._register(new TestLifecycle(undefined, new NullLoggerService(), this.storage));
	public readonly contextKeys = this._register(new ContextKeyService());
	public readonly customViews = this._register(new CustomViewService(new NullLoggerService(), this.storage));
	private readonly workspace = this._register(new TestWorkspaceService({ id: 'sessions', folders: [] }));
	public readonly editorChanged = this._register(new Emitter<EditorPartChangeEvent>());
	public readonly activeEditorChanged = this._register(new Emitter<void>());
	public readonly revealActiveEditor = this._register(new Emitter<void>());
	public readonly visible = new Map<string, boolean>([['sessions', true], ['editor', false], ['auxiliarybar', false], ['sidebar', true], ['panel', false]]);
	public readonly partChanges: string[] = [];
	public readonly groupChanges: string[] = [];
	public pageTitleVisible = true;
	public readonly opened: { id: string; focus: boolean | undefined; }[] = [];
	public readonly errors: string[] = [];
	public focused: string | undefined;
	public conversationGate: Promise<void> | undefined;
	public navigationGate: Promise<void> | undefined;
	public readonly conversationStarted = new DeferredPromise<void>();
	public readonly navigationStarted = new DeferredPromise<void>();
	public activeInput: IResourceEditorInput | undefined;
	public modalVisible = false;
	public readonly service: SessionsLayoutService;
	public readonly outputReveal = this._register(new Emitter<void>());
	public readonly viewVisibility = this._register(new Emitter<{ id: string; location: ViewContainerLocation; visible: boolean; }>());
	constructor(savedVisibility?: unknown) {
		super();
		this._register(toDisposable(() => this.dom.window.close()));
		if (savedVisibility) { this.storage.store('sessions.layout.entryVisibility', JSON.stringify(savedVisibility), StorageScope.PROFILE, StorageTarget.MACHINE); }
		const fixture = this;
		const documentGroup = { id: 'documents', inputs: [] };
		const pageGroup = { id: 'pages', inputs: [], setTitleVisible: (visible: boolean) => { this.pageTitleVisible = visible; } };
		this.services.registerInstance(IStorageService, this.storage);
		this.services.registerInstance(IConfigurationService, this._register(new InMemoryConfigurationService()));
		this.services.registerInstance(ICustomViewService, this.customViews);
		this.services.registerInstance(ILifecycleService, this.lifecycle);
		this.services.registerInstance(IContextKeyService, this.contextKeys);
		this.services.registerInstance(IWorkspaceContextService, this.workspace);
		this.services.registerInstance(IEditorPart, {
			pageGroupId: pageGroup.id, groups: [documentGroup, pageGroup], activeGroup: documentGroup,
			onDidChangeEditors: this.editorChanged.event,
			onDidRevealActiveEditor: this.revealActiveEditor.event,
			get isModalEditorVisible() { return fixture.modalVisible; },
			setGroupVisible: (id: string, visible: boolean) => this.groupChanges.push(id + ':' + visible),
			activateGroup: (id: string) => this.groupChanges.push('activate:' + id),
			focus: () => { this.focused = 'editor'; },
		} as unknown as IEditorPart);
		this.services.registerInstance(IEditorService, {
			onDidActiveEditorChange: this.activeEditorChanged.event, onDidVisibleEditorsChange: Event.None,
			get activeEditor() { return fixture.activeInput; }, visibleEditors: [],
			focusActiveEditor: () => { this.focused = 'editor'; },
		} as unknown as IEditorService);
		this.services.registerInstance(ISessionsService, { onDidChange: Event.None, activeSelection: undefined, getSelection: () => ({ activeSelection: undefined, visibleSelections: [] }) } as unknown as ISessionsService);
		this.services.registerInstance(ISessionsManagementService, { onDidChange: Event.None, materializedSessions: observableValue('materialized', new Map()), state: 'loading' } as unknown as ISessionsManagementService);
		this.services.registerInstance(ISessionChangesService, {} as ISessionChangesService);
		this.services.registerInstance(INotificationService, { error: (message: string) => { this.errors.push(message); } } as unknown as INotificationService);
		this.services.registerInstance(ICommandService, this._register(new CommandService(this.services)));
		this.services.registerInstance(ISessionsConversationService, {
			openInNewWindow: async () => { throw new Error("Unexpected popup"); },
			setConversationKind: async () => {
				if (!this.conversationStarted.isSettled) { await this.conversationStarted.complete(); }
				await this.conversationGate;
			}
		});
		this.services.registerInstance(IOutputService, { onDidRequestShowChannel: this.outputReveal.event } as unknown as IOutputService);
		this.services.registerInstance(IViewsService, {
			onDidChangeViewContainerVisibility: this.viewVisibility.event,
			openViewContainer: async (id: string, focus?: boolean) => {
				this.opened.push({ id, focus });
				if (!this.navigationStarted.isSettled) { await this.navigationStarted.complete(); }
				await this.navigationGate;
				return null;
			}
		} as IViewsService);
		this.services.registerInstance(IPaneCompositePartService, {
			onDidPaneCompositeOpen: Event.None, getActivePaneComposite: () => ({ focus: () => { this.focused = 'details'; } }),
		} as unknown as IPaneCompositePartService);
		this.services.registerInstance(ILayoutService, {
			onDidChangePartVisibility: Event.None, onDidLayoutMainContainer: Event.None,
			isPartVisible: (id: string) => this.visible.get(id) ?? false,
			showPart: (id: string) => { this.visible.set(id, true); this.partChanges.push('show:' + id); },
			hidePart: (id: string) => { this.visible.set(id, false); this.partChanges.push('hide:' + id); },
			setPrimaryPart: (id: string) => this.partChanges.push('primary:' + id),
			setPartAvailable: (id: string, available: boolean) => { this.visible.set(id, available); this.partChanges.push('available:' + id); },
			updateParts: (update: () => void) => update(), focus: () => { this.focused = 'conversation'; },
		} as unknown as ILayoutService);
		this.service = this._register(this.services.createInstance(SessionsLayoutService));
	}
}
