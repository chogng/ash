import assert from "node:assert/strict";
import { test } from "mocha";
import { Emitter } from "../../../base/common/event.js";
import type { ApprovalMode, IActiveSessionThread, ISession, IUntitledChatSession, ModelRef, SessionId, ThreadId } from "../../services/sessions/common/session.js";
import type { ISessionsManagementService, SessionsManagementState } from "../../services/sessions/common/sessionsManagementService.js";
import { SessionsService } from "../../../sessions/services/view/browser/sessionsService.js";
import type { SessionsViewSelection } from "../../../sessions/services/view/common/sessionsService.js";

test("Sessions view service owns multi-session visibility and Back/Forward navigation", async () => {
	using sessions = new FakeSessionService([session("session-1", "thread-1"), session("session-2", "thread-2")]);
	using view = new SessionsService(sessions);

	await view.initialize();
	assert.deepEqual(view.visibleSelections.map(selectionId), ["session:session-1:thread-1"]);

	view.openSession("session-2", "thread-2");
	assert.deepEqual(view.visibleSelections.map(selectionId), ["session:session-1:thread-1", "session:session-2:thread-2"]);
	assert.equal(view.canNavigateBack, true);
	assert.equal(view.canNavigateForward, false);

	let projectedNavigation: readonly [boolean, boolean] | undefined;
	using navigationListener = view.onDidChange(() => {
		projectedNavigation = [view.canNavigateBack, view.canNavigateForward];
	});
	view.navigateBack();
	assert.equal(selectionId(view.activeSelection), "session:session-1:thread-1");
	assert.deepEqual(view.visibleSelections.map(selectionId), ["session:session-1:thread-1", "session:session-2:thread-2"]);
	assert.equal(view.canNavigateForward, true);
	assert.deepEqual(projectedNavigation, [false, true]);

	view.navigateForward();
	assert.equal(selectionId(view.activeSelection), "session:session-2:thread-2");

	view.closeVisibleSelection(view.visibleSelections[0]!);
	assert.deepEqual(view.visibleSelections.map(selectionId), ["session:session-2:thread-2"]);
});

test("Sessions view navigation skips references that are no longer available", async () => {
	using sessions = new FakeSessionService([session("session-1", "thread-1"), session("session-2", "thread-2")]);
	using view = new SessionsService(sessions);
	await view.initialize();
	view.openSession("session-2", "thread-2");

	sessions.removeSession("session-1");

	assert.equal(view.canNavigateBack, false);
	view.navigateBack();
	assert.equal(selectionId(view.activeSelection), "session:session-2:thread-2");
});

test("Sessions view records window-local untitled sessions without creating durable state", async () => {
	using sessions = new FakeSessionService([]);
	using view = new SessionsService(sessions);
	await view.initialize();

	const draft = view.openNewSession("Draft task");

	assert.equal(selectionId(view.activeSelection), `untitled:${draft.untitledSessionId}`);
	assert.equal(sessions.startNewSessionCalls, 0);
});

test("Sessions view replaces a visible draft when it materializes", async () => {
	using sessions = new FakeSessionService([]);
	using view = new SessionsService(sessions);
	await view.initialize();
	const draft = view.openNewSession("Draft task");

	const active = await sessions.materializeUntitledSession(draft.untitledSessionId);
	sessions.promoteUntitledSession(draft.untitledSessionId, active);

	assert.deepEqual(view.visibleSelections.map(selectionId), ["session:materialized-1:materialized-thread-1"]);
	assert.equal(selectionId(view.activeSelection), "session:materialized-1:materialized-thread-1");
});

test("closing the last draft does not reopen a previously closed durable Session", async () => {
	using sessions = new FakeSessionService([session("session-1", "thread-1")]);
	using view = new SessionsService(sessions);
	await view.initialize();
	const draft = view.openNewSession("Draft task");
	view.closeVisibleSelection(view.visibleSelections.find(selection => selection.kind === "session")!);

	view.closeVisibleSelection(view.visibleSelections.find(selection => selection.kind === "untitled" && selection.session.untitledSessionId === draft.untitledSessionId)!);

	assert.equal(view.visibleSelections.length, 1);
	assert.equal(view.visibleSelections[0]?.kind, "untitled");
	assert.notEqual(selectionId(view.visibleSelections[0]), `untitled:${draft.untitledSessionId}`);
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

	selectThread(sessionId: SessionId, threadId: ThreadId): void {
		const session = this._sessions.find(candidate => candidate.sessionId === sessionId);
		if (!session?.chats.some(thread => thread.threadId === threadId)) throw new Error("Thread unavailable");
		this._active = { session, threadId };
		this.activeUntitledSessionId = undefined;
		this._onDidChange.fire();
	}
	async interruptThread(): Promise<void> {}

	createUntitledSession(title = "New session"): IUntitledChatSession {
		const draft = { untitledSessionId: `untitled-${this.nextUntitledId++}`, title, model: undefined };
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

	discardUntitledSession(untitledSessionId: string): void {
		this._untitledSessions = this._untitledSessions.filter(session => session.untitledSessionId !== untitledSessionId);
		if (this.activeUntitledSessionId === untitledSessionId) this.activeUntitledSessionId = undefined;
		this._onDidChange.fire();
	}

	setUntitledSessionModel(_untitledSessionId: string, _model: ModelRef): void {}
	async materializeUntitledSession(_untitledSessionId: string): Promise<IActiveSessionThread> {
		const id = this.nextMaterializedId++;
		const durable = session(`materialized-${id}`, `materialized-thread-${id}`);
		return { session: durable, threadId: durable.chats[0]!.threadId };
	}
	promoteUntitledSession(untitledSessionId: string, active: IActiveSessionThread): void {
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
