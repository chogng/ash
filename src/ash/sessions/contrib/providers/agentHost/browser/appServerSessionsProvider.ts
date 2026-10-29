import { IRendererHostService, type IRendererHost } from '../../../../../platform/renderer/common/rendererHost.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { AgentHostAutomationStore } from './agentHostAutomationStore.js';
import type {
	AgentExecutionNode,
	AgentSession,
	ThreadSubscription,
	TurnStatus,
} from '../../../../../platform/agentHost/common/agent.js';
import { localize } from '../../../../../nls.js';
import { Emitter } from '../../../../../base/common/event.js';
import { canceled } from '../../../../../base/common/errors.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { createUuid } from '../../../../../base/common/uuid.js';
import { IAppServerApi, IServerEventApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { IAgentSessionService, IAgentTurnService } from '../../../../../platform/agentHost/common/agentService.js';
import { IAgentModelsService } from '../../../../../platform/agentHost/common/agentModels.js';
import type {
	AgentThreadExecutionStatus,
	AgentTreeNode,
	IActiveSessionThread,
	ISession,
	ModelRef,
	SessionExecutionTarget,
	SessionId,
	SessionWorkspaceSelection,
	ThreadId,
} from '../../../../services/sessions/common/session.js';
import { observableValue } from '../../../../../base/common/observable.js';
import {
	LOCAL_AGENT_HOST_PROVIDER_ID,
	type IAgentHostSessionsProvider,
} from '../../../../common/agentHostSessionsProvider.js';
import type { AppServerConnectionState } from '../../../../../platform/agentHost/common/appServerApi.js';
import type { ChatAgent } from '../../../../../workbench/services/chat/common/chatService.js';
import {
	buildAgentHostChatWorkspace,
	buildAgentHostSessionWorkspace,
} from '../../../../common/agentHostSessionWorkspace.js';
import { getSessionApplication } from '../../../../common/sessionApplication.js';

export interface AppServerSessionsProviderHost {
	readonly id?: string;
	readonly label?: string;
	readonly workspace: () => SessionWorkspaceSelection;
	readonly selectWorkspace: (
		folders: readonly { readonly label: string; readonly target: SessionExecutionTarget }[],
	) => Promise<SessionExecutionTarget | undefined>;
}

/** Adapts shared Agent execution records into Sessions product models. */
export class AppServerSessionsProvider extends Disposable implements IAgentHostSessionsProvider {
	public readonly id: string;
	public readonly label: string;
	public readonly order = 0;
	public get instantiationService(): IInstantiationService {
		return this.instantiation;
	}
	private automationStore: AgentHostAutomationStore | undefined;
	public get automations(): AgentHostAutomationStore | undefined {
		if (!this.rendererHost.automation) return undefined;
		return (this.automationStore ??= this._register(
			this.instantiation.createInstance(AgentHostAutomationStore, this.id, this.connectionStatus),
		));
	}
	public readonly connectionStatus = observableValue<'connecting' | 'connected' | 'disconnected'>(this, 'connecting');
	private readonly subscribed = new Set<SessionId>();
	private catalogSubscribed = false;
	private connectionEpoch = 0;
	private get connectionReady(): boolean {
		return this.connectionStatus.get() === 'connected';
	}
	private readonly initialConnectionState: Promise<void>;
	private catalogSubscription: Promise<readonly ISession[]> | undefined;
	private readonly subscriptions = new Map<
		SessionId,
		{ readonly revision: number; readonly promise: Promise<ISession> }
	>();
	private readonly releases = new Map<SessionId, Promise<void>>();
	private readonly subscriptionRevisions = new Map<SessionId, number>();
	private readonly _onDidChangeCatalog = this._register(new Emitter<void>());
	readonly onDidChangeCatalog = this._onDidChangeCatalog.event;
	private readonly _onDidChangeSession = this._register(
		new Emitter<{ sessionId: SessionId; detailChanged: boolean }>(),
	);
	readonly onDidChangeSession = this._onDidChangeSession.event;

	constructor(
		private readonly host: AppServerSessionsProviderHost,
		@IAppServerApi private readonly appServer: IAppServerApi,
		@IAgentSessionService private readonly sessionApi: IAgentSessionService,
		@IAgentModelsService private readonly modelApi: IAgentModelsService,
		@IAgentTurnService private readonly turnApi: IAgentTurnService,
		@IServerEventApi events: IServerEventApi,
		@IRendererHostService private readonly rendererHost: IRendererHost,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
		this.id = host.id ?? LOCAL_AGENT_HOST_PROVIDER_ID;
		this.label = host.label ?? localize('automations.localHost', 'Local Agent Host');
		let observedState = false;
		this.initialConnectionState = appServer.getConnectionState().then(state => {
			if (!observedState && !this.isDisposed) this.connectionStatus.set(connectionStatus(state));
		});
		const connection = appServer.onConnectionState(state => {
			observedState = true;
			this.connectionStatus.set(connectionStatus(state));
			// Transport generation changes on connect, but a resolved response can outlive close.
			if (state !== 'ready') this.connectionEpoch++;
			// The server starts each connection with an empty subscription set.
			this.catalogSubscribed = false;
			this.subscribed.clear();
			this.catalogSubscription = undefined;
			this.subscriptions.clear();
			this.releases.clear();
			this.subscriptionRevisions.clear();
			if (state === 'ready') this._onDidChangeCatalog.fire();
		});
		this._register(toDisposable(() => connection.dispose()));
		const subscription = events.subscribe(event => {
			if (event.method === 'session/changed')
				this._onDidChangeSession.fire({
					sessionId: event.params.sessionId,
					detailChanged: event.params.agentTreeChanged,
				});
			if (event.method === 'session/deleted')
				this._onDidChangeSession.fire({ sessionId: event.params.sessionId, detailChanged: false });
		});
		this._register(toDisposable(() => subscription.dispose()));
		this._register(
			toDisposable(() => {
				if (this.catalogSubscribed) {
					void this.releaseOnDispose(
						() => this.sessionApi.unsubscribeCatalog(),
						'Failed to unsubscribe Session catalog',
					);
				}
				for (const sessionId of this.subscribed) {
					void this.releaseOnDispose(
						() => this.sessionApi.unsubscribe({ sessionId }),
						`Failed to unsubscribe Session '${sessionId}'`,
					);
				}
				this.subscribed.clear();
			}),
		);
	}

	private async releaseOnDispose(release: () => Promise<void>, message: string): Promise<void> {
		const generation = this.appServer.connectionGeneration;
		try {
			await release();
		} catch (error) {
			// Our listener has already been removed when the parent closes the client.
			// A closed carrier releases its own leases; an unknown state still needs reporting.
			const state = await this.appServer.getConnectionState().catch(() => undefined);
			if (generation !== this.appServer.connectionGeneration || (state !== undefined && state !== 'ready'))
				return;
			console.error(message, error);
		}
	}

	list(): Promise<readonly ISession[]> {
		this.assertNotDisposed();
		if (!this.catalogSubscribed && this.catalogSubscription) return this.catalogSubscription;
		const subscribing = !this.catalogSubscribed;
		const result = this.readList(subscribing);
		if (subscribing) {
			this.catalogSubscription = result;
			const finish = (): void => {
				if (this.catalogSubscription === result) this.catalogSubscription = undefined;
			};
			void result.then(finish, finish);
		}
		return result;
	}

	private async readList(subscribing: boolean): Promise<readonly ISession[]> {
		const generation = this.appServer.connectionGeneration;
		const epoch = this.connectionEpoch;
		const result = await (subscribing ? this.sessionApi.subscribeCatalog() : this.sessionApi.list());
		await this.initialConnectionState;
		if (
			this.isDisposed &&
			generation === this.appServer.connectionGeneration &&
			epoch === this.connectionEpoch &&
			subscribing
		) {
			await this.sessionApi.unsubscribeCatalog();
		}
		this.assertCurrentConnection(generation, epoch);
		this.catalogSubscribed = true;
		return result.sessions.map(session => toSession(session));
	}

	async listAgents(): Promise<readonly ChatAgent[]> {
		this.assertNotDisposed();
		const generation = this.appServer.connectionGeneration;
		const epoch = this.connectionEpoch;
		const result = await this.sessionApi.listAgents();
		this.assertCurrentConnection(generation, epoch);
		return result.agents.flatMap(agent =>
			agent.source.type === 'directory'
				? [{ name: agent.name, description: agent.description, sourceId: agent.source.id }]
				: [],
		);
	}

	async readCatalog(sessionId: SessionId, previous?: ISession): Promise<ISession | undefined> {
		this.assertNotDisposed();
		const generation = this.appServer.connectionGeneration;
		const epoch = this.connectionEpoch;
		const result = await this.sessionApi.readCatalog({ sessionId });
		this.assertCurrentConnection(generation, epoch);
		return result.session ? toSession(result.session, [], previous) : undefined;
	}

	subscribe(session: ISession): Promise<ISession> {
		this.assertNotDisposed();
		if (session.status !== 'active') return Promise.resolve(session);
		const revision = this.subscriptionRevisions.get(session.sessionId) ?? 0;
		const pending = this.subscriptions.get(session.sessionId);
		if (pending?.revision === revision) return pending.promise;
		const promise = this.subscribeSession(session, revision);
		this.subscriptions.set(session.sessionId, { revision, promise });
		const finish = (): void => {
			if (this.subscriptions.get(session.sessionId)?.promise === promise)
				this.subscriptions.delete(session.sessionId);
		};
		void promise.then(finish, finish);
		return promise;
	}

	private async subscribeSession(session: ISession, revision: number): Promise<ISession> {
		const generation = this.appServer.connectionGeneration;
		const epoch = this.connectionEpoch;
		// Release the previous lease before acquiring the next one on the same connection.
		const releasing = this.releases.get(session.sessionId);
		if (releasing) await releasing;
		if (!this.connectionReady) await this.initialConnectionState;
		this.assertCurrentConnection(generation, epoch);
		if ((this.subscriptionRevisions.get(session.sessionId) ?? 0) !== revision) throw canceled();
		const result = await this.sessionApi.subscribe({ sessionId: session.sessionId });
		if (
			(this.isDisposed || (this.subscriptionRevisions.get(session.sessionId) ?? 0) !== revision) &&
			generation === this.appServer.connectionGeneration &&
			epoch === this.connectionEpoch
		) {
			await this.sessionApi.unsubscribe({ sessionId: session.sessionId });
		}
		this.assertCurrentConnection(generation, epoch);
		if ((this.subscriptionRevisions.get(session.sessionId) ?? 0) !== revision) throw canceled();
		this.subscribed.add(session.sessionId);
		const next = toSession(result.session, result.threadSnapshots, session, result.agentTree.roots);
		if (next.sessionId !== session.sessionId) {
			this.subscribed.delete(session.sessionId);
			await this.sessionApi.unsubscribe({ sessionId: session.sessionId });
			throw new Error(`Session subscription returned '${next.sessionId}' for '${session.sessionId}'`);
		}
		if (next.status !== 'active') {
			this.subscribed.delete(session.sessionId);
			await this.sessionApi.unsubscribe({ sessionId: session.sessionId });
			this.assertCurrentConnection(generation, epoch);
			if ((this.subscriptionRevisions.get(session.sessionId) ?? 0) !== revision) throw canceled();
		}
		return next;
	}

	unsubscribe(sessionId: SessionId): Promise<void> {
		const existing = this.releases.get(sessionId);
		const pending = this.subscriptions.get(sessionId)?.promise;
		const owned = this.subscribed.delete(sessionId);
		if (!owned && !pending) return existing ?? Promise.resolve();
		// A replacement may be queued behind the existing release; this call cancels it too.
		this.subscriptionRevisions.set(sessionId, (this.subscriptionRevisions.get(sessionId) ?? 0) + 1);
		if (existing) return existing;
		const generation = this.appServer.connectionGeneration;
		const epoch = this.connectionEpoch;
		const release = (async () => {
			// An in-flight acquire observes the revision and releases itself before settling.
			await pending?.catch(() => {});
			if (owned && generation === this.appServer.connectionGeneration && epoch === this.connectionEpoch)
				await this.sessionApi.unsubscribe({ sessionId });
		})();
		this.releases.set(sessionId, release);
		const finish = (): void => {
			if (this.releases.get(sessionId) === release) this.releases.delete(sessionId);
		};
		void release.then(finish, finish);
		return release;
	}

	currentWorkspace(): SessionWorkspaceSelection {
		return this.host.workspace();
	}

	async create(
		title: string,
		workspace: SessionWorkspaceSelection,
		agent?: ChatAgent,
		creationId: string = createUuid(),
	): Promise<IActiveSessionThread> {
		this.assertNotDisposed();
		const generation = this.appServer.connectionGeneration;
		const epoch = this.connectionEpoch;
		const executionTarget =
			workspace.type === 'multiple'
				? await this.host.selectWorkspace(workspace.folders)
				: workspace.type === 'current'
					? null
					: workspace;
		if (executionTarget === undefined) throw canceled();
		if (!this.connectionReady) await this.initialConnectionState;
		this.assertCurrentConnection(generation, epoch);
		const created = await this.sessionApi.create({
			commandId: `desktop-session-${creationId}`,
			title,
			executionTarget,
			agent: agent
				? { type: 'exact', source: { type: 'directory', id: agent.sourceId }, name: agent.name }
				: { type: 'default' },
		});
		// Creation also subscribes this connection to the new Session on the server.
		if (this.isDisposed && generation === this.appServer.connectionGeneration && epoch === this.connectionEpoch) {
			await this.sessionApi.unsubscribe({ sessionId: created.session.sessionId });
		}
		this.assertCurrentConnection(generation, epoch);
		this.subscribed.add(created.session.sessionId);
		// session/create already starts the root Thread atomically. A second createThread
		// would add an unrelated peer chat and leave the root empty on every first send.
		const root = created.session.threads.find(
			thread => thread.status === 'active' && !thread.parentThreadId && !thread.forkedFromId,
		);
		if (!root) {
			await this.unsubscribe(created.session.sessionId);
			throw new Error(localize('sessions.create.noActiveChat', 'The new session has no active chat.'));
		}
		try {
			const session = await this.subscribe(toSession(created.session));
			this.assertCurrentConnection(generation, epoch);
			if (
				!session.chats.some(candidate => candidate.threadId === root.threadId && candidate.status === 'active')
			) {
				throw new Error(localize('sessions.create.noActiveChat', 'The new session has no active chat.'));
			}
			// First-Turn defaults belong to ChatService; the catalog only reports durable facts.
			return { session, threadId: root.threadId };
		} catch (error) {
			// Hydration can race a root's removal or archival after atomic creation.
			// Every failed preparation releases its lease while retaining the durable Session for retry.
			if (generation === this.appServer.connectionGeneration && epoch === this.connectionEpoch)
				await this.unsubscribe(created.session.sessionId);
			throw error;
		}
	}

	async setModel(model: ModelRef): Promise<void> {
		await this.modelApi.setModel({ commandId: commandId('model'), model });
	}

	async archive(session: ISession): Promise<ISession> {
		this.assertNotDisposed();
		const generation = this.appServer.connectionGeneration;
		const epoch = this.connectionEpoch;
		const result = await this.sessionApi.archive({
			commandId: commandId('archive-session'),
			sessionId: session.sessionId,
		});
		this.assertCurrentConnection(generation, epoch);
		await this.unsubscribe(session.sessionId);
		this.assertCurrentConnection(generation, epoch);
		return toSession(result.session, [], session);
	}

	async stop(session: ISession): Promise<ISession> {
		this.assertNotDisposed();
		const generation = this.appServer.connectionGeneration;
		const epoch = this.connectionEpoch;
		const result = await this.sessionApi.stop({
			commandId: commandId('stop-session'),
			sessionId: session.sessionId,
		});
		this.assertCurrentConnection(generation, epoch);
		await this.unsubscribe(session.sessionId);
		this.assertCurrentConnection(generation, epoch);
		return toSession(result.session, [], session);
	}

	async renameSession(session: ISession, title: string): Promise<ISession> {
		this.assertNotDisposed();
		const generation = this.appServer.connectionGeneration;
		const epoch = this.connectionEpoch;
		const result = await this.sessionApi.rename({
			commandId: commandId('rename-session'),
			sessionId: session.sessionId,
			title,
		});
		this.assertCurrentConnection(generation, epoch);
		return toSession(result.session, [], session, result.agentTree.roots);
	}

	async deleteSession(session: ISession): Promise<void> {
		this.assertNotDisposed();
		const generation = this.appServer.connectionGeneration;
		const epoch = this.connectionEpoch;
		await this.sessionApi.delete({ commandId: commandId('delete-session'), sessionId: session.sessionId });
		this.assertCurrentConnection(generation, epoch);
		await this.unsubscribe(session.sessionId);
	}

	async restore(session: ISession): Promise<ISession> {
		this.assertNotDisposed();
		const generation = this.appServer.connectionGeneration;
		const epoch = this.connectionEpoch;
		const result = await this.sessionApi.restore({
			commandId: commandId('restore-session'),
			sessionId: session.sessionId,
		});
		this.assertCurrentConnection(generation, epoch);
		return toSession(result.session, [], session);
	}

	async interrupt(session: ISession, threadId: ThreadId): Promise<void> {
		this.assertNotDisposed();
		const generation = this.appServer.connectionGeneration;
		const epoch = this.connectionEpoch;
		const current = await this.sessionApi.read({ sessionId: session.sessionId });
		this.assertCurrentConnection(generation, epoch);
		const node = findAgentNode(current.agentTree.roots.map(toAgentTreeNode), threadId);
		if (!node?.currentTurnId || !canInterrupt(node))
			throw new Error(`Running Agent Thread is not available: ${threadId}`);
		await this.turnApi.interrupt({
			commandId: commandId('agent-interrupt'),
			sessionId: session.sessionId,
			threadId,
			turnId: node.currentTurnId,
			expectedSequence: node.threadSequence,
		});
	}

	private assertCurrentConnection(generation: number, epoch: number): void {
		if (
			this.isDisposed ||
			!this.connectionReady ||
			generation !== this.appServer.connectionGeneration ||
			epoch !== this.connectionEpoch
		)
			throw canceled();
	}
}

function connectionStatus(state: AppServerConnectionState): 'connecting' | 'connected' | 'disconnected' {
	if (state === 'ready') {
		return 'connected';
	}
	if (state === 'starting' || state === 'initializing' || state === 'restarting') {
		return 'connecting';
	}
	return 'disconnected';
}

function toSession(
	session: AgentSession,
	threads: readonly ThreadSubscription[] = [],
	previous?: ISession,
	agentTree?: readonly AgentExecutionNode[],
): ISession {
	const byId = new Map(threads.map(entry => [entry.thread.threadId, entry]));
	return {
		application: getSessionApplication('ash'),
		sessionId: session.sessionId,
		title: session.title,
		status: session.status,
		workspace: buildAgentHostSessionWorkspace(session.executionTarget),
		model: session.model,
		management: { ...session.manager },
		nextApprovalMode: previous?.nextApprovalMode ?? 'manual',
		chats: session.threads.map(thread => {
			const snapshot = byId.get(thread.threadId);
			const detail = snapshot?.thread;
			const prior = previous?.chats.find(candidate => candidate.threadId === thread.threadId);
			return {
				threadId: thread.threadId,
				workspace: snapshot ? buildAgentHostChatWorkspace(snapshot.directory ?? null) : prior?.workspace,
				origin:
					thread.parentThreadId || thread.forkedFromId
						? {
								type: 'fork' as const,
								parentThreadId: thread.parentThreadId ?? thread.forkedFromId!,
								parentSequence: detail?.sequence ?? 0,
							}
						: { type: 'root' as const },
				status: thread.status,
				title: detail?.title ?? thread.title,
				management: thread.manager ? { ...thread.manager } : undefined,
				executionStatus: detail
					? executionStatus(detail.turns.at(-1)?.status)
					: (prior?.executionStatus ?? 'idle'),
			};
		}),
		agentTree: session.status === 'active' ? (agentTree?.map(toAgentTreeNode) ?? previous?.agentTree) : undefined,
	};
}

function toAgentTreeNode(node: AgentExecutionNode): AgentTreeNode {
	return {
		threadId: node.threadId,
		threadSequence: node.threadSequence,
		title: node.title,
		origin:
			node.parentThreadId || node.forkedFromId
				? {
						type: 'fork',
						parentThreadId: node.parentThreadId ?? node.forkedFromId!,
						parentSequence: node.threadSequence,
					}
				: { type: 'root' },
		membershipStatus: 'active',
		executionStatus: node.executionStatus,
		...(node.currentTurnId ? { currentTurnId: node.currentTurnId } : {}),
		...(node.waitingReason ? { waitingReason: node.waitingReason } : {}),
		...(node.goal ? { goal: { ...node.goal } } : {}),
		usage: { inputTokens: node.usage.inputTokens.reported, outputTokens: node.usage.outputTokens.reported },
		...(node.role ? { role: { name: node.role.name, selectionReason: node.role.selectionReason } } : {}),
		...(node.result ? { result: { status: node.result.status, summary: node.result.summary } } : {}),
		joins: (node.joins ?? []).map(join => ({ status: join.status })),
		children: (node.children ?? []).map(toAgentTreeNode),
	};
}

function executionStatus(status: TurnStatus | undefined): AgentThreadExecutionStatus {
	switch (status) {
		case 'created':
			return 'queued';
		case 'running':
		case 'cancelling':
			return 'running';
		case 'waitingForApproval':
		case 'waitingForUserInput':
		case 'waitingForCapability':
			return 'waiting';
		case 'completed':
			return 'completed';
		case 'failed':
			return 'failed';
		case 'interrupted':
			return 'cancelled';
		case undefined:
			return 'idle';
	}
}

function findAgentNode(nodes: readonly AgentTreeNode[], threadId: ThreadId): AgentTreeNode | undefined {
	for (const node of nodes) {
		if (node.threadId === threadId) return node;
		const child = findAgentNode(node.children, threadId);
		if (child) return child;
	}
	return undefined;
}

function canInterrupt(node: AgentTreeNode): boolean {
	return (
		node.membershipStatus === 'active' &&
		(node.executionStatus === 'queued' || node.executionStatus === 'running' || node.executionStatus === 'waiting')
	);
}

function commandId(kind: string): string {
	return `desktop-${kind}-${createUuid()}`;
}
