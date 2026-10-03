import { observableValue } from '../../../base/common/observable.js';
import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from 'jsdom';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../workbench/services/storage/browser/storageService.js';
import { Emitter } from "../../../base/common/event.js";
import { DeferredPromise } from "../../../base/common/async.js";
import type { ApprovalMode, IActiveSessionThread, ISession, IUntitledChatSession, ModelRef, SessionId, ThreadId } from "../../services/sessions/common/session.js";
import { ISessionsManagementService, type SessionsManagementState } from "../../services/sessions/common/sessionsManagement.js";
import { SessionsService } from "../../../sessions/services/sessions/browser/sessionsService.js";
import type { SessionsViewSelection } from "../../../sessions/services/sessions/browser/sessionsService.js";

const storageEnvironment = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
let storageSequence = 0;
suiteTeardown(() => storageEnvironment.window.close());

function createTestStorage(): BrowserStorageService {
	return new BrowserStorageService({ ownerWindow: storageEnvironment.window as unknown as Window, applicationId: `view-test-${++storageSequence}`, workspaceId: 'sessions', flushInterval: 0 });
}

function createView(sessions: ISessionsManagementService, storage: IStorageService): SessionsService {
	using services = new InstantiationService();
	services.registerInstance(ISessionsManagementService, sessions);
	services.registerInstance(IStorageService, storage);
	return services.createInstance(SessionsService);
}

test("Sessions view service replaces the page on open and Back/Forward navigation", async () => {
	using sessions = new FakeSessionService([session("session-1", "thread-1"), session("session-2", "thread-2")]);
	using storage = createTestStorage();
	using view = createView(sessions, storage);

	await view.initialize();
	assert.deepEqual(view.visibleSelections.map(selectionId), ["session:session-1:thread-1"]);

	view.openSession("session-2", "thread-2");
	assert.deepEqual(view.visibleSelections.map(selectionId), ["session:session-2:thread-2"]);
	assert.equal(view.canNavigateBack, true);
	assert.equal(view.canNavigateForward, false);

	let projectedNavigation: readonly [boolean, boolean] | undefined;
	using navigationListener = view.onDidChange(() => {
		projectedNavigation = [view.canNavigateBack, view.canNavigateForward];
	});
	view.navigateBack();
	assert.equal(selectionId(view.activeSelection), "session:session-1:thread-1");
	assert.deepEqual(view.visibleSelections.map(selectionId), ["session:session-1:thread-1"]);
	assert.equal(view.canNavigateForward, true);
	assert.deepEqual(projectedNavigation, [false, true]);

	view.navigateForward();
	assert.equal(selectionId(view.activeSelection), "session:session-2:thread-2");

	assert.deepEqual(view.visibleSelections.map(selectionId), ["session:session-2:thread-2"]);
});

test("Sessions view navigation skips references that are no longer available", async () => {
	using sessions = new FakeSessionService([session("session-1", "thread-1"), session("session-2", "thread-2")]);
	using storage = createTestStorage();
	using view = createView(sessions, storage);
	await view.initialize();
	view.openSession("session-2", "thread-2");

	sessions.removeSession("session-1");

	assert.equal(view.canNavigateBack, false);
	view.navigateBack();
	assert.equal(selectionId(view.activeSelection), "session:session-2:thread-2");
});

test("Sessions view records window-local untitled sessions without creating durable state", async () => {
	using sessions = new FakeSessionService([]);
	using storage = createTestStorage();
	using view = createView(sessions, storage);
	await view.initialize();

	const draft = view.openNewSession("Draft task");

	assert.equal(selectionId(view.activeSelection), `untitled:${draft.untitledSessionId}`);
	assert.equal(sessions.startNewSessionCalls, 0);
});

test('new Sessions replace a restored split across the entire page and leave the other page intact', async () => {
	using sessions = new FakeSessionService([session('session-1', 'thread-1'), session('session-2', 'thread-2')]);
	using storage = createTestStorage();
	const visible = sessions.sessions.map(session => ({ kind: 'session', sessionId: session.sessionId, threadId: session.chats[0]!.threadId }));
	storage.store('sessions.viewState', JSON.stringify({ version: 1, pages: { chat: { visible, active: 0 }, code: { visible: [visible[1]], active: 0 } } }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	using view = createView(sessions, storage);
	await view.initialize();
	view.activateSelection(view.visibleSelections[1]!);
	assert.equal(view.visibleSelections.length, 2);

	const first = view.openNewSession('First draft');
	const second = view.openNewSession('Second draft');
	assert.deepEqual({ chat: view.visibleSelections.map(selectionId), code: view.getPageSelection('code').visibleSelections.map(selectionId) }, {
		chat: [`untitled:${second.untitledSessionId}`], code: ['session:session-2:thread-2'],
	});
	view.navigateBack();
	assert.deepEqual(view.visibleSelections.map(selectionId), [`untitled:${first.untitledSessionId}`]);
	view.navigateForward();
	assert.deepEqual(view.visibleSelections.map(selectionId), [`untitled:${second.untitledSessionId}`]);
});

for (const target of ['active', 'inactive', 'untitled'] as const) {
	test(`opening the ${target} Session from a restored split shows only its content`, async () => {
		using sessions = new FakeSessionService([session('session-1', 'thread-1'), session('session-2', 'thread-2')]);
		using storage = createTestStorage();
		const visible = [
			{ kind: 'session', sessionId: 'session-1', threadId: 'thread-1' },
			{ kind: 'session', sessionId: 'session-2', threadId: 'thread-2' },
			{ kind: 'untitled', session: { untitledSessionId: 'saved-draft', title: 'Draft', workspace: { type: 'current' } } },
		];
		storage.store('sessions.viewState', JSON.stringify({ version: 1, pages: {
			chat: { visible, active: 0 }, code: { visible: [visible[1]], active: 0 },
		} }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		using view = createView(sessions, storage);
		await view.initialize();
		assert.equal(view.visibleSelections.length, 3);

		if (target === 'untitled') {
			view.openUntitledSession('saved-draft');
		} else {
			const index = target === 'active' ? 1 : 2;
			view.openSession(`session-${index}`, `thread-${index}`);
		}

		const expected = {
			active: 'session:session-1:thread-1',
			inactive: 'session:session-2:thread-2',
			untitled: 'untitled:saved-draft',
		}[target];
		assert.deepEqual({ visible: view.visibleSelections.map(selectionId), active: selectionId(view.activeSelection), code: view.getPageSelection('code').visibleSelections.map(selectionId) }, {
			visible: [expected], active: expected, code: ['session:session-2:thread-2'],
		});
	});
}

test('pane focus and closing a pane preserve the remaining split while history navigation shows one Session', async () => {
	using sessions = new FakeSessionService([session('session-1', 'thread-1'), session('session-2', 'thread-2'), session('session-3', 'thread-3')]);
	using storage = createTestStorage();
	const visible = sessions.sessions.map(session => ({ kind: 'session', sessionId: session.sessionId, threadId: session.chats[0]!.threadId }));
	storage.store('sessions.viewState', JSON.stringify({ version: 1, pages: {
		chat: { visible, active: 0 }, code: { visible: [], active: -1 },
	} }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	using view = createView(sessions, storage);
	await view.initialize();
	view.activateSelection(view.visibleSelections[1]!);
	assert.equal(view.visibleSelections.length, 3);
	view.closeVisibleSelection(view.activeSelection!);
	assert.deepEqual({ visible: view.visibleSelections.map(selectionId), active: selectionId(view.activeSelection) }, {
		visible: ['session:session-1:thread-1', 'session:session-3:thread-3'], active: 'session:session-3:thread-3',
	});
	view.navigateBack();
	assert.deepEqual(view.visibleSelections.map(selectionId), ['session:session-2:thread-2']);
});

test("Sessions view replaces a visible draft when it materializes", async () => {
	using sessions = new FakeSessionService([]);
	using storage = createTestStorage();
	using view = createView(sessions, storage);
	await view.initialize();
	const draft = view.openNewSession("Draft task");

	const active = await sessions.materializeUntitledSession(draft.untitledSessionId);
	sessions.promoteUntitledSession(draft.untitledSessionId, active);

	assert.deepEqual(view.visibleSelections.map(selectionId), ["session:materialized-1:materialized-thread-1"]);
	assert.equal(selectionId(view.activeSelection), "session:materialized-1:materialized-thread-1");
});

test("closing the last draft does not reopen a previously closed durable Session", async () => {
	using sessions = new FakeSessionService([session("session-1", "thread-1")]);
	using storage = createTestStorage();
	using view = createView(sessions, storage);
	await view.initialize();
	const draft = view.openNewSession("Draft task");

	view.closeVisibleSelection(view.visibleSelections.find(selection => selection.kind === "untitled" && selection.session.untitledSessionId === draft.untitledSessionId)!);

	assert.equal(view.visibleSelections.length, 1);
	assert.equal(view.visibleSelections[0]?.kind, "untitled");
	assert.notEqual(selectionId(view.visibleSelections[0]), `untitled:${draft.untitledSessionId}`);
});

test('switching pages during catalog loading keeps independently created drafts', async () => {
	const pending = new DeferredPromise<void>();
	using sessions = new class extends FakeSessionService {
		override initialize(): Promise<void> { return pending.p; }
	}([]);
	using storage = createTestStorage();
	using view = createView(sessions, storage);
	const initializing = view.initialize();
	view.selectPage('code');
	const codeDraft = selectionId(view.activeSelection);
	view.selectPage('chat');
	const chatDraft = selectionId(view.activeSelection);
	await pending.complete();
	await initializing;
	assert.notEqual(chatDraft, codeDraft);
	assert.deepEqual(['chat', 'code'].map(page => view.getPageSelection(page as 'chat' | 'code').visibleSelections.map(selectionId)), [[chatDraft], [codeDraft]]);
});

test('Chat and Code keep their own active session, visible sessions, and navigation history', async () => {
	using sessions = new FakeSessionService([session('session-1', 'thread-1'), session('session-2', 'thread-2')]);
	using storage = createTestStorage();
	using view = createView(sessions, storage);
	await view.initialize();
	const chatDraft = view.openNewSession('Chat draft');
	view.selectPage('code');
	const codeDraft = view.activeSelection!;
	view.openSession('session-2', 'thread-2');
	view.navigateBack();
	assert.deepEqual(view.getPageSelection('chat').visibleSelections.map(selectionId), [`untitled:${chatDraft.untitledSessionId}`]);
	assert.equal(selectionId(view.activeSelection), selectionId(codeDraft));
	assert.equal(view.canNavigateForward, true);
	view.selectPage('chat');
	assert.equal(selectionId(view.activeSelection), `untitled:${chatDraft.untitledSessionId}`);
	assert.equal(view.canNavigateForward, false);
	view.navigateBack();
	assert.equal(selectionId(view.activeSelection), 'session:session-1:thread-1');
	view.selectPage('code');
	view.navigateForward();
	assert.equal(selectionId(view.activeSelection), 'session:session-2:thread-2');
});

test('background first send replaces only its originating page and preserves later selection', async () => {
	using sessions = new FakeSessionService([]);
	using storage = createTestStorage();
	using view = createView(sessions, storage);
	await view.initialize();
	const chatDraft = view.openNewSession('Chat draft');
	view.selectPage('code');
	const pending = view.activeSelection!;
	if (pending.kind !== 'untitled') throw new Error('Expected draft');
	const later = view.openNewSession('Later Code draft');
	view.selectPage('chat');
	const active = await sessions.materializeUntitledSession(pending.session.untitledSessionId);
	sessions.promoteUntitledSession(pending.session.untitledSessionId, active);
	assert.equal(selectionId(view.activeSelection), `untitled:${chatDraft.untitledSessionId}`);
	assert.deepEqual(view.getPageSelection('code').visibleSelections.map(selectionId), [`untitled:${later.untitledSessionId}`]);
	view.selectPage('code');
	assert.equal(selectionId(view.activeSelection), `untitled:${later.untitledSessionId}`);
	view.navigateBack();
	assert.equal(selectionId(view.activeSelection), 'session:materialized-1:materialized-thread-1');
});

test('an asynchronous conversation open stays with the page that requested it', async () => {
	const pending = new DeferredPromise<void>();
	using sessions = new class extends FakeSessionService {
		override async openThread(sessionId: SessionId, threadId: ThreadId): Promise<void> {
			await pending.p;
			await super.openThread(sessionId, threadId);
		}
	}([session('session-1', 'thread-1'), session('session-2', 'thread-2')]);
	using storage = createTestStorage();
	using view = createView(sessions, storage);
	await view.initialize();
	view.selectPage('code');
	const opening = view.openThread('session-2', 'thread-2');
	view.selectPage('chat');
	await pending.complete();
	await opening;
	assert.equal(selectionId(view.activeSelection), 'session:session-1:thread-1');
	assert.equal(selectionId(view.getPageSelection('code').activeSelection), 'session:session-2:thread-2');
});

test('closing Code drafts and catalog selection do not change Chat selection', async () => {
	using sessions = new FakeSessionService([session('session-1', 'thread-1'), session('session-2', 'thread-2')]);
	using storage = createTestStorage();
	using view = createView(sessions, storage);
	await view.initialize();
	view.selectPage('code');
	view.closeVisibleSelection(view.activeSelection!);
	assert.equal(view.activeSelection?.kind, 'untitled');
	sessions.selectThread('session-2', 'thread-2');
	assert.equal(selectionId(view.getPageSelection('chat').activeSelection), 'session:session-1:thread-1');
	assert.equal(view.activeSelection?.kind, 'untitled');
	view.openSession('session-1', 'thread-1');
	view.closeVisibleSelection(view.activeSelection!);
	assert.equal(selectionId(view.getPageSelection('chat').activeSelection), 'session:session-1:thread-1');
});

test('Sessions restores each page order, active selection and untitled identity after restart', async () => {
	using storage = createTestStorage();
	using sessions = new FakeSessionService([session('session-1', 'thread-1'), session('session-2', 'thread-2')]);
	const chatDraft = { kind: 'untitled', session: { untitledSessionId: 'saved-chat', title: 'Chat draft', workspace: { type: 'current' } } };
	const firstCode = { kind: 'untitled', session: { untitledSessionId: 'saved-code-first', title: 'New code session', workspace: { type: 'current' } } };
	const secondCode = { kind: 'untitled', session: { untitledSessionId: 'saved-code-second', title: 'Second Code draft', workspace: { type: 'current' } } };
	storage.store('sessions.viewState', JSON.stringify({ version: 1, pages: {
		chat: { visible: [{ kind: 'session', sessionId: 'session-1', threadId: 'thread-1' }, chatDraft, { kind: 'session', sessionId: 'session-2', threadId: 'thread-2' }], active: 1 },
		code: { visible: [firstCode, { kind: 'session', sessionId: 'session-2', threadId: 'thread-2' }, secondCode], active: 0 },
	} }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	using view = createView(sessions, storage);
	await view.initialize();
	view.selectPage('code');
	view.activateSelection(view.visibleSelections[0]!);
	const expected = ['chat', 'code'].map(page => {
		const state = view.getPageSelection(page as 'chat' | 'code');
		return { visible: state.visibleSelections.map(selectionId), active: selectionId(state.activeSelection) };
	});
	await storage.flush();
	using nextCatalog = new FakeSessionService([session('session-2', 'thread-2'), session('session-1', 'thread-1')]);
	using restored = createView(nextCatalog, storage);
	await restored.initialize();
	assert.deepEqual(['chat', 'code'].map(page => {
		const state = restored.getPageSelection(page as 'chat' | 'code');
		return { visible: state.visibleSelections.map(selectionId), active: selectionId(state.activeSelection) };
	}), expected);
	assert.deepEqual(nextCatalog.untitledSessions.map(draft => draft.title).sort(), ['Chat draft', 'New code session', 'Second Code draft']);
});

test('Sessions restoration prunes unavailable conversations and persists materialized identities', async () => {
	using storage = createTestStorage();
	using sessions = new FakeSessionService([session('session-1', 'thread-1'), session('session-2', 'thread-2')]);
	const draft = { untitledSessionId: 'saved-draft', title: 'Send this', workspace: { type: 'current' as const } };
	storage.store('sessions.viewState', JSON.stringify({ version: 1, pages: {
		chat: { visible: [{ kind: 'session', sessionId: 'session-1', threadId: 'thread-1' }, { kind: 'session', sessionId: 'session-2', threadId: 'thread-2' }, { kind: 'untitled', session: draft }], active: 2 },
		code: { visible: [], active: -1 },
	} }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	using view = createView(sessions, storage);
	await view.initialize();
	const materialized = await sessions.materializeUntitledSession(draft.untitledSessionId);
	sessions.promoteUntitledSession(draft.untitledSessionId, materialized);
	await storage.flush();
	using nextCatalog = new FakeSessionService([session('session-1', 'thread-1'), materialized.session]);
	using restored = createView(nextCatalog, storage);
	await restored.initialize();
	assert.deepEqual({ visible: restored.visibleSelections.map(selectionId), active: selectionId(restored.activeSelection), drafts: nextCatalog.untitledSessions }, {
		visible: ['session:session-1:thread-1', 'session:materialized-1:materialized-thread-1'], active: 'session:materialized-1:materialized-thread-1', drafts: [],
	});
});

test('a page choice during catalog loading supersedes saved selection without discarding the other page', async () => {
	using storage = createTestStorage();
	using sessions = new FakeSessionService([]);
	using view = createView(sessions, storage);
	await view.initialize();
	view.openNewSession('Saved Chat');
	view.selectPage('code');
	const savedCode = view.openNewSession('Saved Code');
	await storage.flush();
	const pending = new DeferredPromise<void>();
	using nextCatalog = new class extends FakeSessionService {
		override initialize(): Promise<void> { return pending.p; }
	}([]);
	using restored = createView(nextCatalog, storage);
	const initializing = restored.initialize();
	const choice = restored.openNewSession('Chosen during startup');
	const savedRaw = storage.get('sessions.viewState', StorageScope.WORKSPACE);
	await storage.flush();
	assert.equal(storage.get('sessions.viewState', StorageScope.WORKSPACE), savedRaw);
	await pending.complete();
	await initializing;
	assert.deepEqual({ chat: restored.getPageSelection('chat').visibleSelections.map(selection => selection.kind === 'untitled' ? selection.session.title : selection.active.session.title), code: restored.getPageSelection('code').visibleSelections.map(selectionId), active: selectionId(restored.activeSelection) }, {
		chat: ['Chosen during startup'], code: [`untitled:${savedCode.untitledSessionId}`], active: `untitled:${choice.untitledSessionId}`,
	});
});

test('invalid persisted Sessions arrangements are rejected at service creation', () => {
	using storage = createTestStorage();
	using sessions = new FakeSessionService([]);
	for (const visible of [[{ kind: 'session', sessionId: '', threadId: 'thread' }], [{ kind: 'untitled', session: { untitledSessionId: 'draft', title: 'Draft', workspace: { type: 'ssh', root: '/workspace' } } }]]) {
		storage.store('sessions.viewState', JSON.stringify({ version: 1, pages: { chat: { visible, active: 0 }, code: { visible: [], active: -1 } } }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		assert.throws(() => createView(sessions, storage), /Invalid stored/);
	}
});

test('an unavailable catalog restores local drafts and preserves unresolved conversation references', async () => {
	using storage = createTestStorage();
	using sessions = new FakeSessionService([session('session-1', 'thread-1')]);
	const draft = { untitledSessionId: 'saved-local-draft', title: 'Local draft', workspace: { type: 'current' as const } };
	storage.store('sessions.viewState', JSON.stringify({ version: 1, pages: {
		chat: { visible: [{ kind: 'session', sessionId: 'session-1', threadId: 'thread-1' }, { kind: 'untitled', session: draft }], active: 1 },
		code: { visible: [], active: -1 },
	} }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	using view = createView(sessions, storage);
	await view.initialize();
	await storage.flush();
	using disconnected = new class extends FakeSessionService {
		override readonly state: SessionsManagementState = 'error';
	}([]);
	using restored = createView(disconnected, storage);
	await restored.initialize();
	assert.deepEqual(restored.visibleSelections.map(selectionId), [`untitled:${draft.untitledSessionId}`]);
	await storage.flush();
	const saved = JSON.parse(storage.get('sessions.viewState', StorageScope.WORKSPACE)!);
	assert.deepEqual(saved.pages.chat.visible.map((reference: { kind: string; sessionId?: string; session?: IUntitledChatSession }) => reference.kind === 'session' ? reference.sessionId : reference.session!.untitledSessionId), ['session-1', draft.untitledSessionId]);
	assert.doesNotThrow(() => restored.closeVisibleSelection(restored.activeSelection!));
	assert.equal(restored.activeSelection?.kind, 'untitled');
});

class FakeSessionService implements ISessionsManagementService {
	private readonly _onDidChange = new Emitter<void>();
	private _sessions: readonly ISession[];
	private _active: IActiveSessionThread | undefined;
	private _untitledSessions: readonly IUntitledChatSession[] = [];
	private activeUntitledSessionId: string | undefined;
	private nextUntitledId = 1;
	private nextMaterializedId = 1;

	readonly onDidChange = this._onDidChange.event;
	readonly materializedSessions = observableValue<ReadonlyMap<string, { readonly sessionId: SessionId; readonly threadId: ThreadId }>>(this, new Map());
	readonly state: SessionsManagementState = "ready";
	readonly error = undefined;
	startNewSessionCalls = 0;

	constructor(sessions: readonly ISession[]) {
		this._sessions = sessions;
		const first = sessions[0];
		const thread = first?.chats[0];
		this._active = first && thread ? { session: first, threadId: thread.threadId } : undefined;
	}

	get sessions(): readonly ISession[] { return this._sessions; }
	get active(): IActiveSessionThread | undefined { return this._active; }
	get untitledSessions(): readonly IUntitledChatSession[] { return this._untitledSessions; }
	get activeUntitledSession(): IUntitledChatSession | undefined { return this._untitledSessions.find(session => session.untitledSessionId === this.activeUntitledSessionId); }

	async initialize(): Promise<void> {}
	async listAgents(): Promise<readonly import('../../../workbench/services/chat/common/chatService.js').ChatAgent[]> { return []; }
	async openThread(sessionId: SessionId, threadId: ThreadId): Promise<void> { this.selectThread(sessionId, threadId); }

	selectThread(sessionId: SessionId, threadId: ThreadId): void {
		const session = this._sessions.find(candidate => candidate.sessionId === sessionId);
		if (!session?.chats.some(thread => thread.threadId === threadId)) throw new Error("Thread unavailable");
		this._active = { session, threadId };
		this.activeUntitledSessionId = undefined;
		this._onDidChange.fire();
	}
	async interruptThread(): Promise<void> {}

	createUntitledSession(title = "New session"): IUntitledChatSession {
		const draft = { untitledSessionId: `untitled-${this.nextUntitledId++}`, title, model: undefined, agent: undefined, workspace: { type: 'current' as const } };
		this._untitledSessions = [draft, ...this._untitledSessions];
		this.activeUntitledSessionId = draft.untitledSessionId;
		this._onDidChange.fire();
		return draft;
	}

	selectUntitledSession(untitledSessionId: string): void {
		if (!this._untitledSessions.some(session => session.untitledSessionId === untitledSessionId)) throw new Error("Draft unavailable");
		this.activeUntitledSessionId = untitledSessionId;
		this._onDidChange.fire();
	}

	restoreUntitledSession(session: IUntitledChatSession): void {
		this._untitledSessions = [session, ...this._untitledSessions];
		this._onDidChange.fire();
	}

	discardUntitledSession(untitledSessionId: string): void {
		this._untitledSessions = this._untitledSessions.filter(session => session.untitledSessionId !== untitledSessionId);
		if (this.activeUntitledSessionId === untitledSessionId) this.activeUntitledSessionId = undefined;
		this._onDidChange.fire();
	}

	setUntitledSessionModel(_untitledSessionId: string, _model: ModelRef): void {}
	setUntitledSessionDefaultModel(_untitledSessionId: string, _model: ModelRef | undefined): void {}
	setUntitledSessionAgent(_untitledSessionId: string, _agent: import('../../../workbench/services/chat/common/chatService.js').ChatAgent | undefined): void {}
	async materializeUntitledSession(_untitledSessionId: string): Promise<IActiveSessionThread> {
		const id = this.nextMaterializedId++;
		const durable = session(`materialized-${id}`, `materialized-thread-${id}`);
		return { session: durable, threadId: durable.chats[0]!.threadId };
	}
	promoteUntitledSession(untitledSessionId: string, active: IActiveSessionThread): void {
		this.materializedSessions.set(new Map([...this.materializedSessions.get(), [untitledSessionId, { sessionId: active.session.sessionId, threadId: active.threadId }]]));
		this._untitledSessions = this._untitledSessions.filter(session => session.untitledSessionId !== untitledSessionId);
		this._sessions = [active.session, ...this._sessions];
		this._active = active;
		if (this.activeUntitledSessionId === untitledSessionId) this.activeUntitledSessionId = undefined;
		this._onDidChange.fire();
	}
	async ensureActiveThread(): Promise<IActiveSessionThread> { throw new Error("Not implemented"); }
	async startNewSession(): Promise<IActiveSessionThread> { this.startNewSessionCalls++; throw new Error("Not implemented"); }
	async stopSession(): Promise<void> {}
	async archiveSession(): Promise<void> {}
	async setModel(): Promise<void> {}
	async setNextApprovalMode(_sessionId: SessionId, _approvalMode: ApprovalMode): Promise<void> {}

	removeSession(sessionId: SessionId): void {
		this._sessions = this._sessions.filter(session => session.sessionId !== sessionId);
		if (this._active?.session.sessionId === sessionId) this._active = undefined;
		this._onDidChange.fire();
	}

	dispose(): void { this._onDidChange.dispose(); }
	[Symbol.dispose](): void { this.dispose(); }
}

function session(sessionId: SessionId, threadId: ThreadId): ISession {
	return {
		sessionId,
		title: sessionId,
		status: "active",
		nextApprovalMode: "askPermissions",
		chats: [{ threadId, origin: { type: "root" }, status: "active" }],
	};
}

function selectionId(selection: SessionsViewSelection | undefined): string {
	if (!selection) return "none";
	return selection.kind === "session"
		? `session:${selection.active.session.sessionId}:${selection.active.threadId}`
		: `untitled:${selection.session.untitledSessionId}`;
}
