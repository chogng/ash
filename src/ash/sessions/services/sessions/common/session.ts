import type { AgentSessionActivity as SessionManagementInfo } from '../../../../platform/agentHost/common/agent.js';
export type { AgentSessionActivity as SessionManagementInfo } from '../../../../platform/agentHost/common/agent.js';
import type { ApprovalMode, ChatAgent, ModelRef, SessionId, ThreadId } from '../../../../workbench/services/chat/common/chatService.js';
import type { TurnChangeFile, TurnChangeSetSummary } from '../../../../workbench/services/chat/common/chatService.js';
import type { IObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import type { ThemeIcon } from '../../../../base/common/themables.js';

export const enum SessionChangesetOperationScope {
	Changeset = 'changeset',
	Resource = 'resource',
	Range = 'range',
}

export const enum SessionChangesetOperationStatus {
	Idle = 'idle',
	Running = 'running',
	Error = 'error',
	Disabled = 'disabled',
}

export interface ISessionChangesetOperation {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly icon?: ThemeIcon;
	readonly group?: string;
	readonly scopes: SessionChangesetOperationScope[];
	readonly status: SessionChangesetOperationStatus;
}

export type ISessionChangesetOperationTarget = { readonly kind: 'resource'; readonly resource: URI; };

/** A captured file keeps its review identity separate from its two content resources. */
export interface ISessionFileChange {
	readonly uri: URI;
	readonly originalUri: URI;
	readonly modifiedUri: URI;
	readonly insertions: number;
	readonly deletions: number;
	readonly summary: TurnChangeSetSummary;
	readonly file: TurnChangeFile;
}

/** A read-only snapshot of a Turn capture; backend state remains owned by ChatService. */
export interface ISessionChangeset {
	readonly id: string;
	readonly resource?: URI;
	readonly label: string;
	readonly isEnabled: IObservable<boolean>;
	readonly isDefault: IObservable<boolean>;
	readonly isLoadingChanges: IObservable<boolean>;
	readonly changes: IObservable<readonly ISessionFileChange[]>;
	readonly operations: IObservable<readonly ISessionChangesetOperation[]>;
	readonly originalCheckpointRef: IObservable<string | undefined>;
	readonly modifiedCheckpointRef: IObservable<string | undefined>;
	readonly capabilities?: { readonly review?: boolean; };
	invokeOperation(operationId: string, target?: ISessionChangesetOperationTarget, meta?: Record<string, unknown>): Promise<void>;
}

export function createSessionFileChange(summary: TurnChangeSetSummary, file: TurnChangeFile): ISessionFileChange {
	const uri = URI.from({
		scheme: 'ash-turn-diff', path: `/${summary.changeSetId}/${file.path}`,
		query: `session=${encodeURIComponent(summary.sessionId)}&thread=${encodeURIComponent(summary.threadId)}&revision=${summary.revision}`,
	});
	return {
		uri, originalUri: uri.with({ query: `${uri.query}&side=before` }), modifiedUri: uri.with({ query: `${uri.query}&side=after` }),
		insertions: file.additions, deletions: file.deletions, summary, file,
	};
}

// Shared Chat identities live below Sessions so both window modes use one contract.
export type { ApprovalMode, ModelRef, SessionId, ThreadId } from '../../../../workbench/services/chat/common/chatService.js';

export type ThreadOrigin =
	| { readonly type: "root"; }
	| { readonly type: "fork"; readonly parentThreadId: ThreadId; readonly parentSequence: number; }
	| { readonly type: "rewind"; readonly parentThreadId: ThreadId; readonly parentSequence: number; readonly beforeTurnId: string; }
	| { readonly type: "agentSpawn"; readonly parentThreadId: ThreadId; readonly parentSequence: number; readonly delegationId: string; };
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
	readonly joins: readonly { readonly status: "waiting" | "satisfied"; }[];
	readonly children: readonly AgentTreeNode[];
}

/** Coarse durable activity; this does not identify an exact Turn state or waiting reason. */
export interface IChat {
	readonly threadId: ThreadId;
	readonly workspace?: ISession['workspace'];
	readonly origin: ThreadOrigin;
	readonly status: ChatStatus;
	readonly title?: string;
	readonly executionStatus?: AgentThreadExecutionStatus;
	readonly management?: SessionManagementInfo;
}

export type SessionStatus = "active" | "archived";
export type SessionWorkspaceSelection =
	| { readonly type: 'current'; }
	| { readonly type: 'local'; readonly root: string; }
	| { readonly type: 'ssh'; readonly host: string; readonly root: string; }
	| { readonly type: 'provider'; readonly providerId: string; readonly workspace: string; readonly root: string; }
	| { readonly type: 'multiple'; readonly folders: readonly { readonly label: string; readonly target: SessionExecutionTarget; }[]; };

export type SessionExecutionTarget = Extract<SessionWorkspaceSelection, { readonly type: 'local' | 'ssh' | 'provider'; }>;

/** Execution directory supplied by the Session or hydrated Thread domain snapshot. */
export interface ISessionWorkspace {
	/** Local sentinel or canonical remote URI authority, never a bare SSH alias. */
	readonly authorityId: string;
	readonly root: string;
	readonly runtime?: { readonly providerId: string; readonly workspace: string; };
}

/** Product application serving the Session catalog, independent of its execution authority. */
export interface ISessionApplication {
	readonly id: string;
	readonly label: string;
}

/** Frontend product model for one App Server Session tree. */
export interface ISession {
	/** Provenance belongs to the provider registry; sessionId is the window identity. */
	readonly providerId?: string;
	readonly providerLabel?: string;
	readonly backendSessionId?: string;
	readonly application?: ISessionApplication;
	readonly sessionId: SessionId;
	readonly title: string;
	readonly status: SessionStatus;
	readonly model?: ModelRef | null;
	readonly management?: SessionManagementInfo;
	readonly workspace?: ISessionWorkspace | null;
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
	readonly providerId?: string;
	readonly untitledSessionId: string;
	readonly title: string;
	readonly model: ModelRef | undefined;
	/** Distinguishes an explicit Auto choice from a draft awaiting its default. */
	readonly modelSelectionKind?: 'manual';
	readonly agent: ChatAgent | undefined;
	readonly workspace: SessionWorkspaceSelection;
}
