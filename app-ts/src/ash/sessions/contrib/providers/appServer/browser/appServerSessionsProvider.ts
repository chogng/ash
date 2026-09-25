import type { AgentTreeNodeProjection as AgentTreeNodeDto, Session as SessionDto, SessionThreadProjection as ThreadDto, TurnStatus as TurnStatusDto } from "../../../../../platform/app-server/common/generated/index.js";
import { Emitter } from "../../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import { createUuid } from "../../../../../base/common/uuid.js";
import type { IServerEventApi } from "../../../../../platform/app-server/common/appServerApi.js";
import type { IModelApi, ISessionApi, ITurnApi } from "../../../../../platform/sessions/common/sessionApi.js";
import type { AgentThreadExecutionStatus, AgentTreeNode, IActiveSessionThread, ISession, ModelRef, SessionId, ThreadId } from "../../../../services/sessions/common/session.js";
import type { ISessionsProvider } from "../../../../services/sessions/common/sessionsProvider.js";

export interface AppServerSessionsProviderHost {
	readonly session: ISessionApi;
	readonly model?: IModelApi;
	readonly turn?: ITurnApi;
	readonly events?: IServerEventApi;
}

/** App Server adapter. Generated DTOs do not cross this provider boundary. */
export class AppServerSessionsProvider extends Disposable implements ISessionsProvider {
	private readonly subscribed = new Set<SessionId>();
	private catalogSubscribed = false;
	private model: ModelRef | null = null;
	private readonly _onDidChangeSession = this._register(new Emitter<{ sessionId: SessionId; detailChanged: boolean }>());
	readonly onDidChangeSession = this._onDidChangeSession.event;

	constructor(private readonly host: AppServerSessionsProviderHost) {
		super();
		if (host.events) {
			const subscription = host.events.subscribe(event => {
				if (event.method === "session/changed") this._onDidChangeSession.fire({ sessionId: event.params.sessionId, detailChanged: event.params.agentTreeChanged });
				if (event.method === "session/deleted") this._onDidChangeSession.fire({ sessionId: event.params.sessionId, detailChanged: false });
			});
			this._register(toDisposable(() => subscription.dispose()));
		}
		this._register(toDisposable(() => {
			void host.session.unsubscribeCatalog().catch(error => console.error("Failed to unsubscribe Session catalog", error));
			for (const sessionId of this.subscribed) {
				void host.session.unsubscribe({ sessionId }).catch(error => console.error(`Failed to unsubscribe Session '${sessionId}'`, error));
			}
			this.subscribed.clear();
		}));
	}

	async list(): Promise<readonly ISession[]> {
		const [result, model] = await Promise.all([
			this.catalogSubscribed ? this.host.session.list() : this.host.session.subscribeCatalog(),
			this.host.model?.readModel() ?? Promise.resolve(null),
		]);
		this.catalogSubscribed = true;
		this.model = model;
		return result.sessions.map(session => ({ ...toSession(session), model }));
	}

	async readCatalog(sessionId: SessionId, previous?: ISession): Promise<ISession | undefined> {
		const result = await this.host.session.readCatalog({ sessionId });
		return result.session ? { ...toSession(result.session, [], previous), model: previous?.model ?? this.model } : undefined;
	}

	async subscribe(session: ISession): Promise<ISession> {
		if (session.status !== "active") return session;
		const result = await this.host.session.subscribe({ sessionId: session.sessionId });
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
		await this.host.session.unsubscribe({ sessionId });
	}

	async create(title: string, model?: ModelRef): Promise<IActiveSessionThread> {
		if (model) await this.setModel(model);
		const created = await this.host.session.create({ commandId: commandId("session"), title, agent: { type: "default" } });
		const thread = await this.host.session.createThread({ commandId: commandId("thread"), sessionId: created.session.sessionId, title: "Main" });
		const selected = model ?? await this.host.model?.readModel();
		const session = await this.subscribe({ ...toSession(thread.session), model: selected ?? null });
		if (!session.chats.some(candidate => candidate.threadId === thread.threadId && candidate.status === "active")) {
			throw new Error(`Created Thread is missing from subscribed Session snapshot: ${thread.threadId}`);
		}
		return { session, threadId: thread.threadId };
	}

	async setModel(model: ModelRef): Promise<void> {
		if (!this.host.model) throw new Error("Model selection is unavailable in this renderer host.");
		await this.host.model.setModel({ commandId: commandId("model"), model });
		this.model = model;
	}

	async archive(session: ISession): Promise<ISession> {
		const result = await this.host.session.archive({ commandId: commandId("archive-session"), sessionId: session.sessionId });
		await this.unsubscribe(session.sessionId);
		return toSession(result.session, [], session);
	}

	async stop(session: ISession): Promise<ISession> {
		const result = await this.host.session.stop({ commandId: commandId("stop-session"), sessionId: session.sessionId });
		await this.unsubscribe(session.sessionId);
		return toSession(result.session, [], session);
	}

	async interrupt(session: ISession, threadId: ThreadId): Promise<void> {
		if (!this.host.turn) throw new Error("Turn interruption is unavailable in this renderer host.");
		const current = await this.host.session.read({ sessionId: session.sessionId });
		const node = findAgentNode(current.agentTree.roots.map(toAgentTreeNode), threadId);
		if (!node?.currentTurnId || !canInterrupt(node)) throw new Error(`Running Agent Thread is not available: ${threadId}`);
		await this.host.turn.interrupt({
			commandId: commandId("agent-interrupt"),
			sessionId: session.sessionId,
			threadId,
			turnId: node.currentTurnId,
			expectedSequence: node.threadSequence,
		});
	}
}

function toSession(session: SessionDto, threads: readonly ThreadDto[] = [], previous?: ISession, agentTree?: readonly AgentTreeNodeDto[]): ISession {
	const byId = new Map(threads.map(entry => [entry.thread.threadId, entry.thread]));
	return {
		sessionId: session.sessionId,
		title: session.title,
		status: session.status,
		model: previous?.model,
		nextApprovalMode: previous?.nextApprovalMode ?? "askPermissions",
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
