import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { IObservable } from '../../../../base/common/observable.js';
import type { IActiveSessionThread, ISession, ModelRef, SessionExecutionTarget, SessionId, SessionWorkspaceSelection, ThreadId } from './session.js';
import type { ChatAgent } from '../../../../workbench/services/chat/common/chatService.js';
import type { IAutomationStore } from '../../../../workbench/contrib/chat/common/automations/automationService.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { SessionWorktreeStart } from '../../../../platform/agentHost/common/agent.js';

export interface ISessionCreateOptions {
	readonly devContainer?: boolean;
	readonly branchName?: string;
	readonly worktreeStart?: SessionWorktreeStart;
	readonly environmentVariables?: Readonly<Record<string, string>>;
	readonly additionalFolders?: readonly SessionExecutionTarget[];
	readonly token: CancellationToken;
}

export interface ISessionsProviderAutomations extends IAutomationStore {
	/** Resolve a tool receipt on this provider without exposing the catalogue's composite ID format. */
	getAutomationByBackendId?(id: string): import('../../../../workbench/contrib/chat/common/automations/automation.js').IAutomationDescriptor | undefined;
}

/** Adapts one backend into frontend Session and Chat objects. */
export interface ISessionsProvider extends IDisposable {
	/** Borrowed scope used by conversation owners to construct provider-scoped presentation. */
	readonly instantiationService?: import('../../../../platform/instantiation/common/instantiation.js').IInstantiationService;
	readonly id: string;
	readonly label: string;
	readonly order: number;
	/** This provider's connection scope mounts and retires its Session directories. */
	readonly ownsSessionFileSystem?: boolean;
	readonly automations?: ISessionsProviderAutomations;
	readonly connectionStatus?: IObservable<'connecting' | 'connected' | 'disconnected'>;
	/** The catalog and its detail subscriptions must be read again; selection remains frontend-owned. */
	readonly onDidChangeCatalog: Event<void>;
	readonly onDidChangeSession: Event<{ sessionId: SessionId; detailChanged: boolean; }>;
	list(): Promise<readonly ISession[]>;
	listAgents(): Promise<readonly ChatAgent[]>;
	readCatalog(sessionId: SessionId, previous?: ISession): Promise<ISession | undefined>;
	/** Acquires one detail lease per Session; concurrent callers share the in-flight acquisition. */
	subscribe(session: ISession): Promise<ISession>;
	/** Cancels pending acquisition and releases it before the next lease can be acquired. */
	unsubscribe(sessionId: SessionId): Promise<void>;
	currentWorkspace(): SessionWorkspaceSelection;
	/** Available checkouts on this provider's host, preserving execution authority. */
	getWorktrees?(workspace: SessionExecutionTarget, token: CancellationToken, includeOtherRepositories?: boolean): Promise<readonly {
		readonly label: string;
		readonly target: SessionExecutionTarget;
		readonly repository?: SessionExecutionTarget;
	}[]>;
	/** Creation identity is stable across retries; model defaults are applied by the first Turn's owner. */
	create(title: string, workspace: SessionWorkspaceSelection, agent?: ChatAgent, creationId?: string, options?: ISessionCreateOptions): Promise<IActiveSessionThread>;
	forkChat?(sessionId: SessionId, threadId: ThreadId, title: string, creationId: string): Promise<IActiveSessionThread>;
	canMoveChat?(): boolean;
	canChangeDirectory?(): boolean;
	changeDirectory?(sessionId: SessionId, root: string, commandId: string): Promise<void>;
	moveChat?(sessionId: SessionId, threadId: ThreadId, destination: SessionId, commandId: string): Promise<void>;
	setModel(model: ModelRef): Promise<void>;
	archive(session: ISession): Promise<ISession>;
	deleteSession(session: ISession): Promise<void>;
	renameSession(session: ISession, title: string): Promise<ISession>;
	restore(session: ISession): Promise<ISession>;
	stop(session: ISession): Promise<ISession>;
	interrupt(session: ISession, threadId: ThreadId): Promise<void>;
}
