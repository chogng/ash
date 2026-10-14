import type { Event } from "../../../../base/common/event.js";
import type { IDisposable } from "../../../../base/common/lifecycle.js";
import type { IObservable } from '../../../../base/common/observable.js';
import type { IActiveSessionThread, ISession, ModelRef, SessionId, SessionWorkspaceSelection, ThreadId } from "./session.js";
import type { ChatAgent } from '../../../../workbench/services/chat/common/chatService.js';
import type { IAutomationStore } from '../../../../workbench/contrib/chat/common/automations/automationService.js';

export interface ISessionsProviderAutomations extends IAutomationStore { }

/** Adapts one backend into frontend Session and Chat objects. */
export interface ISessionsProvider extends IDisposable {
	readonly id: string;
	readonly label: string;
	readonly order: number;
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
	/** Creation identity is stable across retries; model defaults are applied by the first Turn's owner. */
	create(title: string, workspace: SessionWorkspaceSelection, agent?: ChatAgent, creationId?: string): Promise<IActiveSessionThread>;
	setModel(model: ModelRef): Promise<void>;
	archive(session: ISession): Promise<ISession>;
	restore(session: ISession): Promise<ISession>;
	stop(session: ISession): Promise<ISession>;
	interrupt(session: ISession, threadId: ThreadId): Promise<void>;
}
