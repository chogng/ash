import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { SessionsRecentWorkspacesService } from './sessionsRecentWorkspacesService.js';
import { IAgentConnection } from '../../../../platform/agentHost/common/agentService.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IProjectService } from '../../../../platform/projects/common/projectService.js';
import { parseSessionEnvironment } from '../common/sessionEnvironment.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { canceled, isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { observableValue } from '../../../../base/common/observable.js';
import type { IActiveSessionThread, IUntitledChatSession, ISession, SessionManagementInfo, ModelRef, SessionId, SessionWorkspaceSelection, SessionExecutionTarget, ThreadId } from '../common/session.js';
import type { ISessionsManagementService, SessionsManagementState } from '../common/sessionsManagement.js';
import type { ISessionCreateOptions, ISessionsProvider } from '../common/sessionsProvider.js';
import type { ChatAgent } from '../../../../workbench/services/chat/common/chatService.js';
import { localize } from '../../../../nls.js';
import { selectionFromResource } from '../../../common/agentHostSessionWorkspace.js';
import { sessionWorkspaceUri } from '../../../common/sessionWorkspace.js';
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
	private readonly materializations = new Map<string, {
		readonly promise: Promise<IActiveSessionThread>;
		readonly cancellation: CancellationTokenSource;
		waiters: number;
		settled: boolean;
	}>();
	private readonly pendingRefreshes = new Set<SessionId>();
	private readonly pendingDetailRefreshes = new Set<SessionId>();
	private readonly refreshes = new Map<SessionId, Promise<void>>();
	private readonly hydrating = new Map<SessionId, Promise<void>>();

	readonly onDidChange = this._onDidChange.event;
	readonly materializedSessions = observableValue<ReadonlyMap<string, { readonly sessionId: SessionId; readonly threadId: ThreadId; readonly sideThread?: true; }>>(this, new Map());

	private readonly providerListeners = new Map<ISessionsProvider, DisposableStore>();

	private readonly recentWorkspaces: SessionsRecentWorkspacesService | undefined;

	constructor(
		private readonly defaultProviderId: string,
		@ISessionsProvidersService private readonly providers: ISessionsProvidersService,
		@IStorageService storage?: IStorageService,
		@IAgentConnection private readonly localHost?: IAgentConnection,
		@ISecretStorageService private readonly windowSecrets?: ISecretStorageService,
		@IProjectService private readonly projects?: IProjectService,
	) {
		super();
		this.recentWorkspaces = storage && new SessionsRecentWorkspacesService(storage);
		this._register(toDisposable(() => {
			for (const entry of this.materializations.values()) entry.cancellation.dispose(true);
			this.materializations.clear();
		}));
		for (const entry of this.availableProviders()) this.observeProvider(entry);
		this._register(providers.onDidChangeProviders(({ added, removed }) => {
			if (this.isDisposed) return;
			for (const entry of removed) {
				this.providerListeners.get(entry)?.dispose();
				this.providerListeners.delete(entry);
				for (const pending of [this.pendingRefreshes, this.pendingDetailRefreshes]) {
					for (const sessionId of pending) {
						if (parseSessionIdentity(sessionId, this.defaultProviderId).providerId === entry.id) {
							pending.delete(sessionId);
						}
					}
				}
				this._sessions = this._sessions.filter(session => (session.providerId ?? this.defaultProviderId) !== entry.id);
				if (this._active && (this._active.session.providerId ?? this.defaultProviderId) === entry.id) this._active = undefined;
			}
			for (const entry of added) this.observeProvider(entry);
			if (this.initializePromise) this.initializePromise = this.loadSessions();
			else this._onDidChange.fire();
		}));
		this._register(toDisposable(() => { for (const listeners of this.providerListeners.values()) listeners.dispose(); this.providerListeners.clear(); }));
	}

	private availableProviders(): readonly ISessionsProvider[] {
		const providers = this.providers.getProviders();
		const primary = providers.findIndex(provider => provider.id === this.defaultProviderId);
		if (primary > 0) {
			providers.unshift(...providers.splice(primary, 1));
		}
		return providers;
	}

	private observeProvider(provider: ISessionsProvider): void {
		if (this.providerListeners.has(provider)) return;
		const listeners = new DisposableStore();
		this.providerListeners.set(provider, listeners);
		listeners.add(provider.onDidChangeCatalog(() => {
			if (this.initializePromise) this.initializePromise = this.loadSessions();
		}));
		listeners.add(provider.onDidChangeSession(({ sessionId, detailChanged }) => {
			const identity = sessionIdentity(provider.id, sessionId, this.defaultProviderId);
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
		const { providerId } = parseSessionIdentity(sessionId, this.defaultProviderId);
		return this.requireProvider(providerId);
	}

	private requireProvider(providerId: string): ISessionsProvider {
		const provider = this.providers.getProvider(providerId);
		if (!provider) throw new Error(localize('sessions.provider.unavailable', 'The session host is unavailable: {0}', providerId));
		return provider;
	}

	private assertCurrentProvider(provider: ISessionsProvider): void {
		if (this.isDisposed || this.providers.getProvider(provider.id) !== provider) {
			throw canceled();
		}
	}

	private project(session: ISession, provider: ISessionsProvider): ISession {
		return projectSession(session, provider.id, provider.label, this.defaultProviderId);
	}

	private async readCatalog(sessionId: SessionId, previous?: ISession): Promise<ISession | undefined> {
		const provider = this.owner(sessionId);
		const result = await provider.readCatalog(parseSessionIdentity(sessionId, this.defaultProviderId).backendSessionId, previous && backendSession(previous, this.defaultProviderId));
		this.assertCurrentProvider(provider);
		return result && this.project(result, provider);
	}

	private async subscribe(session: ISession): Promise<ISession> {
		const provider = this.owner(session.sessionId);
		const result = await provider.subscribe(backendSession(session, this.defaultProviderId));
		this.assertCurrentProvider(provider);
		return this.project(result, provider);
	}

	private unsubscribe(sessionId: SessionId): Promise<void> {
		return this.owner(sessionId).unsubscribe(parseSessionIdentity(sessionId, this.defaultProviderId).backendSessionId);
	}

	private creationProvider(workspace?: SessionWorkspaceSelection, providerId?: string): ISessionsProvider {
		if (providerId) {
			return this.requireProvider(providerId);
		}
		if (workspace?.type === 'ssh') {
			const provider = this.availableProviders().find(provider => { const selected = provider.currentWorkspace(); return selected.type === 'ssh' && selected.host === workspace.host && selected.root === workspace.root; });
			if (!provider) throw new Error(localize('sessions.provider.unavailable', 'The session host is unavailable: {0}', workspace.host));
			return provider;
		}
		return this.activeUntitledSession?.providerId ? this.creationProvider(undefined, this.activeUntitledSession.providerId)
			: this._active ? this.owner(this._active.session.sessionId) : this.requireProvider(this.defaultProviderId);
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

	refresh(): Promise<void> {
		this.initializePromise = this.loadSessions();
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
		await this.prepareThread(sessionId, threadId);
		// Loading a conversation may finish after another explicit navigation choice.
		if (revision === this.selectionRevision) this.selectThread(sessionId, threadId);
	}

	async prepareThread(sessionId: SessionId, threadId: ThreadId): Promise<void> {
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
		await this.owner(sessionId).interrupt(backendSession(session, this.defaultProviderId), parseSessionIdentity(threadId, this.defaultProviderId).backendSessionId);
	}

	createUntitledSession(title?: string, workspace?: SessionWorkspaceSelection, providerId?: string, activate = true, forkSource?: IUntitledChatSession['forkSource'], options?: Parameters<ISessionsManagementService['createUntitledSession']>[5]): IUntitledChatSession {
		const provider = this.creationProvider(workspace, providerId);
		if (!workspace) {
			const current = provider.currentWorkspace();
			workspace = (activate && !forkSource ? this.recentWorkspaces?.getSelected(provider.id, current) : undefined) ?? current;
		}
		const session: IUntitledChatSession = {
			untitledSessionId: createUuid(),
			providerId: provider.id,
			title: title ?? localize('chat.title.new', 'New Chat'),
			model: undefined,
			agent: undefined,
			workspace,
			...(options?.projectId ? { projectId: options.projectId } : {}),
			...(title === undefined ? { automaticTitle: true } : {}),
			...(forkSource ? { forkSource } : {}),
			...(options?.devContainer ? { devContainer: true } : {}),
		};
		this._untitledSessions = [session, ...this._untitledSessions];
		if (activate) {
			this.selectionRevision++;
			this._activeUntitledSessionId = session.untitledSessionId;
			this._error = undefined;
		}
		this._onDidChange.fire();
		return session;
	}

	async resolveNewSessionTarget(): ReturnType<ISessionsManagementService['resolveNewSessionTarget']> {
		const draft = this.activeUntitledSession;
		const session = draft ? undefined : this.active?.session;
		const providerId = draft?.providerId ?? session?.providerId ?? this.defaultProviderId;
		const provider = this.providers.getProvider(providerId);
		if (provider && this.isAvailableForNewSession(provider)) {
			// Use the Session's creation workspace, which can differ from its chat's managed worktree.
			const workspace = session?.workspace;
			const runtime = workspace?.runtime;
			const source = runtime?.providerId === 'ash.dev-containers'
				? { authorityId: runtime.hostAuthority ?? 'local', root: runtime.workspace }
				: workspace && !runtime ? workspace : undefined;
			const target = draft?.workspace ?? (source ? selectionFromResource(sessionWorkspaceUri(source)) : undefined);
			const devContainer = draft?.devContainer === true || runtime?.providerId === 'ash.dev-containers';
			if (target && target.type !== 'current' && await this.canReuseWorkspace(provider, target, devContainer)
				&& this.isAvailableForNewSession(provider)) {
				const projectId = draft?.projectId ?? (session && providerId === this.defaultProviderId
					? await this.findSessionProject(session.sessionId) : undefined);
				return { providerId, workspace: target, ...(devContainer ? { devContainer: true } : {}), ...(projectId ? { projectId } : {}) };
			}
		}
		const fallback = provider && this.isAvailableForNewSession(provider) ? provider : this.requireProvider(this.defaultProviderId);
		if (!this.isAvailableForNewSession(fallback)) return { providerId: this.defaultProviderId, workspace: { type: 'current' } };
		const current = fallback.currentWorkspace();
		const recent = this.recentWorkspaces?.getSelected(fallback.id, current);
		for (const target of [recent, current]) {
			if (target && target.type !== 'current' && await this.canReuseWorkspace(fallback, target)
				&& this.isAvailableForNewSession(fallback)) {
				return { providerId: fallback.id, workspace: target };
			}
		}
		return { providerId: this.isAvailableForNewSession(fallback) ? fallback.id : this.defaultProviderId, workspace: { type: 'current' } };
	}

	private async findSessionProject(sessionId: SessionId): Promise<string | undefined> {
		if (!this.projects) return undefined;
		try {
			const projects = await this.projects.list('code');
			const members = await Promise.all(projects.filter(project => !project.archived && project.sessionCount > 0)
				.map(project => this.projects!.read(project.id, 'code')));
			return members.find(project => !project.archived && project.sessionIds.includes(sessionId))?.id;
		} catch {
			// The execution target can still seed the picker while Projects reconnects.
			return undefined;
		}
	}

	private isAvailableForNewSession(provider: ISessionsProvider): boolean {
		return this.providers.getProvider(provider.id) === provider
			&& (!provider.connectionStatus || provider.connectionStatus.get() === 'connected');
	}

	private async canReuseWorkspace(provider: ISessionsProvider, workspace: Exclude<SessionWorkspaceSelection, { type: 'current'; }>, devContainer = false): Promise<boolean> {
		const targets = workspace.type === 'multiple' ? workspace.folders.map(folder => folder.target) : [workspace];
		const check = async (target: SessionExecutionTarget): Promise<boolean> =>
			target.type !== 'provider' && (await provider.canReuseWorkspace?.(target, devContainer).catch(() => false) ?? !devContainer);
		return (await Promise.all(targets.map(check))).every(Boolean);
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
		// Older nested drafts can contain an Agent choice the fork never used.
		if (session.forkSource && session.agent) {
			session = { ...session, agent: undefined };
		}
		this._untitledSessions = [session, ...this._untitledSessions.filter(candidate => candidate.untitledSessionId !== session.untitledSessionId)];
		this._onDidChange.fire();
		if (session.forkSource) {
			void this.hydrateSession(session.forkSource.sessionId).catch(() => {
				// Keep the draft usable if its Agent metadata cannot be loaded. Sending validates the source.
			});
		}
	}

	discardUntitledSession(untitledSessionId: string): void {
		const sessions = this._untitledSessions.filter(session => session.untitledSessionId !== untitledSessionId);
		if (sessions.length === this._untitledSessions.length) return;
		this.materializations.get(untitledSessionId)?.cancellation.cancel();
		this.materializations.delete(untitledSessionId);
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

	setUntitledSessionDefaultModel(untitledSessionId: string, model: ModelRef | undefined, defaults: NonNullable<IUntitledChatSession['modelDefaults']>): void {
		const current = this._untitledSessions.find(session => session.untitledSessionId === untitledSessionId);
		if (!current || current.modelDefaults?.workspace === defaults.workspace) return;
		this._untitledSessions = this._untitledSessions.map(session => session === current
			? { ...session, model: session.modelSelectionKind === 'manual' ? session.model : model, modelDefaults: defaults }
			: session);
		this._onDidChange.fire();
	}

	setUntitledSessionReasoningEffort(untitledSessionId: string, effort: NonNullable<IUntitledChatSession['reasoningEffortSelection']> | null): void {
		const current = this._untitledSessions.find(session => session.untitledSessionId === untitledSessionId);
		if (!current) throw new Error(`Untitled Chat Session is not available: ${untitledSessionId}`);
		if (current.reasoningEffortSelection === effort) return;
		this._untitledSessions = this._untitledSessions.map(session => session === current ? { ...session, reasoningEffortSelection: effort } : session);
		this._onDidChange.fire();
	}

	setUntitledSessionAgent(untitledSessionId: string, agent: ChatAgent | undefined): void {
		const current = this._untitledSessions.find(session => session.untitledSessionId === untitledSessionId);
		if (!current) throw new Error(`Untitled Chat Session is not available: ${untitledSessionId}`);
		// The fork always inherits the source conversation's Agent.
		if (current.forkSource) return;
		if (current.agent?.name === agent?.name && current.agent?.sourceId === agent?.sourceId) return;
		this._untitledSessions = this._untitledSessions.map(session => session.untitledSessionId === untitledSessionId ? { ...session, agent } : session);
		this._onDidChange.fire();
	}

	setUntitledSessionWorkspace(untitledSessionId: string, workspace: SessionWorkspaceSelection | undefined, options?: Parameters<ISessionsManagementService['setUntitledSessionWorkspace']>[2]): void {
		const current = this._untitledSessions.find(session => session.untitledSessionId === untitledSessionId);
		if (!current) throw new Error(`Untitled Chat Session is not available: ${untitledSessionId}`);
		// Once creation starts, its command identity and execution directory are immutable.
		if (this.materializations.has(untitledSessionId)) throw new Error(localize('sessions.workspace.preparing', 'Wait for session preparation to finish before changing its workspace.'));
		const providerId = options?.providerId ?? current.providerId;
		const changedHost = providerId !== current.providerId;
		const selection = workspace ?? this.creationProvider(undefined, providerId).currentWorkspace();
		this._untitledSessions = this._untitledSessions.map(session => session === current
			? {
				...session, providerId, workspace: selection,
				projectId: options?.projectId ?? (!changedHost && selection === current.workspace ? current.projectId : undefined),
				environment: options?.environment ?? (changedHost || options?.clearEnvironment ? undefined : current.environment),
				devContainer: options?.devContainer === true, branchName: options?.branchName,
				...(changedHost ? { model: undefined, modelSelectionKind: undefined, modelDefaults: undefined, agent: undefined } : {}),
			} : session);
		this._onDidChange.fire();
	}

	async materializeUntitledSession(untitledSessionId: string, signal?: AbortSignal): Promise<IActiveSessionThread> {
		if (this.isDisposed || signal?.aborted) throw canceled();
		const materialized = this.materializedSessions.get().get(untitledSessionId);
		if (materialized) {
			const session = this._sessions.find(candidate => candidate.sessionId === materialized.sessionId && candidate.status === 'active');
			const active = session && activeThread(session, materialized.threadId);
			return active ? Promise.resolve(active) : Promise.reject(new Error(`Active Session Thread is not available: ${materialized.threadId}`));
		}
		let entry = this.materializations.get(untitledSessionId);
		if (!entry) {
			const session = this._untitledSessions.find(candidate => candidate.untitledSessionId === untitledSessionId);
			if (!session) return Promise.reject(new Error(`Untitled Chat Session is not available: ${untitledSessionId}`));
			const cancellation = new CancellationTokenSource();
			const creating = Promise.resolve().then(async () => {
				const project = session.projectId && await this.projects?.read(session.projectId);
				if (session.projectId && (!project || project.archived)) {
					throw new Error(localize({ bundle: 'ash.sessions', key: 'sessions.project.unavailable' }, 'This project is unavailable. Choose another project.'));
				}
				let environmentVariables: Readonly<Record<string, string>> | undefined;
				if (session.environment?.hasVariables) {
					const id = session.environment.id;
					const profiles = this.localHost?.session;
					environmentVariables = await profiles?.readEnvironmentProfile?.(id);
					if (!environmentVariables) {
						const legacy = await this.windowSecrets?.get(id);
						if (legacy === undefined || !profiles?.saveEnvironmentProfile) {
							throw new Error(localize('sessions.environment.variablesMissing', 'The saved environment variables are unavailable.'));
						}
						const parsed = parseSessionEnvironment(legacy);
						if ('invalidLine' in parsed) {
							throw new Error(localize('sessions.environment.invalidVariable', 'Invalid .env entry on line {0}.', parsed.invalidLine));
						}
						await profiles.saveEnvironmentProfile(id, parsed.variables);
						environmentVariables = parsed.variables;
					}
				}
				if (cancellation.token.isCancellationRequested) throw canceled();
				const workspace = session.workspace;
				const additionalFolders = session.environment?.folders.filter(folder =>
					!('root' in workspace) || workspace.type !== folder.type || workspace.root !== folder.root);
				const active = await this.createSession(session.title, workspace, session.agent, untitledSessionId, session.providerId, {
					token: cancellation.token, devContainer: session.devContainer, branchName: session.branchName,
					additionalFolders, environmentVariables, automaticTitle: session.automaticTitle,
				}, session.forkSource);
				if (project && !project.sessionIds.includes(active.session.sessionId)) {
					// The same draft creation ID recovers this Session if linking needs a retry.
					try {
						await this.projects!.addSession(project, active.session.sessionId);
					} catch (error) {
						const latest = await this.projects!.read(project.id);
						if (!latest.sessionIds.includes(active.session.sessionId)) {
							if (latest.archived || latest.revision === project.revision) throw error;
							await this.projects!.addSession(latest, active.session.sessionId);
						}
					}
				}
				return active;
			});
			entry = { promise: creating, cancellation, waiters: 0, settled: false };
			this.materializations.set(untitledSessionId, entry);
			const owned = entry;
			void creating.then(() => { owned.settled = true; cancellation.dispose(); }, () => {
				owned.settled = true;
				cancellation.dispose();
				if (this.materializations.get(untitledSessionId) === owned) this.materializations.delete(untitledSessionId);
			});
		}
		entry.waiters++;
		try {
			return await (signal ? raceCancellationError(entry.promise, signal) : entry.promise);
		} finally {
			entry.waiters--;
			if (!entry.settled && entry.waiters === 0) {
				entry.cancellation.cancel();
				if (this.materializations.get(untitledSessionId) === entry) this.materializations.delete(untitledSessionId);
			}
		}
	}

	promoteUntitledSession(untitledSessionId: string, active: IActiveSessionThread): void {
		this.materializations.delete(untitledSessionId);
		const wasActive = this._activeUntitledSessionId === untitledSessionId;
		const nested = this._untitledSessions.some(draft => draft.untitledSessionId === untitledSessionId && draft.forkSource);
		this._untitledSessions = this._untitledSessions.filter(session => session.untitledSessionId !== untitledSessionId);
		if (wasActive) this._activeUntitledSessionId = undefined;
		this._sessions = [active.session, ...this._sessions.filter(session => session.sessionId !== active.session.sessionId)];
		this.materializedSessions.set(new Map([...this.materializedSessions.get(), [untitledSessionId, { sessionId: active.session.sessionId, threadId: active.threadId, ...(nested ? { sideThread: true as const } : {}) }]]));
		if (wasActive || !this._active && !this.activeUntitledSession) this._active = active;
		if (this.pendingCreations === 0) this.setState('ready');
		else this._onDidChange.fire();
	}

	public cancelUntitledSessionPreparation(untitledSessionId: string): void {
		this.materializations.get(untitledSessionId)?.cancellation.cancel();
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

	async startNewSession(title = 'New Chat', background?: Parameters<ISessionsManagementService['startNewSession']>[1]): Promise<IActiveSessionThread> {
		const revision = background ? undefined : ++this.selectionRevision;
		const active = await this.createSession(title, background?.workspace ?? this.creationProvider().currentWorkspace(), undefined, createUuid(), background?.providerId, background?.creation);
		this._sessions = [active.session, ...this._sessions.filter(session => session.sessionId !== active.session.sessionId)];
		if (revision === this.selectionRevision) {
			this._active = active;
			this._activeUntitledSessionId = undefined;
		}
		if (this.pendingCreations === 0) this.setState('ready');
		else this._onDidChange.fire();
		return active;
	}


	canChangeDirectory(sessionId: SessionId): boolean {
		const session = this._sessions.find(candidate => candidate.sessionId === sessionId);
		const chat = session?.chats[0];
		if (!session || session.source || session.status !== 'active' || session.chats.length !== 1 || chat?.threadId !== sessionId
			|| chat.origin.type !== 'root' || chat.status !== 'active'
			|| session.workspace && (session.workspace.authorityId !== 'local' || session.workspace.runtime)
			|| chat.executionStatus === 'queued' || chat.executionStatus === 'running' || chat.executionStatus === 'waiting'
			|| chat.management?.status === 'working' || chat.management?.status === 'needsInput') return false;
		const provider = this.providers.getProvider(parseSessionIdentity(sessionId, this.defaultProviderId).providerId);
		return !!provider?.changeDirectory && provider.canChangeDirectory?.() === true;
	}

	async changeDirectory(sessionId: SessionId, root: string): Promise<void> {
		if (!this.canChangeDirectory(sessionId)) throw new Error(localize({ bundle: 'ash.sessions', key: 'sessions.directory.changeUnavailable' }, 'This session cannot change directories right now.'));
		const provider = this.owner(sessionId);
		await provider.changeDirectory!(parseSessionIdentity(sessionId, this.defaultProviderId).backendSessionId, root, createUuid());
		this.assertCurrentProvider(provider);
		await this.refresh();
	}

	getChatMoveDestinations(sessionId: SessionId, threadId: ThreadId): readonly ISession[] {
		const source = this._sessions.find(session => session.sessionId === sessionId);
		const thread = source?.chats.find(chat => chat.threadId === threadId);
		if (!source || source.source || source.status !== 'active' || !thread || threadId === sessionId
			|| !source.chats.some(chat => chat.threadId === sessionId && chat.status === 'active')
			|| thread.status !== 'active' || thread.origin.type !== 'root'
			|| thread.executionStatus === 'queued' || thread.executionStatus === 'running' || thread.executionStatus === 'waiting'
			|| thread.management?.status === 'working' || thread.management?.status === 'needsInput'
			|| source.chats.some(chat => chat.origin.type !== 'root' && chat.origin.parentThreadId === threadId)) return [];
		const provider = this.providers.getProvider(parseSessionIdentity(sessionId, this.defaultProviderId).providerId);
		if (!provider?.moveChat || !provider.canMoveChat?.()) return [];
		// A conversation's managed worktree can differ from the Session's execution target.
		const workspace = source.workspace;
		if (workspace === undefined) return [];
		return this._sessions.filter(session => session.sessionId !== sessionId && !session.source
			&& session.status === 'active' && session.providerId === source.providerId
			&& session.chats.some(chat => chat.threadId === session.sessionId && chat.status === 'active')
			&& (workspace === null ? session.workspace === null : session.workspace?.root === workspace.root
				&& session.workspace.authorityId === workspace.authorityId
				&& session.workspace.runtime?.providerId === workspace.runtime?.providerId
				&& session.workspace.runtime?.workspace === workspace.runtime?.workspace));
	}

	async moveChat(sessionId: SessionId, threadId: ThreadId, destination: SessionId): Promise<void> {
		if (!this.getChatMoveDestinations(sessionId, threadId).some(session => session.sessionId === destination)) {
			throw new Error(localize({ bundle: 'ash.sessions', key: 'sessions.list.moveChatUnavailable' }, 'This conversation cannot be moved to that session.'));
		}
		const provider = this.owner(sessionId);
		const identity = (id: string) => parseSessionIdentity(id, this.defaultProviderId).backendSessionId;
		await provider.moveChat!(identity(sessionId), identity(threadId), identity(destination), createUuid());
		this.assertCurrentProvider(provider);
		await this.refresh();
	}

	async archiveSession(sessionId: SessionId): Promise<void> { await this.finishSession(sessionId, 'archiving'); }
	async stopSession(sessionId: SessionId): Promise<void> { await this.finishSession(sessionId, 'stopping'); }

	async restoreSession(sessionId: SessionId): Promise<void> {
		await this.initialize();
		const session = this._sessions.find(candidate => candidate.sessionId === sessionId && candidate.status === 'archived');
		if (!session) throw new Error(localize('chatSession.archived.missing', 'Archived session is unavailable: {0}', sessionId));
		try {
			const provider = this.owner(sessionId);
			const result = await provider.restore(backendSession(session, this.defaultProviderId));
			this.assertCurrentProvider(provider);
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
		const result = await provider.renameSession(backendSession(session, this.defaultProviderId), title);
		this.assertCurrentProvider(provider);
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
		await this.owner(sessionId).deleteSession(backendSession(session, this.defaultProviderId));
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

	private async createSession(title: string, workspace: SessionWorkspaceSelection, agent?: ChatAgent, creationId: string = createUuid(), providerId?: string, options?: ISessionCreateOptions, forkSource?: IUntitledChatSession['forkSource']): Promise<IActiveSessionThread> {
		this.pendingCreations++;
		this.setState('creating');
		try {
			const provider = this.creationProvider(workspace, providerId);
			let created: IActiveSessionThread;
			if (forkSource) {
				if (options?.token.isCancellationRequested) throw canceled();
				const source = this._sessions.find(session => session.sessionId === forkSource.sessionId && session.status === 'active');
				if (!source?.chats.some(chat => chat.threadId === forkSource.threadId && chat.status === 'active') || this.owner(source.sessionId) !== provider || !provider.forkChat) {
					throw new Error(localize('sessions.nestedChat.sourceUnavailable', 'The source conversation is unavailable.'));
				}
				created = await provider.forkChat(backendSession(source, this.defaultProviderId).sessionId,
					parseSessionIdentity(forkSource.threadId, this.defaultProviderId).backendSessionId, title, creationId);
			} else {
				created = await provider.create(title, workspace, agent, creationId, options);
			}
			this.assertCurrentProvider(provider);
			const active = { session: this.project(created.session, provider), threadId: threadIdentity(provider.id, created.threadId, this.defaultProviderId) };
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
			const result = state === 'archiving' ? await provider.archive(backendSession(session, this.defaultProviderId)) : await provider.stop(backendSession(session, this.defaultProviderId));
			this.assertCurrentProvider(provider);
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
			const primary = providers[0];
			const sessions = providers.length === 1 && primary?.id === this.defaultProviderId
				? await primary.list()
				: providers.length ? await this.loadProviderCatalogs(providers) : [];
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
		return next?.threadId === chat.threadId && next.status === chat.status && next.title === chat.title && next.recap === chat.recap && next.executionStatus === chat.executionStatus && sameManagement(next.management, chat.management);
	});
}
