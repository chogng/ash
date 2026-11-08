import { RunOnceScheduler } from '../../../../base/common/async.js';
import { canceled, isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { observableValue, type IObservable } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import type { AgentSession } from '../../../../platform/agentHost/common/agent.js';
import { IAgentConnection } from '../../../../platform/agentHost/common/agentService.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';

export interface IAshChatSessionService {
	readonly catalog: IObservable<readonly AgentSession[]>;
	initializeCatalog(): void;
	create(draftId: string): Promise<{ readonly sessionId: string; readonly threadId: string; }>;
	read(sessionId: string): Promise<AgentSession | undefined>;
}

export const IAshChatSessionService = createServiceIdentifier<IAshChatSessionService>('ashChatSessionService');

/** Owns the native Chat projection of the ambient App Server's durable conversation catalog. */
export class AshChatSessionService extends Disposable implements IAshChatSessionService {
	private readonly sessions = observableValue<readonly AgentSession[]>(this, []);
	readonly catalog: IObservable<readonly AgentSession[]> = this.sessions;
	private readonly pendingChanges = new Set<string>();
	private readonly otherSessions = new Set<string>();
	private readonly refresh = this._register(new RunOnceScheduler(() => void this.refreshChangedSessions(), 0));
	private started = false;
	private loading = false;
	private subscribed = false;
	private refreshing = false;
	private epoch = 0;

	constructor(
		@IAgentConnection private readonly host: IAgentConnection,
		@ILogService private readonly log: ILogService,
	) {
		super();
		const connection = host.appServer.onConnectionState(state => {
			if (state === 'ready') {
				if (this.started) void this.loadCatalog();
				return;
			}
			this.epoch++;
			this.loading = false;
			this.subscribed = false;
			this.refreshing = false;
			this.pendingChanges.clear();
			this.otherSessions.clear();
		});
		this._register(toDisposable(() => connection.dispose()));
		this._register(host.session.onDidChangeSession(({ sessionId }) => this.invalidate(sessionId)));
		this._register(host.session.onDidDeleteSession(sessionId => {
			if (!this.otherSessions.delete(sessionId)) this.invalidate(sessionId);
		}));
		this._register(toDisposable(() => {
			if (this.subscribed) void host.session.unsubscribeCatalog(this).catch(error => this.report(error));
		}));
	}

	initializeCatalog(): void {
		if (this.started) return;
		this.started = true;
		const epoch = this.epoch;
		void this.host.appServer.getConnectionState().then(state => {
			if (state === 'ready' && this.isCurrent(epoch)) return this.loadCatalog();
		}, error => this.report(error));
	}

	async create(draftId: string): Promise<{ readonly sessionId: string; readonly threadId: string; }> {
		const epoch = this.epoch;
		const generation = this.host.appServer.connectionGeneration;
		const { session } = await this.host.session.create({
			// Retain the original command identity so pre-upgrade drafts can retry a first send.
			commandId: `desktop-session-${draftId}`,
			title: '',
			kind: 'chat',
			executionTarget: null,
			agent: { type: 'default' },
		});
		if (epoch !== this.epoch || generation !== this.host.appServer.connectionGeneration) throw canceled();
		// Creation acquires a Session lease. The editor subscribes only to its selected Thread.
		await this.host.session.unsubscribe({ sessionId: session.sessionId });
		if (!this.isCurrent(epoch)) throw canceled();
		if (session.kind !== 'chat') {
			throw new Error(localize('sessions.create.chatSurfaceUnavailable', 'This host cannot create an Ash Chat conversation.'));
		}
		const root = session.threads.find(thread => thread.status === 'active' && !thread.parentThreadId && !thread.forkedFromId);
		if (!root) throw new Error(localize('sessions.create.noActiveChat', 'The new session has no active chat.'));
		return { sessionId: session.sessionId, threadId: root.threadId };
	}

	async read(sessionId: string): Promise<AgentSession | undefined> {
		const session = await this.readCatalogEntry(sessionId);
		return session?.kind === 'chat' ? session : undefined;
	}

	private async loadCatalog(): Promise<void> {
		if (this.loading || this.subscribed) return;
		this.loading = true;
		const epoch = this.epoch;
		const generation = this.host.appServer.connectionGeneration;
		try {
			const { sessions } = await this.host.session.subscribeCatalog(this);
			if (this.isDisposed && epoch === this.epoch && generation === this.host.appServer.connectionGeneration) {
				await this.host.session.unsubscribeCatalog(this);
			}
			if (!this.isCurrent(epoch)) return;
			this.subscribed = true;
			const conversations: AgentSession[] = [];
			for (const session of sessions) {
				if (session.kind === 'chat') conversations.push(session);
				else this.otherSessions.add(session.sessionId);
			}
			this.sessions.set(conversations);
			if (this.pendingChanges.size) this.refresh.schedule();
		} catch (error) {
			if (epoch === this.epoch) this.report(error);
		} finally {
			if (this.isCurrent(epoch)) this.loading = false;
		}
	}

	private invalidate(sessionId: string): void {
		// Creation fixes a record's kind, so Code updates need no Chat catalog read.
		if (!this.started || this.otherSessions.has(sessionId)) return;
		this.pendingChanges.add(sessionId);
		if (this.subscribed && !this.refreshing) this.refresh.schedule();
	}

	private async refreshChangedSessions(): Promise<void> {
		if (!this.subscribed || this.refreshing || !this.pendingChanges.size) return;
		const epoch = this.epoch;
		const ids = [...this.pendingChanges];
		this.pendingChanges.clear();
		this.refreshing = true;
		const results = await Promise.allSettled(ids.map(id => this.readCatalogEntry(id)));
		if (!this.isCurrent(epoch)) return;
		this.refreshing = false;
		const next = new Map(this.sessions.get().map(session => [session.sessionId, session]));
		for (const [index, result] of results.entries()) {
			const id = ids[index]!;
			if (this.pendingChanges.has(id)) continue;
			if (result.status === 'rejected') {
				this.report(result.reason);
			} else if (result.value?.kind === 'chat') {
				next.set(id, result.value);
			} else {
				next.delete(id);
				if (result.value) this.otherSessions.add(id);
			}
		}
		const previous = this.sessions.get();
		if (next.size !== previous.length || previous.some(session => next.get(session.sessionId) !== session)) {
			this.sessions.set([...next.values()]);
		}
		if (this.pendingChanges.size) this.refresh.schedule();
	}

	private async readCatalogEntry(sessionId: string): Promise<AgentSession | undefined> {
		const epoch = this.epoch;
		const { session } = await this.host.session.readCatalog({ sessionId });
		if (!this.isCurrent(epoch)) throw canceled();
		return session?.sessionId === sessionId ? session : undefined;
	}

	private isCurrent(epoch: number): boolean {
		return !this.isDisposed && epoch === this.epoch;
	}

	private report(error: unknown): void {
		if (!isCancellationError(error)) this.log.warn('Ash Chat catalog', error);
	}
}
