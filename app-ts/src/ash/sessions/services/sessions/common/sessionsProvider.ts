import type { Event } from "../../../../base/common/event.js";
import type { IDisposable } from "../../../../base/common/lifecycle.js";
import type { IActiveSessionThread, ISession, ModelRef, SessionId, SessionWorkspaceSelection, ThreadId } from "./session.js";
import type { ChatAgent } from '../../../../workbench/services/chat/common/chatService.js';

/** Adapts one backend into frontend Session and Chat objects. */
export interface ISessionsProvider extends IDisposable {
	/** The catalog and its detail subscriptions must be read again; selection remains frontend-owned. */
	readonly onDidChangeCatalog: Event<void>;
	readonly onDidChangeSession: Event<{ sessionId: SessionId; detailChanged: boolean }>;
	list(): Promise<readonly ISession[]>;
	listAgents(): Promise<readonly ChatAgent[]>;
	readCatalog(sessionId: SessionId, previous?: ISession): Promise<ISession | undefined>;
	subscribe(session: ISession): Promise<ISession>;
	unsubscribe(sessionId: SessionId): Promise<void>;
	currentWorkspace(): SessionWorkspaceSelection;
	create(title: string, workspace: SessionWorkspaceSelection, model?: ModelRef, agent?: ChatAgent): Promise<IActiveSessionThread>;
	setModel(model: ModelRef): Promise<void>;
	archive(session: ISession): Promise<ISession>;
	stop(session: ISession): Promise<ISession>;
	interrupt(session: ISession, threadId: ThreadId): Promise<void>;
}
