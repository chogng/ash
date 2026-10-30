import { raceCancellationError } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { canceled, isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { observableValue } from '../../../../base/common/observable.js';
import type { IActiveSessionThread, IUntitledChatSession, ISession, SessionManagementInfo, ModelRef, SessionId, SessionWorkspaceSelection, ThreadId } from '../common/session.js';
import type { ISessionsManagementService, SessionsManagementState } from '../common/sessionsManagement.js';
import type { ISessionsProvider } from '../common/sessionsProvider.js';
import type { ChatAgent } from '../../../../workbench/services/chat/common/chatService.js';
import { localize } from '../../../../nls.js';
import { ISessionsProvidersService } from './sessionsProvidersService.js';
import { backendSession, parseSessionIdentity, projectSession, sessionIdentity, threadIdentity } from '../common/sessionIdentity.js';

/** Keeps the rendered Session list and drafts; App Server owns durable Session data. */
export class SessionsManagementService extends Disposable implements ISessionsManagementService {
	private readonly _onDidChange = this._register(new Emitter<void>());
	private _sessions: readonly ISession[] = [];
	private _active: IActiveSessionThread | undefined;
	private _untitledSessions: readonly IUntitledChatSession[] = [];
	private _activeUntitledSessionId: string | undefined;
	private _state: SessionsManagementState = 'loading';
	private _error: string | undefined;
	private initializePromise: Promise<void> | undefined;
	private catalogGeneration = 0;
	private selectionRevision = 0;
	private pendingCreations = 0;
	// A draft keeps its creation result until graduation, including retries after first-send failure.
	private readonly materializations = new Map<string, Promise<IActiveSessionThread>>();
	private readonly pendingRefreshes = new Set<SessionId>();
	private readonly pendingDetailRefreshes = new Set<SessionId>();
	private readonly refreshes = new Map<SessionId, Promise<void>>();
	private readonly hydrating = new Map<SessionId, Promise<void>>();

	readonly onDidChange = this._onDidChange.event;
	readonly materializedSessions = observableValue<ReadonlyMap<string, { readonly sessionId: SessionId; readonly threadId: ThreadId; }>>(this, new Map());

	private readonly providerListeners = new Map<ISessionsProvider, DisposableStore>();

	constructor(private readonly provider: ISessionsProvider, @ISessionsProvidersService private readonly providers: ISessionsProvidersService) {
		super();
		this._register(provider);
		for (const entry of this.availableProviders()) this.observeProvider(entry);
		this._register(providers.onDidChangeProviders(({ added, removed }) => {
			for (const entry of removed) {
				this.providerListeners.get(entry)?.dispose();
				this.providerListeners.delete(entry);
				this._sessions = this._sessions.filter(session => session.providerId !== entry.id);
				if (this._active?.session.providerId === entry.id) this._active = undefined;
			}
			for (const entry of added) this.observeProvider(entry);
			if (this.initializePromise) this.initializePromise = this.loadSessions();
			else this._onDidChange.fire();
		}));
		this._register(toDisposable(() => { for (const listeners of this.providerListeners.values()) listeners.dispose(); this.providerListeners.clear(); }));
	}

	private availableProviders(): readonly ISessionsProvider[] {
		return [this.provider, ...this.providers.getProviders().filter(provider => provider.id !== this.provider.id)];
	}

	private observeProvider(provider: ISessionsProvider): void {
		if (this.providerListeners.has(provider)) return;
		const listeners = new DisposableStore();
		this.providerListeners.set(provider, listeners);
		listeners.add(provider.onDidChangeCatalog(() => {
			if (this.initializePromise) this.initializePromise = this.loadSessions();
		}));
		listeners.add(provider.onDidChangeSession(({ sessionId, detailChanged }) => {
			const identity = sessionIdentity(provider.id, sessionId, this.provider.id);
			this.pendingRefreshes.add(identity);
			if (detailChanged) this.pendingDetailRefreshes.add(identity);
			if (this._state !== 'loading') this.scheduleRefresh(identity);
		}));
		if (provider.connectionStatus) listeners.add(provider.connectionStatus.onDidChange(status => {
			if (!this.initializePromise) return;
			if (status !== 'connected' && this.availableProviders().every(provider => provider.connectionStatus?.get() !== 'connected')) {
				this._state = status === 'connecting' ? 'loading' : 'error';
				this._error = status === 'disconnected' ? localize('sessions.connection.disconnected', 'The session host is disconnected. Reconnect to load your sessions.') : undefined;
			}
			this._onDidChange.fire();
		}));
	}

	private owner(sessionId: SessionId): ISessionsProvider {
		const { providerId } = parseSessionIdentity(sessionId, this.provider.id);
		const provider = providerId === this.provider.id ? this.provider : this.providers.getProvider(providerId);
		if (!provider) throw new Error(localize('sessions.provider.unavailable', 'The session host is unavailable: {0}', providerId));
		return provider;
	}


	private project(session: ISession, provider: ISessionsProvider): ISession {
		return projectSession(session, provider.id, provider.label, this.provider.id);
	}

	private async readCatalog(sessionId: SessionId, previous?: ISession): Promise<ISession | undefined> {
		const provider = this.owner(sessionId);
		const result = await provider.readCatalog(parseSessionIdentity(sessionId, this.provider.id).backendSessionId, previous && backendSession(previous, this.provider.id));
		if (this.owner(sessionId) !== provider) throw canceled();
		return result && this.project(result, provider);
	}

	private async subscribe(session: ISession): Promise<ISession> {
		const provider = this.owner(session.sessionId);
		const result = await provider.subscribe(backendSession(session, this.provider.id));
		if (this.owner(session.sessionId) !== provider) throw canceled();
		return this.project(result, provider);
	}

	private unsubscribe(sessionId: SessionId): Promise<void> {
		return this.owner(sessionId).unsubscribe(parseSessionIdentity(sessionId, this.provider.id).backendSessionId);
	}

	private creationProvider(workspace?: SessionWorkspaceSelection, providerId?: string): ISessionsProvider {
		if (providerId) {
			if (providerId === this.provider.id) return this.provider;
			const provider = this.providers.getProvider(providerId);
			if (!provider) throw new Error(localize('sessions.provider.unavailable', 'The session host is unavailable: {0}', providerId));
			return provider;
		}
		if (workspace?.type === 'ssh') {
			const provider = this.availableProviders().find(provider => { const selected = provider.currentWorkspace(); return selected.type === 'ssh' && selected.host === workspace.host && selected.root === workspace.root; });
			if (!provider) throw new Error(localize('sessions.provider.unavailable', 'The session host is unavailable: {0}', workspace.host));
			return provider;
		}
		return this.activeUntitledSession?.providerId ? this.creationProvider(undefined, this.activeUntitledSession.providerId)
			: this._active ? this.owner(this._active.session.sessionId) : this.provider;
	}

	get sessions(): readonly ISession[] { return this._sessions; }
	get navigationRevision(): number { return this.selectionRevision; }
	get active(): IActiveSessionThread | undefined { return this._active; }
	get untitledSessions(): readonly IUntitledChatSession[] { return this._untitledSessions; }
	get activeUntitledSession(): IUntitledChatSession | undefined { return this._untitledSessions.find(session => session.untitledSessionId === this._activeUntitledSessionId); }
	get state(): SessionsManagementState { return this._state; }
	get error(): string | undefined { return this._error; }

	initialize(): Promise<void> {
		if (!this.initializePromise || this._state === 'error') this.initializePromise = this.loadSessions();
		return this.initializePromise;
	}


	public whenDirectoriesReady(signal?: AbortSignal): Promise<void> {
		if (this.isDisposed || signal?.aborted) { return Promise.reject(canceled()); }
		const ready = (async () => {
			await this.initialize();
			if (this.isDisposed) { throw canceled(); }
			if (this._state === 'error') { throw new Error(this._error); }
			const generation = this.catalogGeneration;
			// File restoration can refer to another known Session. Hydrate canonical
			// snapshots rather than inferring a directory from the requested URI.
			await Promise.all(this._sessions.filter(session => session.status === 'active').map(session => this.hydrateSession(session.sessionId)));
			if (this.isDisposed || generation !== this.catalogGeneration) { throw canceled(); }
		})();
		return signal ? raceCancellationError(ready, signal) : ready;
	}

	listAgents(): Promise<readonly ChatAgent[]> {
		return this.creationProvider().listAgents();
	}

	async openThread(sessionId: SessionId, threadId: ThreadId): Promise<void> {
		const revision = ++this.selectionRevision;
		await this.initialize();
		this.assertNotDisposed();
		const generation = this.catalogGeneration;
		let listed = this._sessions.find(candidate => candidate.sessionId === sessionId);
		if (!listed?.chats.some(chat => chat.threadId === threadId && chat.status === 'active')) {
			listed = await this.readCatalog(sessionId);
		}
		if (this.isDisposed || generation !== this.catalogGeneration) throw canceled();
		if (!listed || listed.sessionId !== sessionId || listed.status !== 'active') throw new Error(`Session is not available: ${sessionId}`);
		if (!listed.chats.some(chat => chat.threadId === threadId && chat.status === 'active')) throw new Error(`Active Session Thread is not available: ${threadId}`);
		this.replaceSession(listed);
		await this.hydrateSession(sessionId);
		if (this.isDisposed || generation !== this.catalogGeneration) throw canceled();
		// Loading a conversation may finish after another explicit navigation choice.
		if (revision === this.selectionRevision) this.selectThread(sessionId, threadId);
	}

	selectThread(sessionId: SessionId, threadId: ThreadId): void {
		this.selectionRevision++;
		const session = this._sessions.find(candidate => candidate.sessionId === sessionId);
		const thread = session?.chats.find(candidate => candidate.threadId === threadId && candidate.status === 'active');
		if (!session || !thread || session.status !== 'active') throw new Error(`Active Session Thread is not available: ${threadId}`);
		if (this._active?.session.sessionId === sessionId && this._active.threadId === threadId && this._activeUntitledSessionId === undefined) return;
		this._active = { session, threadId };
		this._activeUntitledSessionId = undefined;
		this._error = undefined;
		this._onDidChange.fire();
		if (!session.agentTree) void this.hydrateSession(sessionId).catch(error => this.setError(error));
	}

	async interruptThread(sessionId: SessionId, threadId: ThreadId): Promise<void> {
		const session = this._sessions.find(candidate => candidate.sessionId === sessionId && candidate.status === 'active');
		if (!session) throw new Error(`Active Session is not available: ${sessionId}`);
		await this.owner(sessionId).interrupt(backendSession(session, this.provider.id), parseSessionIdentity(threadId, this.provider.id).backendSessionId);
	}

	createUntitledSession(title = 'New Chat', workspace?: SessionWorkspaceSelection, providerId?: string): IUntitledChatSession {
		const provider = this.creationProvider(workspace, providerId);
		workspace ??= provider.currentWorkspace();
		this.selectionRevision++;
		const session = { untitledSessionId: createUuid(), providerId: provider.id, title, model: undefined, agent: undefined, workspace };
		this._untitledSessions = [session, ...this._untitledSessions];
		this._activeUntitledSessionId = session.untitledSessionId;
		this._error = undefined;
		this._onDidChange.fire();
		return session;
	}

	selectUntitledSession(untitledSessionId: string): void {
		this.selectionRevision++;
		if (!this._untitledSessions.some(session => session.untitledSessionId === untitledSessionId)) throw new Error(`Untitled Chat Session is not available: ${untitledSessionId}`);
		if (this._activeUntitledSessionId === untitledSessionId) return;
		this._activeUntitledSessionId = untitledSessionId;
		this._error = undefined;
		this._onDidChange.fire();
	}

	restoreUntitledSession(session: IUntitledChatSession): void {
		this._untitledSessions = [session, ...this._untitledSessions.filter(candidate => candidate.untitledSessionId !== session.untitledSessionId)];
		this._onDidChange.fire();
	}

	discardUntitledSession(untitledSessionId: string): void {
		const sessions = this._untitledSessions.filter(session => session.untitledSessionId !== untitledSessionId);
		if (sessions.length === this._untitledSessions.length) return;
		this._untitledSessions = sessions;
		if (this._activeUntitledSessionId === untitledSessionId) {
			this.selectionRevision++;
			this._activeUntitledSessionId = sessions[0]?.untitledSessionId;
		}
		this.restoreSelection();
		this._onDidChange.fire();
	}

	setUntitledSessionModel(untitledSessionId: string, model: ModelRef | undefined): void {
		const current = this._untitledSessions.find(session => session.untitledSessionId === untitledSessionId);
		if (!current) throw new Error(`Untitled Chat Session is not available: ${untitledSessionId}`);
		if (current.modelSelectionKind === 'manual' && sameModel(current.model, model)) return;
		this._untitledSessions = this._untitledSessions.map(session => session.untitledSessionId === untitledSessionId ? { ...session, model, modelSelectionKind: 'manual' as const } : session);
		this._onDidChange.fire();
	}

	setUntitledSessionDefaultModel(untitledSessionId: string, model: ModelRef | undefined): void {
		const current = this._untitledSessions.find(session => session.untitledSessionId === untitledSessionId);
		if (!current || current.modelSelectionKind === 'manual' || sameModel(current.model, model)) return;
		this._untitledSessions = this._untitledSessions.map(session => session.untitledSessionId === untitledSessionId ? { ...session, model } : session);
		this._onDidChange.fire();
	}

	setUntitledSessionAgent(untitledSessionId: string, agent: ChatAgent | undefined): void {
		const current = this._untitledSessions.find(session => session.untitledSessionId === untitledSessionId);
		if (!current) throw new Error(`Untitled Chat Session is not available: ${untitledSessionId}`);
		if (current.agent?.name === agent?.name && current.agent?.sourceId === agent?.sourceId) return;
		this._untitledSessions = this._untitledSessions.map(session => session.untitledSessionId === untitledSessionId ? { ...session, agent } : session);
		this._onDidChange.fire();
	}

	materializeUntitledSession(untitledSessionId: string): Promise<IActiveSessionThread> {
		const materialized = this.materializedSessions.get().get(untitledSessionId);
		if (materialized) {
			const session = this._sessions.find(candidate => candidate.sessionId === materialized.sessionId && candidate.status === 'active');
			const active = session && activeThread(session, materialized.threadId);
			return active ? Promise.resolve(active) : Promise.reject(new Error(`Active Session Thread is not available: ${materialized.threadId}`));
		}
		const pending = this.materializations.get(untitledSessionId);
		if (pending) return pending;
		const session = this._untitledSessions.find(candidate => candidate.untitledSessionId === untitledSessionId);
		if (!session) return Promise.reject(new Error(`Untitled Chat Session is not available: ${untitledSessionId}`));
		const creating = Promise.resolve().then(() => this.createSession(session.title, session.workspace, session.agent, untitledSessionId, session.providerId));
		this.materializations.set(untitledSessionId, creating);
		void creating.catch(() => {
			if (this.materializations.get(untitledSessionId) === creating) this.materializations.delete(untitledSessionId);
		});
		return creating;
	}

	promoteUntitledSession(untitledSessionId: string, active: IActiveSessionThread): void {
		this.materializations.delete(untitledSessionId);
		const wasActive = this._activeUntitledSessionId === untitledSessionId;
		this._untitledSessions = this._untitledSessions.filter(session => session.untitledSessionId !== untitledSessionId);
		if (wasActive) this._activeUntitledSessionId = undefined;
		this._sessions = [active.session, ...this._sessions.filter(session => session.sessionId !== active.session.sessionId)];
		this.materializedSessions.set(new Map([...this.materializedSessions.get(), [untitledSessionId, { sessionId: active.session.sessionId, threadId: active.threadId }]]));
		if (wasActive || !this._active && !this.activeUntitledSession) this._active = active;
		if (this.pendingCreations === 0) this.setState('ready');
		else this._onDidChange.fire();
	}

	async ensureActiveThread(): Promise<IActiveSessionThread> {
		await this.initialize();
		const draft = this.activeUntitledSession;
		if (draft) {
			const active = await this.materializeUntitledSession(draft.untitledSessionId);
			this.promoteUntitledSession(draft.untitledSessionId, active);
			return active;
		}
		return this._active ?? this.startNewSession();
	}

	async startNewSession(title = 'New Chat'): Promise<IActiveSessionThread> {
		const revision = ++this.selectionRevision;
		const active = await this.createSession(title, this.creationProvider().currentWorkspace());
		this._sessions = [active.session, ...this._sessions.filter(session => session.sessionId !== active.session.sessionId)];
		if (revision === this.selectionRevision) {
			this._active = active;
			this._activeUntitledSessionId = undefined;
		}
		if (this.pendingCreations === 0) this.setState('ready');
		else this._onDidChange.fire();
		return active;
	}

	async archiveSession(sessionId: SessionId): Promise<void> { await this.finishSession(sessionId, 'archiving'); }
	async stopSession(sessionId: SessionId): Promise<void> { await this.finishSession(sessionId, 'stopping'); }

	async restoreSession(sessionId: SessionId): Promise<void> {
		await this.initialize();
		const session = this._sessions.find(candidate => candidate.sessionId === sessionId && candidate.status === 'archived');
		if (!session) throw new Error(localize('chatSession.archived.missing', 'Archived session is unavailable: {0}', sessionId));
		try {
			const provider = this.owner(sessionId);
			const result = await provider.restore(backendSession(session, this.provider.id));
			if (this.owner(sessionId) !== provider) throw canceled();
			const restored = this.project(result, provider);
			if (this.isDisposed) throw canceled();
			this.replaceSession(restored);
			this._error = undefined;
			this._onDidChange.fire();
		} catch (error) {
			if (!this.isDisposed && !isCancellationError(error)) this.setError(error);
			throw error;
		}
	}

	async renameSession(sessionId: SessionId, title: string): Promise<void> {
		await this.initialize();
		const session = this._sessions.find(candidate => candidate.sessionId === sessionId);
		if (!session) throw new Error(localize('chatSession.rename.missing', 'Open a session before renaming it.'));
		const generation = this.catalogGeneration;
		const provider = this.owner(sessionId);
		const result = await provider.renameSession(backendSession(session, this.provider.id), title);
		if (this.owner(sessionId) !== provider) throw canceled();
		const renamed = this.project(result, provider);
		if (this.isDisposed || generation !== this.catalogGeneration) return;
		this.replaceSession(renamed);
		if (this._active?.session.sessionId === sessionId) this._active = { session: renamed, threadId: this._active.threadId };
		this._onDidChange.fire();
	}

	async deleteSession(sessionId: SessionId): Promise<void> {
		await this.initialize();
		const session = this._sessions.find(candidate => candidate.sessionId === sessionId && candidate.status === 'archived');
		if (!session) throw new Error(localize('chatSession.archived.missing', 'Archived session is unavailable: {0}', sessionId));
		await this.owner(sessionId).deleteSession(backendSession(session, this.provider.id));
		if (this.isDisposed) return;
		// A fresh catalog generation retires reads that began before the deletion,
		// so a delayed notification response cannot reinsert the removed Session.
		this._sessions = this._sessions.filter(candidate => candidate.sessionId !== sessionId);
		await this.loadSessions();
	}

	async setModel(model: ModelRef): Promise<void> {
		await this.initialize();
		await this.creationProvider().setModel(model);
		this._error = undefined;
		this._onDidChange.fire();
	}

	private async createSession(title: string, workspace: SessionWorkspaceSelection, agent?: ChatAgent, creationId: string = createUuid(), providerId?: string): Promise<IActiveSessionThread> {
		this.pendingCreations++;
		this.setState('creating');
		try {
			const provider = this.creationProvider(workspace, providerId);
			const created = await provider.create(title, workspace, agent, creationId);
			if (this.creationProvider(undefined, provider.id) !== provider) throw canceled();
			const active = { session: this.project(created.session, provider), threadId: threadIdentity(provider.id, created.threadId, this.provider.id) };
			if (this.isDisposed) throw canceled();
			return active;
		} catch (error) {
			if (isCancellationError(error)) {
				throw error;
			}
			this.setError(error);
			throw error;
		} finally {
			this.pendingCreations--;
			if (!this.isDisposed && this.pendingCreations === 0 && this._state === 'creating') this.setState('ready');
		}
	}

	private async finishSession(sessionId: SessionId, state: 'archiving' | 'stopping'): Promise<void> {
		await this.initialize();
		const session = this._sessions.find(candidate => candidate.sessionId === sessionId && candidate.status === 'active');
		if (!session) throw new Error(`Active Session is not available: ${sessionId}`);
		this.setState(state);
		try {
			const provider = this.owner(sessionId);
			const result = state === 'archiving' ? await provider.archive(backendSession(session, this.provider.id)) : await provider.stop(backendSession(session, this.provider.id));
			if (this.owner(sessionId) !== provider) throw canceled();
			this.replaceSession(this.project(result, provider));
			if (this._active?.session.sessionId === sessionId) this._active = this.firstActiveThread();
			this.restoreSelection();
			this.setState('ready');
			if (this._active && !this._active.session.agentTree) void this.hydrateSession(this._active.session.sessionId).catch(error => this.setError(error));
		} catch (error) {
			this.setError(error);
			throw error;
		}
	}

	private async loadSessions(): Promise<void> {
		const generation = ++this.catalogGeneration;
		// Superseded jobs can finish later, but must not own the new catalog's refresh slots.
		this.hydrating.clear();
		this.refreshes.clear();
		this.setState('loading');
		try {
			const providers = this.availableProviders();
			const sessions = providers.length === 1 ? await this.provider.list() : await this.loadProviderCatalogs(providers);
			if (this.isDisposed || generation !== this.catalogGeneration) return;
			const hydrated = this._sessions.filter(session => session.agentTree !== undefined).map(session => session.sessionId);
			const active = this._active;
			this._sessions = sessions;
			const selected = sessions.find(session => session.sessionId === active?.session.sessionId && session.status === 'active');
			this._active = selected && active ? activeThread(selected, active.threadId) ?? this.firstActiveThread() : this.firstActiveThread();
			this.restoreSelection();
			this.setState('ready');
			for (const sessionId of this.pendingRefreshes) this.scheduleRefresh(sessionId);
			for (const sessionId of hydrated) void this.hydrateSession(sessionId).catch(error => this.setError(error));
			if (this._active) void this.hydrateSession(this._active.session.sessionId).catch(error => this.setError(error));
		} catch (error) {
			if (generation === this.catalogGeneration) this.setError(error);
		}
	}

	private async loadProviderCatalogs(providers: readonly ISessionsProvider[]): Promise<readonly ISession[]> {
		let successful = 0;
		const results = await Promise.allSettled(providers.map(async provider => {
			const listed = await provider.list();
			if (!this.availableProviders().includes(provider)) throw canceled();
			successful++;
			return listed.map(session => this.project(session, provider));
		}));
		if (!successful) throw results.find(result => result.status === 'rejected')?.reason;
		return results.flatMap((result, index) => result.status === 'fulfilled' ? result.value : this._sessions.filter(session => session.providerId === providers[index].id));
	}

	private scheduleRefresh(sessionId: SessionId): void {
		if (this.refreshes.has(sessionId)) return;
		const refresh = this.refreshSession(sessionId).finally(() => {
			if (this.refreshes.get(sessionId) === refresh) this.refreshes.delete(sessionId);
		});
		this.refreshes.set(sessionId, refresh);
	}

	private async refreshSession(sessionId: SessionId): Promise<void> {
		const generation = this.catalogGeneration;
		try {
			while (this.pendingRefreshes.delete(sessionId)) {
				await this.hydrating.get(sessionId);
				if (this.isDisposed || generation !== this.catalogGeneration) return;
				const current = this._sessions.find(candidate => candidate.sessionId === sessionId);
				const listed = await this.readCatalog(sessionId, current);
				if (this.isDisposed || generation !== this.catalogGeneration) return;
				const detailChanged = this.pendingDetailRefreshes.delete(sessionId);
				if (current?.agentTree && listed?.status !== 'active') await this.unsubscribe(sessionId);
				const membershipChanged = listed && current && (listed.chats.length !== current.chats.length
					|| listed.chats.some(chat => !current.chats.some(previous => previous.threadId === chat.threadId)));
				const refreshed = listed && (detailChanged || membershipChanged) && current?.agentTree && listed.status === 'active'
					? await this.subscribe(listed)
					: listed;
				if (this.isDisposed || generation !== this.catalogGeneration) return;
				if (sameSession(current, refreshed)) continue;
				if (refreshed) this.replaceSession(refreshed);
				else this._sessions = this._sessions.filter(candidate => candidate.sessionId !== sessionId);
				if (this._active?.session.sessionId === sessionId) {
					this._active = refreshed?.status === 'active' ? activeThread(refreshed, this._active.threadId) ?? this.firstActiveThread() : this.firstActiveThread();
				}
				this.restoreSelection();
				this._error = undefined;
				this._onDidChange.fire();
				if (this._active && !this._active.session.agentTree) void this.hydrateSession(this._active.session.sessionId).catch(error => this.setError(error));
			}
		} catch (error) {
			if (generation === this.catalogGeneration) this.setError(error);
		}
	}

	private hydrateSession(sessionId: SessionId): Promise<void> {
		const pending = this.hydrating.get(sessionId);
		if (pending) return pending;
		const generation = this.catalogGeneration;
		const hydrate = (async () => {
			const current = this._sessions.find(candidate => candidate.sessionId === sessionId && candidate.status === 'active');
			if (!current || current.agentTree && current.chats.every(chat => chat.status !== 'active' || chat.workspace !== undefined)) return;
			const session = await this.subscribe(current);
			if (this.isDisposed || generation !== this.catalogGeneration) return;
			if (!this._sessions.some(candidate => candidate.sessionId === sessionId && candidate.status === 'active')) {
				await this.unsubscribe(sessionId);
				return;
			}
			this.replaceSession(session);
			if (!this.activeUntitledSession && this._active?.session.sessionId === sessionId) {
				this._active = activeThread(session, this._active.threadId) ?? this.firstActiveThread();
			}
			this._onDidChange.fire();
		})().catch(error => {
			if (!this.isDisposed && generation === this.catalogGeneration) throw error;
		});
		this.hydrating.set(sessionId, hydrate);
		const finish = (): void => { if (this.hydrating.get(sessionId) === hydrate) this.hydrating.delete(sessionId); };
		void hydrate.then(finish, finish);
		return hydrate;
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
		if (this.isDisposed || isCancellationError(error)) return;
		this.restoreSelection();
		this._state = 'error';
		this._error = error instanceof Error ? error.message : 'Unable to load sessions.';
		this._onDidChange.fire();
	}
}

function firstActiveThread(sessions: readonly ISession[]): IActiveSessionThread | undefined {
	for (const session of sessions) {
		if (session.status !== 'active') continue;
		const thread = session.chats.find(candidate => candidate.status === 'active' && candidate.origin.type === 'root') ?? session.chats.find(candidate => candidate.status === 'active');
		if (thread) return { session, threadId: thread.threadId };
	}
	return undefined;
}

function activeThread(session: ISession, threadId: ThreadId): IActiveSessionThread | undefined {
	return session.chats.some(thread => thread.threadId === threadId && thread.status === 'active') ? { session, threadId } : undefined;
}

function sameModel(left: ModelRef | null | undefined, right: ModelRef | null | undefined): boolean {
	return left?.provider === right?.provider && left?.model === right?.model;
}

function sameManagement(left: SessionManagementInfo | undefined, right: SessionManagementInfo | undefined): boolean {
	return left?.status === right?.status && left?.statusChangedAtUnixMs === right?.statusChangedAtUnixMs
		&& left?.activity?.type === right?.activity?.type && left?.activity?.text === right?.activity?.text && left?.summary === right?.summary;
}

function sameSession(left: ISession | undefined, right: ISession | undefined): boolean {
	if (!left || !right) return left === right;
	if (left.title !== right.title || left.status !== right.status || left.agentTree !== right.agentTree || left.chats.length !== right.chats.length) return false;
	if (left.nextApprovalMode !== right.nextApprovalMode || !sameManagement(left.management, right.management) || !sameModel(left.model, right.model) || left.workspace?.authorityId !== right.workspace?.authorityId || left.workspace?.root !== right.workspace?.root) return false;
	return left.chats.every((chat, index) => {
		const next = right.chats[index];
		return next?.threadId === chat.threadId && next.status === chat.status && next.title === chat.title && next.executionStatus === chat.executionStatus && sameManagement(next.management, chat.management);
	});
}
