import { URI } from '../../../../../base/common/uri.js';
import { IPaneCompositePartService } from '../../../../../workbench/services/panecomposite/browser/panecomposite.js';
import { ViewContainerLocation } from '../../../../../workbench/common/views.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import { DeferredPromise, raceCancellationError } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { SESSIONS_LAYOUT_SCOPE_SETTING } from '../../../../common/chatLayout.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { NullLoggerService } from '../../../../../platform/log/common/log.js';
import { CustomViewService, ICustomViewService } from '../../../../services/customView/browser/customViewService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { BrowserStorageService } from '../../../../../workbench/services/storage/browser/storageService.js';
import { TestWorkspaceService } from '../../../../../workbench/services/configuration/test/common/testServices.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { ILifecycleService, LifecyclePhase } from '../../../../../workbench/services/lifecycle/common/lifecycle.js';
import { AbstractLifecycleService } from '../../../../../workbench/services/lifecycle/common/lifecycleService.js';
import type { EditorWorkingSet, EditorWorkingSetTarget } from '../../../../../workbench/services/editor/common/editorWorkingSet.js';
import { ISessionsService, SessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import type { IActiveSessionThread, ISession, IUntitledChatSession } from '../../../../services/sessions/common/session.js';

const { IEditorPart } = await import('../../../../../workbench/browser/parts/editor/editorPart.js');
const { DesktopLayoutController } = await import('../../browser/desktopLayoutController.js');
const { BaseLayoutController } = await import('../../browser/baseSessionLayoutController.js');
class WorkingSetController extends BaseLayoutController { }
const storageKey = 'sessions.singlePane.layoutState';

suite('DesktopLayoutController', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a new layout scope adopts live documents before it has a saved working set', async () => {
		using fixture = await createFixture();
		fixture.editor.set(workingSet('live', 'unsaved.ts'));
		await fixture.configuration.updateValue(SESSIONS_LAYOUT_SCOPE_SETTING, 'chat');
		await fixture.controller.whenSettled();
		assert.deepEqual(fixture.editor.current, workingSet('chat:["a","a-thread"]', 'unsaved.ts'));
	});

	for (const mode of ['chat', 'chat-shared'] as const) {
		test(`Chat visibility restores only when scope owns visibility (${mode})`, async () => {
			using fixture = await createFixture();
			await fixture.configuration.updateValue(SESSIONS_LAYOUT_SCOPE_SETTING, mode);
			await fixture.controller.whenSettled();
			fixture.editorVisible = true; fixture.auxiliaryVisible = false;
			fixture.partsChanged.fire();
			await fixture.open('b');
			fixture.editorVisible = false; fixture.auxiliaryVisible = true;
			fixture.partsChanged.fire();
			await fixture.open('a');
			assert.deepEqual([fixture.editorVisible, fixture.auxiliaryVisible], mode === 'chat' ? [true, false] : [false, true]);
			await fixture.storage.flush();
			const saved = JSON.parse(fixture.storage.get(storageKey, StorageScope.WORKSPACE)!);
			assert.deepEqual(saved.find((entry: { sessionResource: string; }) => entry.sessionResource === 'chat:["a","a-thread"]')?.partVisibility, mode === 'chat' ? { editor: true, auxiliarybar: false } : undefined);
		});
	}

	for (const mode of ['chat-shared', 'chat'] as const) {
		test(`restores document working sets independently for peer Chats (${mode})`, async () => {
			using fixture = await createFixture();
			await fixture.configuration.updateValue(SESSIONS_LAYOUT_SCOPE_SETTING, mode);
			fixture.catalog.sessions = fixture.catalog.sessions.map(session => session.sessionId === 'a'
				? { ...session, chats: [...session.chats, { threadId: 'peer', status: 'active', origin: { type: 'root' }, workspace: null }] }
				: session);
			await fixture.controller.whenSettled();
			fixture.editor.set(workingSet('main', 'main.ts'));
			fixture.sessions.openSession('a', 'peer');
			await fixture.controller.whenSettled();
			fixture.editor.set(workingSet('peer', 'peer.ts'));
			fixture.sessions.openSession('a', 'a-thread');
			await fixture.controller.whenSettled();
			assert.deepEqual(fixture.editor.current, workingSet('chat:["a","a-thread"]', 'main.ts'));
			fixture.sessions.openSession('a', 'peer');
			await fixture.controller.whenSettled();
			assert.deepEqual(fixture.editor.current, workingSet('chat:["a","peer"]', 'peer.ts'));
		});
	}
	test('restoring an older Code working set removes page tabs and retains the selected file', async () => {
		const saved = workingSet('session:b', 'retained.ts');
		const file = saved.groups[0]!.editors[0]!;
		const page = (resource: string): typeof file => ({ input: { typeId: 'workbench.editorInput.resource', value: { resource } }, preview: false });
		const mixed = { ...saved, groups: [{ ...saved.groups[0]!, editors: [page('ash-design:/canvas'), file, page('ash-library:/library')], activeEditorIndex: 1 }] };
		using fixture = await createFixture([{ sessionResource: 'session:b', editorWorkingSet: mixed }]);
		await fixture.open('b');
		assert.deepEqual(fixture.editor.current, saved);
		await fixture.storage.flush();
		const persisted = JSON.parse(fixture.storage.get(storageKey, StorageScope.WORKSPACE)!);
		assert.deepEqual(persisted.find((entry: { sessionResource: string; }) => entry.sessionResource === 'session:b').editorWorkingSet, saved);
	});

	test('Code restores each session panel view only while the panel is visible', async () => {
		using fixture = await createFixture([{ sessionResource: 'session:b', panelViewContainerId: 'tools.b' }]);
		await fixture.open('b');
		assert.equal(fixture.panelView, undefined);
		fixture.panelVisible = true;
		fixture.partsChanged.fire();
		assert.equal(fixture.panelView, 'tools.b');
		fixture.panelView = 'tools.a';
		fixture.panelOpened.fire('tools.a');
		await fixture.open('a');
		assert.equal(fixture.panelView, 'ash.panel.terminal');
		await fixture.open('b');
		assert.equal(fixture.panelView, 'tools.a');
		fixture.panelVisible = false;
		fixture.partsChanged.fire();
		await fixture.open('a');
		assert.equal(fixture.panelView, 'tools.a');
		await fixture.storage.flush();
		const saved = JSON.parse(fixture.storage.get(storageKey, StorageScope.WORKSPACE)!) as { sessionResource: string; panelViewContainerId: string; }[];
		assert.equal(saved.find(entry => entry.sessionResource === 'session:b')?.panelViewContainerId, 'tools.a');
	});
	test('switching sessions restores their editors and layout visibility does not change selection', async () => {
		using fixture = await createFixture();
		fixture.editor.set(workingSet('a', 'a.ts'));
		await fixture.open('b');
		assert.equal(fixture.editor.current, 'empty');
		fixture.editor.set(workingSet('b', 'b.ts'));
		await fixture.open('a');
		assert.deepEqual(fixture.editor.current, workingSet('session:a', 'a.ts'));
		const restores = fixture.editor.applied.length;
		fixture.sessionsVisible = false;
		fixture.partsChanged.fire();
		fixture.sessionsVisible = true;
		fixture.partsChanged.fire();
		await fixture.controller.whenSettled();
		assert.equal(fixture.editor.applied.length, restores);
	});

	test('captures outgoing editors immediately and waits for the incoming workspace', async () => {
		using fixture = await createFixture();
		fixture.editor.set(workingSet('a', 'a.ts'));
		fixture.followWorkspace = false;
		fixture.sessions.openSession('b', 'b-thread');
		await fixture.controller.whenSettled();
		assert.equal(fixture.editor.applied.length, 0);
		await fixture.storage.flush();
		assert.deepEqual(JSON.parse(fixture.storage.get(storageKey, StorageScope.WORKSPACE)!).map((entry: { sessionResource: string; }) => entry.sessionResource), ['session:a']);
		fixture.workspace.updateWorkspace({ id: 'b', folders: [] });
		await fixture.controller.whenSettled();
		assert.equal(fixture.editor.current, 'empty');
	});

	test('editor restoration waits for directory hydration and does not settle against a source folder', async () => {
		using fixture = await createFixture();
		const directory = new DeferredPromise<void>();
		fixture.catalog.directoryReady = directory.p;
		fixture.catalog.sessions = fixture.catalog.sessions.map(session => session.sessionId === 'b' ? { ...session, chats: session.chats.map(chat => ({ ...chat, workspace: { authorityId: 'local', root: '/managed/b' } })) } : session);
		fixture.editor.set(workingSet('a', 'a.ts'));
		fixture.sessions.openSession('b', 'b-thread');
		fixture.workspace.updateWorkspace({ id: 'b', folders: [{ id: 'b-source', index: 0, name: 'source', uri: URI.file('/source/b') }] });
		let settled = false;
		const restoring = fixture.controller.whenSettled().then(() => { settled = true; });
		await Promise.resolve();
		assert.equal(settled, false);
		assert.equal(fixture.editor.applied.length, 0);
		fixture.workspace.updateWorkspace({ id: 'b', folders: [{ id: 'b-managed', index: 0, name: 'managed', uri: URI.file('/managed/b') }] });
		await directory.complete();
		await restoring;
		assert.equal(fixture.editor.current, 'empty');
	});

	test('switching selection cancels the old directory wait before restoring the latest session', async () => {
		using fixture = await createFixture();
		const directory = new DeferredPromise<void>();
		fixture.catalog.directoryReady = directory.p;
		fixture.editor.set(workingSet('a', 'a.ts'));
		fixture.sessions.openSession('b', 'b-thread');
		fixture.catalog.directoryReady = undefined;
		fixture.sessions.openSession('a', 'a-thread');
		await fixture.controller.whenSettled();
		assert.deepEqual(fixture.errors, []);
		assert.equal(fixture.editor.applied.length, 0);
		await directory.complete();
	});

	test('switching threads in one session during directory hydration restores the latest selection', async () => {
		const saved = workingSet('session:b', 'retained.ts');
		using fixture = await createFixture([{ sessionResource: 'session:b', editorWorkingSet: saved }]);
		fixture.editor.set(workingSet('a', 'unsaved-source.ts'));
		fixture.followWorkspace = false;
		fixture.catalog.sessions = fixture.catalog.sessions.map(session => session.sessionId === 'b' ? {
			...session,
			chats: [
				{ ...session.chats[0]!, workspace: { authorityId: 'local', root: '/managed/b/first' } },
				{ threadId: 'b-second', status: 'active', origin: { type: 'root' }, workspace: { authorityId: 'local', root: '/managed/b/second' } },
			],
		} : session);
		const directory = new DeferredPromise<void>();
		const started = new DeferredPromise<void>();
		fixture.catalog.directoryReady = directory.p;
		const ready = fixture.catalog.whenDirectoriesReady.bind(fixture.catalog);
		fixture.catalog.whenDirectoriesReady = async signal => {
			if (!started.isSettled) { await started.complete(); }
			await ready(signal);
		};
		fixture.sessions.openSession('b', 'b-thread');
		fixture.workspace.updateWorkspace({ id: 'b', folders: [{ id: 'first', index: 0, name: 'first', uri: URI.file('/managed/b/first') }] });
		await started.p;
		assert.equal(fixture.editor.applied.length, 0);
		fixture.sessions.openSession('b', 'b-second');
		fixture.workspace.updateWorkspace({ id: 'b', folders: [{ id: 'second', index: 0, name: 'second', uri: URI.file('/managed/b/second') }] });
		await directory.complete();
		await fixture.controller.whenSettled();
		assert.deepEqual(fixture.editor.applied, [saved]);
		const selection = fixture.sessions.activeSelection;
		assert.equal(selection?.kind === 'session' ? selection.active.threadId : undefined, 'b-second');
		assert.deepEqual(fixture.errors, []);
		await fixture.storage.flush();
		const persisted = JSON.parse(fixture.storage.get(storageKey, StorageScope.WORKSPACE)!) as { sessionResource: string; editorWorkingSet: EditorWorkingSet; }[];
		assert.deepEqual(persisted.find(entry => entry.sessionResource === 'session:a')?.editorWorkingSet, workingSet('session:a', 'unsaved-source.ts'));
	});

	test('serializes rapid switches without attributing partially restored editors to the next session', async () => {
		using fixture = await createFixture();
		fixture.editor.set(workingSet('a', 'a.ts'));
		const pending = new DeferredPromise<void>();
		fixture.editor.pending = pending.p;
		fixture.sessions.openSession('b', 'b-thread');
		await fixture.editor.started.p;
		fixture.sessions.openSession('c', 'c-thread');
		fixture.sessions.openSession('a', 'a-thread');
		await pending.complete();
		await fixture.controller.whenSettled();
		assert.deepEqual(fixture.editor.applied, ['empty', workingSet('session:a', 'a.ts')]);
		assert.deepEqual(fixture.errors, []);
	});

	test('editor restoration preserves explicit visibility and focus', async () => {
		using fixture = await createFixture();
		fixture.editor.set(workingSet('a', 'a.ts'));
		await fixture.open('b');
		fixture.editor.set(workingSet('b', 'b.ts'));
		fixture.editorVisible = false;
		await fixture.open('a');
		assert.deepEqual({ visible: fixture.editorVisible, options: fixture.editor.options }, { visible: false, options: [{ preserveFocus: true }, { preserveFocus: true }] });
	});

	test('retains the primary editor while Design covers Sessions and defers Code restoration until it returns', async () => {
		using fixture = await createFixture();
		fixture.sessionsVisible = false;
		fixture.partsChanged.fire();
		fixture.editor.set('empty');
		fixture.sessions.openSession('b', 'b-thread');
		await fixture.controller.whenSettled();
		assert.deepEqual({ restores: fixture.editor.applied, editorVisible: fixture.editorVisible }, { restores: [], editorVisible: true });
		fixture.sessionsVisible = true;
		fixture.partsChanged.fire();
		await fixture.controller.whenSettled();
		assert.deepEqual(fixture.editor.applied, ['empty']);
	});

	test('restores persisted tabs on startup without revealing a hidden editor', async () => {
		using fixture = await createFixture([{ sessionResource: 'session:a', editorWorkingSet: workingSet('saved', 'saved.ts') }]);
		assert.deepEqual({ editors: fixture.editor.current, visible: fixture.editorVisible }, { editors: workingSet('saved', 'saved.ts'), visible: false });
		await fixture.storage.flush();
		assert.deepEqual(JSON.parse(fixture.storage.get(storageKey, StorageScope.WORKSPACE)!)[0].editorWorkingSet, workingSet('session:a', 'saved.ts'));
	});

	test('catalog readiness does not discard editor state before local Code drafts are restored', async () => {
		using fixture = new LayoutFixture([{ sessionResource: 'untitled:draft-0', editorWorkingSet: workingSet('saved', 'saved.ts') }]);
		fixture.lifecycle.phase = LifecyclePhase.Ready;
		fixture.controller.start();
		fixture.sessions.openNewSession('Saved draft');
		await fixture.sessions.initialize();
		await fixture.controller.whenSettled();
		fixture.lifecycle.phase = LifecyclePhase.Restored;
		await fixture.storage.flush();
		assert.deepEqual(fixture.editor.current, workingSet('saved', 'saved.ts'));
	});

	test('materializing a Code draft carries live editors into the created session', async () => {
		using fixture = await createFixture();
		const draft = fixture.sessions.openNewSession('Code draft');
		await fixture.controller.whenSettled();
		fixture.editor.set(workingSet('draft', 'draft.ts'));
		fixture.catalog.promoteUntitledSession(draft.untitledSessionId, { session: fixture.catalog.sessions[1]!, threadId: 'b-thread' });
		await fixture.controller.whenSettled();
		assert.equal(fixture.editor.applied.length, 0);
		await fixture.open('c');
		await fixture.open('b');
		assert.deepEqual(fixture.editor.current, workingSet('session:b', 'draft.ts'));
	});

	test('archiving a session removes its persisted editor state', async () => {
		using fixture = await createFixture();
		fixture.editor.set(workingSet('a', 'a.ts'));
		await fixture.open('b');
		fixture.catalog.remove('a');
		await fixture.controller.whenSettled();
		await fixture.storage.flush();
		assert.deepEqual(JSON.parse(fixture.storage.get(storageKey, StorageScope.WORKSPACE)!).map((entry: { sessionResource: string; }) => entry.sessionResource), ['session:b']);
	});

	test('draft materialization during restoration preserves the created identity for later saves', async () => {
		using fixture = await createFixture();
		const draft = fixture.sessions.openNewSession('Draft');
		await fixture.controller.whenSettled();
		fixture.editor.set(workingSet('draft', 'draft.ts'));
		await fixture.open('c');
		const pending = new DeferredPromise<void>();
		fixture.editor.started = new DeferredPromise<void>();
		fixture.editor.pending = pending.p;
		fixture.sessions.openUntitledSession(draft.untitledSessionId);
		await fixture.editor.started.p;
		fixture.catalog.promoteUntitledSession(draft.untitledSessionId, { session: fixture.catalog.sessions[1]!, threadId: 'b-thread' });
		await pending.complete();
		await fixture.controller.whenSettled();
		await fixture.open('a');
		await fixture.open('b');
		assert.deepEqual(fixture.editor.current, workingSet('session:b', 'draft.ts'));
	});

	test('reports a failed restore and allows the next session switch to complete', async () => {
		using fixture = await createFixture();
		const pending = new DeferredPromise<void>();
		fixture.editor.pending = pending.p;
		fixture.sessions.openSession('b', 'b-thread');
		await fixture.editor.started.p;
		await pending.error(new Error('Restore cancelled'));
		await fixture.controller.whenSettled();
		await fixture.open('c');
		assert.deepEqual({ errors: fixture.errors, current: fixture.editor.current }, { errors: ['Could not restore the editors for this session: Error: Restore cancelled'], current: 'empty' });
	});

	test('disposal stops queued restores and unregisters editor visibility automation', async () => {
		using fixture = await createFixture();
		const pending = new DeferredPromise<void>();
		fixture.editor.pending = pending.p;
		fixture.sessions.openSession('b', 'b-thread');
		await fixture.editor.started.p;
		fixture.sessions.openSession('c', 'c-thread');
		fixture.controller.dispose();
		await pending.complete();
		await fixture.controller.whenSettled();
		fixture.editor.set(workingSet('later', 'later.ts'));
		assert.deepEqual({ applied: fixture.editor.applied, visible: fixture.editorVisible }, { applied: ['empty'], visible: false });
	});

	test('reload waits for an in-flight editor restore before saving session state', async () => {
		using fixture = await createFixture([{ sessionResource: 'session:b', editorWorkingSet: workingSet('saved', 'b.ts') }]);
		const pending = new DeferredPromise<void>();
		fixture.editor.pending = pending.p;
		fixture.sessions.openSession('b', 'b-thread');
		await fixture.editor.started.p;
		const joining = new DeferredPromise<void>();
		using listener = fixture.lifecycle.onWillShutdown(() => { void joining.complete(); });
		let closed = false;
		const closing = fixture.lifecycle.shutdown('reload').then(() => { closed = true; });
		await joining.p;
		assert.equal(closed, false);
		await pending.complete();
		await closing;
		const saved = JSON.parse(fixture.storage.get(storageKey, StorageScope.WORKSPACE)!) as { sessionResource: string; editorWorkingSet: EditorWorkingSet; }[];
		assert.deepEqual(saved.find(entry => entry.sessionResource === 'session:b')?.editorWorkingSet, workingSet('session:b', 'b.ts'));
	});

	test('completed shutdown stops storage refreshes from capturing released editor state', async () => {
		using fixture = await createFixture();
		fixture.editor.set(workingSet('session:a', 'saved.ts'));
		await fixture.lifecycle.shutdown('pageHide');
		const saved = fixture.storage.get(storageKey, StorageScope.WORKSPACE);
		assert.equal(fixture.controller.isDisposed, true);
		fixture.editor.set(workingSet('session:a', 'after-shutdown.ts'));
		await fixture.storage.flush();
		assert.equal(fixture.storage.get(storageKey, StorageScope.WORKSPACE), saved);
	});

	test('required controller services are resolved by the production creation path', () => {
		using services = new InstantiationService();
		assert.throws(() => services.createInstance(DesktopLayoutController, 'pages', { isSessionContent: true, isDocumentContent: true, documentContent: observableValue('documents', true), isChangingContent: false, runOperation: async (operation: () => Promise<void>) => operation() }), /paneCompositePartService/);
	});
});

class TestEditors extends Disposable {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidVisibleEditorsChange = this.changed.event;
	public started = new DeferredPromise<void>();
	public current: EditorWorkingSetTarget = 'empty';
	public readonly applied: EditorWorkingSetTarget[] = [];
	public readonly options: { preserveFocus?: boolean; }[] = [];
	public pending: Promise<void> | undefined;
	public get visibleEditors(): readonly unknown[] {
		return this.current === 'empty' ? [] : this.current.groups.flatMap(group => group.editors);
	}
	public set(value: EditorWorkingSetTarget): void {
		this.current = value;
		this.changed.fire();
	}
	public saveWorkingSet(id: string): EditorWorkingSet {
		return this.current === 'empty' ? workingSet(id) : { ...this.current, id };
	}
	public async applyWorkingSet(value: EditorWorkingSetTarget, options: { preserveFocus?: boolean; }): Promise<void> {
		this.applied.push(value);
		this.options.push(options);
		this.set('empty');
		if (!this.started.isSettled) {
			await this.started.complete();
		}
		const pending = this.pending;
		this.pending = undefined;
		await pending;
		this.set(value);
	}
}

class TestCatalog extends Disposable {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	public readonly materializedSessions = observableValue<ReadonlyMap<string, { sessionId: string; threadId: string; }>>(this, new Map());
	public sessions: readonly ISession[] = ['a', 'b', 'c'].map(id => ({ sessionId: id, title: id, status: 'active', nextApprovalMode: 'manual', chats: [{ threadId: `${id}-thread`, status: 'active', origin: { type: 'root' } }] }));
	public untitledSessions: readonly IUntitledChatSession[] = [];
	public active: IActiveSessionThread | undefined = { session: this.sessions[0]!, threadId: 'a-thread' };
	public activeUntitledSession: IUntitledChatSession | undefined;
	public readonly state = 'ready';
	public readonly error = undefined;
	public directoryReady: Promise<void> | undefined;
	public async whenDirectoriesReady(signal?: AbortSignal): Promise<void> {
		if (this.directoryReady) { await (signal ? raceCancellationError(this.directoryReady, signal) : this.directoryReady); }
		if (this.sessions.some(session => session.chats.some(chat => chat.workspace === undefined))) {
			this.sessions = this.sessions.map(session => ({ ...session, chats: session.chats.map(chat => ({ ...chat, workspace: chat.workspace ?? null })) }));
			this.changed.fire();
		}
	}
	public async initialize(): Promise<void> { }
	public selectThread(sessionId: string, threadId: string): void {
		this.active = { session: this.sessions.find(session => session.sessionId === sessionId)!, threadId };
		this.activeUntitledSession = undefined;
		this.changed.fire();
	}
	public createUntitledSession(title: string): IUntitledChatSession {
		const draft: IUntitledChatSession = { untitledSessionId: `draft-${this.untitledSessions.length}`, title, workspace: { type: 'current' }, model: undefined, agent: undefined };
		this.untitledSessions = [...this.untitledSessions, draft];
		return draft;
	}
	public selectUntitledSession(id: string): void {
		this.activeUntitledSession = this.untitledSessions.find(draft => draft.untitledSessionId === id);
		this.changed.fire();
	}
	public promoteUntitledSession(id: string, active: IActiveSessionThread): void {
		this.materializedSessions.set(new Map([[id, { sessionId: active.session.sessionId, threadId: active.threadId }]]));
		this.untitledSessions = this.untitledSessions.filter(draft => draft.untitledSessionId !== id);
		this.activeUntitledSession = undefined;
		this.active = active;
		this.changed.fire();
	}
	public remove(id: string): void {
		this.sessions = this.sessions.filter(session => session.sessionId !== id);
		this.changed.fire();
	}
}

class LayoutFixture extends Disposable {
	public readonly configuration = this._register(new InMemoryConfigurationService());
	private readonly storageEnvironment = new JSDOM('', { url: 'https://sessions-layout.test' });
	public readonly services = this._register(new InstantiationService());
	public readonly storage = this._register(new BrowserStorageService({ ownerWindow: browserEnvironment.window as unknown as Window, workspaceId: 'sessions', backend: this.storageEnvironment.window.localStorage, flushInterval: 0 }));
	public readonly lifecycle = this._register(new TestLifecycle(undefined, new NullLoggerService(), this.storage));
	public readonly catalog = this._register(new TestCatalog());
	public readonly editor = this._register(new TestEditors());
	public readonly workspace = this._register(new TestWorkspaceService({ id: 'a', folders: [] }));
	public readonly errors: string[] = [];
	public readonly partsChanged = this._register(new Emitter<void>());
	public readonly panelOpened = this._register(new Emitter<string>());
	public panelVisible = false;
	public panelView: string | undefined;
	public sessionsVisible = true;
	public editorVisible = false;
	public auxiliaryVisible = false;
	public followWorkspace = true;
	public readonly sessions: SessionsService;
	public readonly controller: WorkingSetController;
	constructor(saved?: readonly unknown[]) {
		super();
		this._register(toDisposable(() => this.storageEnvironment.window.close()));
		if (saved) {
			this.storage.store(storageKey, JSON.stringify(saved), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}
		this.services.registerInstance(IStorageService, this.storage);
		this.services.registerInstance(IConfigurationService, this.configuration);
		this.services.registerInstance(ILifecycleService, this.lifecycle);
		this.services.registerInstance(ISessionsManagementService, this.catalog as unknown as ISessionsManagementService);
		this.services.registerInstance(ICustomViewService, this._register(new CustomViewService(new NullLoggerService(), this.storage)));
		this.sessions = this._register(this.services.createInstance(SessionsService));
		this.services.registerInstance(ISessionsService, this.sessions);
		this.services.registerInstance(IEditorPart, this.editor as unknown as import('../../../../../workbench/browser/parts/editor/editorPart.js').IEditorPart);
		this.services.registerInstance(IEditorService, this.editor as unknown as IEditorService);
		this.services.registerInstance(IWorkspaceContextService, this.workspace);
		this.services.registerInstance(ILayoutService, {
			onDidChangePartVisibility: this.partsChanged.event,
			isPartVisible: (part: string) => part === 'sessions' ? this.sessionsVisible : part === 'panel' ? this.panelVisible : part === 'auxiliarybar' ? this.auxiliaryVisible : this.editorVisible,
			showPart: (part: string) => { if (part === 'auxiliarybar') { this.auxiliaryVisible = true; } else { this.editorVisible = true; } },
			hidePart: (part: string) => { if (part === 'auxiliarybar') { this.auxiliaryVisible = false; } else { this.editorVisible = false; } },
		} as unknown as ILayoutService);
		this.services.registerInstance(INotificationService, { error: (message: string) => this.errors.push(message) } as unknown as INotificationService);
		this._register(this.sessions.onDidChange(() => {
			const selected = this.sessions.activeSelection;
			if (this.followWorkspace && selected?.kind === 'session') {
				this.workspace.updateWorkspace({ id: selected.active.session.sessionId, folders: [] });
			}
		}));
		this.services.registerInstance(IPaneCompositePartService, {
			onDidPaneCompositeOpen: listener => this.panelOpened.event(id => listener({ composite: { id } as import('../../../../../workbench/browser/parts/views/paneComposite.js').PaneComposite, viewContainerLocation: ViewContainerLocation.Panel })),
			onDidPaneCompositeClose: Event.None,
			getActivePaneComposite: () => undefined,
			getPartId: () => 'panel',
			hideActivePaneComposite: () => { this.panelVisible = false; },
			getLastActivePaneCompositeId: () => this.panelView,
			openPaneComposite: async (id: string | undefined) => {
				if (id !== undefined && id !== this.panelView) {
					this.panelView = id;
					this.panelOpened.fire(id);
				}
				return undefined;
			},
		});
		this.controller = this._register(this.services.createInstance(WorkingSetController));
	}
	public async open(id: string): Promise<void> {
		this.sessions.openSession(id, `${id}-thread`);
		await this.controller.whenSettled();
	}
}

async function createFixture(saved?: readonly unknown[]): Promise<LayoutFixture> {
	const fixture = new LayoutFixture(saved);
	await fixture.sessions.initialize();
	fixture.sessions.openSession('a', 'a-thread');
	fixture.lifecycle.phase = LifecyclePhase.Restored;
	fixture.controller.start();
	await fixture.controller.whenSettled();
	return fixture;
}

class TestLifecycle extends AbstractLifecycleService { }

function workingSet(id: string, file?: string): EditorWorkingSet {
	return { id, activeGroupIndex: 0, groups: [{ editors: file ? [{ input: { typeId: 'workbench.editorInput.resource', value: { resource: `file:///${file}` } }, preview: false }] : [], activeEditorIndex: file ? 0 : -1, size: 1 }] };
}
