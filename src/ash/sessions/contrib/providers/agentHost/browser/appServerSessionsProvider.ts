import type { AgentTreeNodeProjection as AgentTreeNodeDto, Session as SessionDto, SessionThreadProjection as ThreadDto, TurnStatus as TurnStatusDto } from "../../../../../../../.build/protocol/typescript/index.js";
import { Emitter } from "../../../../../base/common/event.js";
import { canceled } from "../../../../../base/common/errors.js";
import { Disposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import { createUuid } from "../../../../../base/common/uuid.js";
import { IAppServerApi, IServerEventApi } from "../../../../../platform/agentHost/common/appServerApi.js";
import { IModelApi, ISessionApi, ITurnApi } from "../../../../../platform/sessions/common/sessionApi.js";
import type { AgentThreadExecutionStatus, AgentTreeNode, IActiveSessionThread, ISession, ModelRef, SessionExecutionTarget, SessionId, SessionWorkspaceSelection, ThreadId } from "../../../../services/sessions/common/session.js";
import type { ISessionsProvider } from "../../../../services/sessions/common/sessionsProvider.js";
import type { ChatAgent } from '../../../../../workbench/services/chat/common/chatService.js';

export interface AppServerSessionsProviderHost {
	readonly workspace: () => SessionWorkspaceSelection;
	readonly selectWorkspace: (folders: readonly { readonly label: string; readonly target: SessionExecutionTarget; }[]) => Promise<SessionExecutionTarget | undefined>;
}

/** App Server adapter. Generated DTOs do not cross this provider boundary. */
export class AppServerSessionsProvider extends Disposable implements ISessionsProvider {
	private readonly subscribed = new Set<SessionId>();
	private catalogSubscribed = false;
	private readonly _onDidChangeCatalog = this._register(new Emitter<void>());
	readonly onDidChangeCatalog = this._onDidChangeCatalog.event;
	private readonly _onDidChangeSession = this._register(new Emitter<{ sessionId: SessionId; detailChanged: boolean; }>());
	readonly onDidChangeSession = this._onDidChangeSession.event;

	constructor(
		private readonly host: AppServerSessionsProviderHost,
		@IAppServerApi private readonly appServer: IAppServerApi,
		@ISessionApi private readonly sessionApi: ISessionApi,
		@IModelApi private readonly modelApi: IModelApi,
		@ITurnApi private readonly turnApi: ITurnApi,
		@IServerEventApi events: IServerEventApi,
	) {
		super();
		const connection = appServer.onConnectionState(state => {
			// The server starts each connection with an empty subscription set.
			this.catalogSubscribed = false;
			this.subscribed.clear();
			if (state === 'ready') this._onDidChangeCatalog.fire();
		});
		this._register(toDisposable(() => connection.dispose()));
		const subscription = events.subscribe(event => {
			if (event.method === "session/changed") this._onDidChangeSession.fire({ sessionId: event.params.sessionId, detailChanged: event.params.agentTreeChanged });
			if (event.method === "session/deleted") this._onDidChangeSession.fire({ sessionId: event.params.sessionId, detailChanged: false });
		});
		this._register(toDisposable(() => subscription.dispose()));
		this._register(toDisposable(() => {
			if (this.catalogSubscribed) { void this.sessionApi.unsubscribeCatalog().catch(error => console.error("Failed to unsubscribe Session catalog", error)); }
			for (const sessionId of this.subscribed) {
				void this.sessionApi.unsubscribe({ sessionId }).catch(error => console.error(`Failed to unsubscribe Session '${sessionId}'`, error));
			}
			this.subscribed.clear();
		}));
	}

	async list(): Promise<readonly ISession[]> {
		this.assertNotDisposed();
		const generation = this.appServer.connectionGeneration;
		const subscribing = !this.catalogSubscribed;
		const result = await (subscribing ? this.sessionApi.subscribeCatalog() : this.sessionApi.list()).then(async result => {
			if (generation !== this.appServer.connectionGeneration) { throw canceled(); }
			if (this.isDisposed) {
				if (subscribing) { await this.sessionApi.unsubscribeCatalog(); }
				throw canceled();
			}
			this.catalogSubscribed = true;
			return result;
		});
		this.assertCurrentConnection(generation);
		this.catalogSubscribed = true;
		return result.sessions.map(session => toSession(session));
	}

	async listAgents(): Promise<readonly ChatAgent[]> {
		const result = await this.sessionApi.listAgents();
		return result.agents.flatMap(agent => agent.source.type === 'directory'
			? [{ name: agent.name, description: agent.description, sourceId: agent.source.id }]
			: []);
	}

	async readCatalog(sessionId: SessionId, previous?: ISession): Promise<ISession | undefined> {
		const generation = this.appServer.connectionGeneration;
		const result = await this.sessionApi.readCatalog({ sessionId });
		this.assertCurrentConnection(generation);
		return result.session ? toSession(result.session, [], previous) : undefined;
	}

	async subscribe(session: ISession): Promise<ISession> {
		this.assertNotDisposed();
		if (session.status !== "active") return session;
		const generation = this.appServer.connectionGeneration;
		const result = await this.sessionApi.subscribe({ sessionId: session.sessionId });
		if (this.isDisposed && generation === this.appServer.connectionGeneration) {
			await this.sessionApi.unsubscribe({ sessionId: session.sessionId });
		}
		this.assertCurrentConnection(generation);
		this.subscribed.add(session.sessionId);
		const next = toSession(result.session, result.threadProjections, session, result.agentTree.roots);
		if (next.sessionId !== session.sessionId) {
			await this.unsubscribe(session.sessionId);
			throw new Error(`Session subscription returned '${next.sessionId}' for '${session.sessionId}'`);
		}
		if (next.status !== "active") await this.unsubscribe(session.sessionId);
		return next;
	}

	async unsubscribe(sessionId: SessionId): Promise<void> {
		if (!this.subscribed.delete(sessionId)) return;
		await this.sessionApi.unsubscribe({ sessionId });
	}

	currentWorkspace(): SessionWorkspaceSelection { return this.host.workspace(); }

	async create(title: string, workspace: SessionWorkspaceSelection, model?: ModelRef, agent?: ChatAgent): Promise<IActiveSessionThread> {
		const executionTarget = workspace.type === 'multiple'
			? await this.host.selectWorkspace(workspace.folders)
			: workspace.type === 'current' ? null : workspace;
		if (executionTarget === undefined) throw canceled();
		const created = await this.sessionApi.create({ commandId: commandId("session"), title, executionTarget, agent: agent ? { type: 'exact', source: { type: 'directory', id: agent.sourceId }, name: agent.name } : { type: 'default' } });
		const thread = await this.sessionApi.createThread({ commandId: commandId("thread"), sessionId: created.session.sessionId, title: "Main" });
		const selected = model ?? await this.modelApi.readModel();
		const session = await this.subscribe(toSession(thread.session));
		if (!session.chats.some(candidate => candidate.threadId === thread.threadId && candidate.status === "active")) {
			throw new Error(`Created Thread is missing from subscribed Session snapshot: ${thread.threadId}`);
		}
		// Defaults apply to this known creation flow, never to persisted catalog facts.
		return { session: { ...session, model: session.model ?? selected ?? null }, threadId: thread.threadId };
	}

	async setModel(model: ModelRef): Promise<void> {
		await this.modelApi.setModel({ commandId: commandId("model"), model });
	}

	async archive(session: ISession): Promise<ISession> {
		const result = await this.sessionApi.archive({ commandId: commandId("archive-session"), sessionId: session.sessionId });
		await this.unsubscribe(session.sessionId);
		return toSession(result.session, [], session);
	}

	async stop(session: ISession): Promise<ISession> {
		const result = await this.sessionApi.stop({ commandId: commandId("stop-session"), sessionId: session.sessionId });
		await this.unsubscribe(session.sessionId);
		return toSession(result.session, [], session);
	}

	async interrupt(session: ISession, threadId: ThreadId): Promise<void> {
		const current = await this.sessionApi.read({ sessionId: session.sessionId });
		const node = findAgentNode(current.agentTree.roots.map(toAgentTreeNode), threadId);
		if (!node?.currentTurnId || !canInterrupt(node)) throw new Error(`Running Agent Thread is not available: ${threadId}`);
		await this.turnApi.interrupt({
			commandId: commandId("agent-interrupt"),
			sessionId: session.sessionId,
			threadId,
			turnId: node.currentTurnId,
			expectedSequence: node.threadSequence,
		});
	}

	private assertCurrentConnection(generation: number): void {
		if (this.isDisposed || generation !== this.appServer.connectionGeneration) throw canceled();
	}
}

function toSession(session: SessionDto, threads: readonly ThreadDto[] = [], previous?: ISession, agentTree?: readonly AgentTreeNodeDto[]): ISession {
	const byId = new Map(threads.map(entry => [entry.thread.threadId, entry.thread]));
	return {
		sessionId: session.sessionId,
		title: session.title,
		status: session.status,
		workspace: session.executionTarget === undefined || session.executionTarget === null ? null : {
			authorityId: session.executionTarget.type === 'local' ? 'local' : session.executionTarget.host,
			root: session.executionTarget.root,
		},
		model: session.model,
		management: { ...session.manager },
		nextApprovalMode: previous?.nextApprovalMode ?? "manual",
		chats: session.threads.map(thread => {
			const detail = byId.get(thread.threadId);
			const prior = previous?.chats.find(candidate => candidate.threadId === thread.threadId);
			return {
				threadId: thread.threadId,
				origin: thread.parentThreadId || thread.forkedFromId
					? { type: "fork" as const, parentThreadId: thread.parentThreadId ?? thread.forkedFromId!, parentSequence: detail?.sequence ?? 0 }
					: { type: "root" as const },
				status: thread.status,
				title: detail?.title ?? thread.title,
				management: thread.manager ? { ...thread.manager } : undefined,
				executionStatus: detail ? executionStatus(detail.turns.at(-1)?.status) : prior?.executionStatus ?? "idle",
			};
		}),
		agentTree: agentTree?.map(toAgentTreeNode) ?? previous?.agentTree,
	};
}

function toAgentTreeNode(node: AgentTreeNodeDto): AgentTreeNode {
	return {
		threadId: node.threadId,
		threadSequence: node.threadSequence,
		title: node.title,
		origin: node.parentThreadId || node.forkedFromId
			? { type: "fork", parentThreadId: node.parentThreadId ?? node.forkedFromId!, parentSequence: node.threadSequence }
			: { type: "root" },
		membershipStatus: "active",
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

function executionStatus(status: TurnStatusDto | undefined): AgentThreadExecutionStatus {
	switch (status) {
		case "created": return "queued";
		case "running":
		case "cancelling": return "running";
		case "waitingForApproval":
		case "waitingForUserInput":
		case "waitingForCapability": return "waiting";
		case "completed": return "completed";
		case "failed": return "failed";
		case "interrupted": return "cancelled";
		case undefined: return "idle";
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
	return node.membershipStatus === "active" && (node.executionStatus === "queued" || node.executionStatus === "running" || node.executionStatus === "waiting");
}

function commandId(kind: string): string { return `desktop-${kind}-${createUuid()}`; }
