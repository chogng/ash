import type { Event } from "../../../../base/common/event.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import type { IActiveSessionThread, IUntitledChatSession, ISession, ModelRef, SessionId, ThreadId } from "./session.js";

export type SessionsManagementState = "loading" | "ready" | "creating" | "stopping" | "archiving" | "error";

/** Owns canonical Session management, active selection, and window-local untitled Chats. */
export interface ISessionsManagementService {
	readonly onDidChange: Event<void>;
	readonly sessions: readonly ISession[];
	readonly active: IActiveSessionThread | undefined;
	readonly untitledSessions: readonly IUntitledChatSession[];
	readonly activeUntitledSession: IUntitledChatSession | undefined;
	readonly state: SessionsManagementState;
	readonly error: string | undefined;
	initialize(): Promise<void>;
	selectThread(sessionId: SessionId, threadId: ThreadId): void;
	interruptThread(sessionId: SessionId, threadId: ThreadId): Promise<void>;
	createUntitledSession(title?: string): IUntitledChatSession;
	selectUntitledSession(untitledSessionId: string): void;
	discardUntitledSession(untitledSessionId: string): void;
	setUntitledSessionModel(untitledSessionId: string, model: ModelRef): void;
	materializeUntitledSession(untitledSessionId: string): Promise<IActiveSessionThread>;
	promoteUntitledSession(untitledSessionId: string, active: IActiveSessionThread): void;
	ensureActiveThread(): Promise<IActiveSessionThread>;
	startNewSession(title?: string): Promise<IActiveSessionThread>;
	stopSession(sessionId: SessionId): Promise<void>;
	archiveSession(sessionId: SessionId): Promise<void>;
	setModel(model: ModelRef): Promise<void>;
}

export const ISessionsManagementService = createServiceIdentifier<ISessionsManagementService>("sessionsManagementService");
