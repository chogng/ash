export type SessionId = string;
export type ThreadId = string;

export interface ModelRef {
	readonly provider: string;
	readonly model: string;
}

export type ThreadOrigin =
	| { readonly type: "root" }
	| { readonly type: "fork"; readonly parentThreadId: ThreadId; readonly parentSequence: number }
	| { readonly type: "rewind"; readonly parentThreadId: ThreadId; readonly parentSequence: number; readonly beforeTurnId: string }
	| { readonly type: "agentSpawn"; readonly parentThreadId: ThreadId; readonly parentSequence: number; readonly delegationId: string };
export type ChatStatus = "active" | "archived";
export type AgentThreadExecutionStatus = "idle" | "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";
export type AgentWaitingReason = "approval" | "userInput" | "capability";

export interface AgentTreeNode {
	readonly threadId: ThreadId;
	readonly threadSequence: number;
	readonly title: string;
	readonly origin: ThreadOrigin;
	readonly membershipStatus: ChatStatus;
	readonly executionStatus: AgentThreadExecutionStatus;
	readonly currentTurnId?: string;
	readonly waitingReason?: AgentWaitingReason;
	readonly goal?: {
		readonly goalId: string;
		readonly objective: string;
		readonly status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
		readonly tokenBudget?: number | null;
		readonly tokensUsed: number;
	};
	readonly usage: {
		readonly inputTokens: number;
		readonly outputTokens: number;
	};
	readonly role?: {
		readonly name: string;
		readonly selectionReason: "explicit" | "automatic";
	};
	readonly result?: {
		readonly status: string;
		readonly summary: string;
	};
	readonly joins: readonly { readonly status: "waiting" | "satisfied" }[];
	readonly children: readonly AgentTreeNode[];
}

export interface IChat {
	readonly threadId: ThreadId;
	readonly origin: ThreadOrigin;
	readonly status: ChatStatus;
	readonly title?: string;
	readonly executionStatus?: AgentThreadExecutionStatus;
}

export type SessionStatus = "active" | "archived";
export type ApprovalMode = "askPermissions" | "autoReview" | "bypassPermissions";

/** Frontend product model for one App Server Session tree. */
export interface ISession {
	readonly sessionId: SessionId;
	readonly title: string;
	readonly status: SessionStatus;
	readonly model?: ModelRef | null;
	readonly workspace?: {
		readonly authorityId: string;
		readonly root: string;
	} | null;
	readonly nextApprovalMode: ApprovalMode;
	readonly chats: readonly IChat[];
	/** Server-owned projection; absent only before an active Session has been subscribed. */
	readonly agentTree?: readonly AgentTreeNode[];
}

/** Selected Session and Thread shared by session navigation and features. */
export interface IActiveSessionThread {
	readonly session: ISession;
	readonly threadId: ThreadId;
}

/** An untitled Chat session that has not yet acquired a durable Session identity. */
export interface IUntitledChatSession {
	readonly untitledSessionId: string;
	readonly title: string;
	readonly model: ModelRef | undefined;
}
