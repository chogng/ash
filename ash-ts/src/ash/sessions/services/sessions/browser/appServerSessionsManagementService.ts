import { Emitter } from "../../../../base/common/event.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { createUuid } from "../../../../base/common/uuid.js";
import type { IActiveSessionThread, IUntitledChatSession, ISession, ModelRef, SessionId, ThreadId } from "../common/session.js";
import type { ISessionsManagementService, SessionsManagementState } from "../common/sessionsManagementService.js";
import type { ISessionsProvider } from "../common/sessionsProvider.js";

/** Owns the frontend Session catalog and drafts; backend details remain in the provider. */
export class AppServerSessionsManagementService extends Disposable implements ISessionsManagementService {
	private readonly _onDidChange = this._register(new Emitter<void>());
	private _sessions: readonly ISession[] = [];
	private _active: IActiveSessionThread | undefined;
	private _untitledSessions: readonly IUntitledChatSession[] = [];
	private _activeUntitledSessionId: string | undefined;
	private _state: SessionsManagementState = "loading";
	private _error: string | undefined;
	private initializePromise: Promise<void> | undefined;
	private readonly pendingRefreshes = new Set<SessionId>();
	private readonly refreshes = new Map<SessionId, Promise<void>>();

	readonly onDidChange = this._onDidChange.event;

	constructor(private readonly provider: ISessionsProvider) {
		super();
		this._register(provider);
		this._register(provider.onDidChangeSession(sessionId => {
			this.pendingRefreshes.add(sessionId);
			this.scheduleRefresh(sessionId);
		}));
	}

	get sessions(): readonly ISession[] { return this._sessions; }
	get active(): IActiveSessionThread | undefined { return this._active; }
	get untitledSessions(): readonly IUntitledChatSession[] { return this._untitledSessions; }
	get activeUntitledSession(): IUntitledChatSession | undefined { return this._untitledSessions.find(session => session.untitledSessionId === this._activeUntitledSessionId); }
	get state(): SessionsManagementState { return this._state; }
	get error(): string | undefined { return this._error; }

	initialize(): Promise<void> {
		if (!this.initializePromise || this._state === "error") this.initializePromise = this.loadSessions();
		return this.initializePromise;
	}

	async openThread(sessionId: SessionId, threadId: ThreadId): Promise<void> {
		await this.initialize();
		const session = await this.provider.subscribe(await this.provider.read(sessionId));
		this.replaceSession(session);
		this.selectThread(sessionId, threadId);
	}

	selectThread(sessionId: SessionId, threadId: ThreadId): void {
		const session = this._sessions.find(candidate => candidate.sessionId === sessionId);
		const thread = session?.chats.find(candidate => candidate.threadId === threadId && candidate.status === "active");
		if (!session || !thread || session.status !== "active") throw new Error(`Active Session Thread is not available: ${threadId}`);
		if (this._active?.session.sessionId === sessionId && this._active.threadId === threadId && this._activeUntitledSessionId === undefined) return;
		this._active = { session, threadId };
		this._activeUntitledSessionId = undefined;
		this._error = undefined;
		this._onDidChange.fire();
	}

	async interruptThread(sessionId: SessionId, threadId: ThreadId): Promise<void> {
		const session = this._sessions.find(candidate => candidate.sessionId === sessionId && candidate.status === "active");
		if (!session) throw new Error(`Active Session is not available: ${sessionId}`);
		await this.provider.interrupt(session, threadId);
	}

	createUntitledSession(title = "New Chat"): IUntitledChatSession {
		const session = { untitledSessionId: createUuid(), title, model: undefined };
		this._untitledSessions = [session, ...this._untitledSessions];
		this._activeUntitledSessionId = session.untitledSessionId;
		this._error = undefined;
		this._onDidChange.fire();
		return session;
	}

	selectUntitledSession(untitledSessionId: string): void {
		if (!this._untitledSessions.some(session => session.untitledSessionId === untitledSessionId)) throw new Error(`Untitled Chat Session is not available: ${untitledSessionId}`);
		if (this._activeUntitledSessionId === untitledSessionId) return;
		this._activeUntitledSessionId = untitledSessionId;
		this._error = undefined;
		this._onDidChange.fire();
	}

	discardUntitledSession(untitledSessionId: string): void {
		const sessions = this._untitledSessions.filter(session => session.untitledSessionId !== untitledSessionId);
		if (sessions.length === this._untitledSessions.length) return;
		this._untitledSessions = sessions;
		if (this._activeUntitledSessionId === untitledSessionId) this._activeUntitledSessionId = sessions[0]?.untitledSessionId;
		this.restoreSelection();
		this._onDidChange.fire();
	}

	setUntitledSessionModel(untitledSessionId: string, model: ModelRef): void {
		const current = this._untitledSessions.find(session => session.untitledSessionId === untitledSessionId);
		if (!current) throw new Error(`Untitled Chat Session is not available: ${untitledSessionId}`);
		if (sameModel(current.model, model)) return;
		this._untitledSessions = this._untitledSessions.map(session => session.untitledSessionId === untitledSessionId ? { ...session, model } : session);
		this._onDidChange.fire();
	}

	async materializeUntitledSession(untitledSessionId: string): Promise<IActiveSessionThread> {
		const session = this._untitledSessions.find(candidate => candidate.untitledSessionId === untitledSessionId);
		if (!session) throw new Error(`Untitled Chat Session is not available: ${untitledSessionId}`);
		return this.createSession(session.title, session.model);
	}

	promoteUntitledSession(untitledSessionId: string, active: IActiveSessionThread): void {
		const wasActive = this._activeUntitledSessionId === untitledSessionId;
		this._untitledSessions = this._untitledSessions.filter(session => session.untitledSessionId !== untitledSessionId);
		if (wasActive) this._activeUntitledSessionId = undefined;
		this._sessions = [active.session, ...this._sessions.filter(session => session.sessionId !== active.session.sessionId)];
		if (wasActive || !this._active) this._active = active;
		this.setState("ready");
	}

	async ensureActiveThread(): Promise<IActiveSessionThread> {
		await this.initialize();
		return this._active ?? this.startNewSession();
	}

	async startNewSession(title = "New Chat"): Promise<IActiveSessionThread> {
		const active = await this.createSession(title);
		this._sessions = [active.session, ...this._sessions.filter(session => session.sessionId !== active.session.sessionId)];
		this._active = active;
		this._activeUntitledSessionId = undefined;
		this.setState("ready");
		return active;
	}

	async archiveSession(sessionId: SessionId): Promise<void> { await this.finishSession(sessionId, "archiving"); }
	async stopSession(sessionId: SessionId): Promise<void> { await this.finishSession(sessionId, "stopping"); }

	async setModel(model: ModelRef): Promise<void> {
		await this.initialize();
		if (this._sessions.length > 0 && this._sessions.every(session => sameModel(session.model, model))) return;
		await this.provider.setModel(model);
		this._sessions = this._sessions.map(session => ({ ...session, model }));
		if (this._active) {
			const session = this._sessions.find(candidate => candidate.sessionId === this._active?.session.sessionId);
			if (session) this._active = { session, threadId: this._active.threadId };
		}
		this._error = undefined;
		this._onDidChange.fire();
	}

	private async createSession(title: string, model?: ModelRef): Promise<IActiveSessionThread> {
		this.setState("creating");
		try {
			return await this.provider.create(title, model);
		} catch (error) {
			this.setError(error);
			throw error;
		}
	}

	private async finishSession(sessionId: SessionId, state: "archiving" | "stopping"): Promise<void> {
		await this.initialize();
		const session = this._sessions.find(candidate => candidate.sessionId === sessionId && candidate.status === "active");
		if (!session) throw new Error(`Active Session is not available: ${sessionId}`);
		this.setState(state);
		try {
			this.replaceSession(state === "archiving" ? await this.provider.archive(session) : await this.provider.stop(session));
			if (this._active?.session.sessionId === sessionId) this._active = this.firstActiveThread();
			this.restoreSelection();
			this.setState("ready");
		} catch (error) {
			this.setError(error);
			throw error;
		}
	}

	private async loadSessions(): Promise<void> {
		this.setState("loading");
		try {
			this._sessions = await Promise.all((await this.provider.list()).map(session => this.provider.subscribe(session)));
			this._active = this.firstActiveThread();
			this.restoreSelection();
			this.setState("ready");
		} catch (error) {
			this.setError(error);
		}
	}

	private scheduleRefresh(sessionId: SessionId): void {
		if (this.refreshes.has(sessionId)) return;
		const refresh = this.refreshSession(sessionId).finally(() => this.refreshes.delete(sessionId));
		this.refreshes.set(sessionId, refresh);
	}

	private async refreshSession(sessionId: SessionId): Promise<void> {
		try {
			while (this.pendingRefreshes.delete(sessionId)) {
				const current = this._sessions.find(candidate => candidate.sessionId === sessionId) ?? await this.provider.read(sessionId);
				const refreshed = await this.provider.subscribe(current);
				this.replaceSession(refreshed);
				if (this._active?.session.sessionId === sessionId) {
					this._active = refreshed.status === "active" ? activeThread(refreshed, this._active.threadId) ?? this.firstActiveThread() : this.firstActiveThread();
				}
				this.restoreSelection();
				this._error = undefined;
				this._onDidChange.fire();
			}
		} catch (error) {
			this.setError(error);
		}
	}

	private restoreSelection(): void {
		if (this.activeUntitledSession || this._active) return;
		this._activeUntitledSessionId = this._untitledSessions[0]?.untitledSessionId;
	}

	private replaceSession(session: ISession): void {
		this._sessions = this._sessions.some(candidate => candidate.sessionId === session.sessionId)
			? this._sessions.map(candidate => candidate.sessionId === session.sessionId ? session : candidate)
			: [session, ...this._sessions];
	}

	private firstActiveThread(): IActiveSessionThread | undefined { return firstActiveThread(this._sessions); }

	private setState(state: SessionsManagementState): void {
		this._state = state;
		this._error = undefined;
		this._onDidChange.fire();
	}

	private setError(error: unknown): void {
		this.restoreSelection();
		this._state = "error";
		this._error = error instanceof Error ? error.message : "Unable to load sessions.";
		this._onDidChange.fire();
	}
}

function firstActiveThread(sessions: readonly ISession[]): IActiveSessionThread | undefined {
	for (const session of sessions) {
		if (session.status !== "active") continue;
		const thread = session.chats.find(candidate => candidate.status === "active" && candidate.origin.type === "root") ?? session.chats.find(candidate => candidate.status === "active");
		if (thread) return { session, threadId: thread.threadId };
	}
	return undefined;
}

function activeThread(session: ISession, threadId: ThreadId): IActiveSessionThread | undefined {
	return session.chats.some(thread => thread.threadId === threadId && thread.status === "active") ? { session, threadId } : undefined;
}

function sameModel(left: ModelRef | null | undefined, right: ModelRef | null | undefined): boolean {
	return left?.provider === right?.provider && left?.model === right?.model;
}
