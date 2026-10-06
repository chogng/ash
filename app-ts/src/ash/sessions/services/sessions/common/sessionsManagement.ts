import type { Event } from "../../../../base/common/event.js";
import type { IObservable } from "../../../../base/common/observable.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import type { IActiveSessionThread, IUntitledChatSession, ISession, ModelRef, SessionId, ThreadId } from "./session.js";
import type { ChatAgent } from '../../../../workbench/services/chat/common/chatService.js';

export type SessionsManagementState = "loading" | "ready" | "creating" | "stopping" | "archiving" | "error";

/** Owns canonical Session management, active selection, and window-local untitled Chats. */
export interface ISessionsManagementService {
	readonly onDidChange: Event<void>;
	readonly sessions: readonly ISession[];
	readonly active: IActiveSessionThread | undefined;
	readonly untitledSessions: readonly IUntitledChatSession[];
	/** Keeps draft identity resolvable after first send, independently of foreground selection. */
	readonly materializedSessions: IObservable<ReadonlyMap<string, { readonly sessionId: SessionId; readonly threadId: ThreadId; }>>;
	readonly activeUntitledSession: IUntitledChatSession | undefined;
	readonly state: SessionsManagementState;
	readonly error: string | undefined;
	initialize(): Promise<void>;
	listAgents(): Promise<readonly ChatAgent[]>;
	openThread(sessionId: SessionId, threadId: ThreadId): Promise<void>;
	selectThread(sessionId: SessionId, threadId: ThreadId): void;
	interruptThread(sessionId: SessionId, threadId: ThreadId): Promise<void>;
	createUntitledSession(title?: string): IUntitledChatSession;
	restoreUntitledSession(session: IUntitledChatSession): void;
	selectUntitledSession(untitledSessionId: string): void;
	discardUntitledSession(untitledSessionId: string): void;
	setUntitledSessionModel(untitledSessionId: string, model: ModelRef | undefined): void;
	setUntitledSessionDefaultModel(untitledSessionId: string, model: ModelRef | undefined): void;
	setUntitledSessionAgent(untitledSessionId: string, agent: ChatAgent | undefined): void;
	materializeUntitledSession(untitledSessionId: string): Promise<IActiveSessionThread>;
	promoteUntitledSession(untitledSessionId: string, active: IActiveSessionThread): void;
	ensureActiveThread(): Promise<IActiveSessionThread>;
	startNewSession(title?: string): Promise<IActiveSessionThread>;
	stopSession(sessionId: SessionId): Promise<void>;
	archiveSession(sessionId: SessionId): Promise<void>;
	setModel(model: ModelRef): Promise<void>;
}

export const ISessionsManagementService = createServiceIdentifier<ISessionsManagementService>("sessionsManagementService");
