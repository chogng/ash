import type { Event } from '../../../../base/common/event.js';
import type { IObservable } from '../../../../base/common/observable.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IActiveSessionThread, IUntitledChatSession, ISession, SessionEnvironmentSelection, ModelRef, SessionId, ThreadId, SessionWorkspaceSelection } from './session.js';
import type { ChatAgent } from '../../../../workbench/services/chat/common/chatService.js';
import type { ISessionCreateOptions } from './sessionsProvider.js';
import type { ChatCreationKind } from '../../../common/chatCreation.js';

export type SessionsManagementState = 'loading' | 'ready' | 'creating' | 'stopping' | 'archiving' | 'error';

/** Owns canonical Session management, active selection, and window-local untitled Chats. */
export interface ISessionsManagementService {
	/** Changes on explicit selection, including leaving and returning to the same Thread. */
	readonly navigationRevision: number;
	readonly onDidChange: Event<void>;
	readonly sessions: readonly ISession[];
	/** The current catalog includes a successful enumeration of the primary host. */
	readonly primaryCatalogReady: boolean;
	readonly active: IActiveSessionThread | undefined;
	readonly untitledSessions: readonly IUntitledChatSession[];
	/** Keeps draft identity resolvable after materialization, independently of foreground selection. */
	readonly materializedSessions: IObservable<ReadonlyMap<string, { readonly sessionId: SessionId; readonly threadId: ThreadId; readonly sideThread?: true; }>>;
	readonly activeUntitledSession: IUntitledChatSession | undefined;
	readonly state: SessionsManagementState;
	readonly error: string | undefined;
	initialize(): Promise<void>;
	refresh(): Promise<void>;
	/** Reads the current provider record without changing the catalog or foreground selection. */
	readCatalog(sessionId: SessionId): Promise<ISession | undefined>;
	/** Hydrates current catalog directories without changing foreground selection. */
	whenDirectoriesReady(signal?: AbortSignal): Promise<void>;
	listAgents(): Promise<readonly ChatAgent[]>;
	/** Hydrates a thread. The Agents window commits its own foreground choice after hydration. */
	prepareThread(sessionId: SessionId, threadId: ThreadId): Promise<void>;
	openThread(sessionId: SessionId, threadId: ThreadId): Promise<void>;
	selectThread(sessionId: SessionId, threadId: ThreadId): void;
	interruptThread(sessionId: SessionId, threadId: ThreadId): Promise<void>;
	/** Background presentations can retain a draft without changing foreground selection. */
	createUntitledSession(title?: string, workspace?: SessionWorkspaceSelection, providerId?: string, activate?: boolean, forkSource?: IUntitledChatSession['forkSource'], options?: { readonly kind?: IUntitledChatSession['kind']; readonly devContainer?: boolean; readonly projectId?: string; }): IUntitledChatSession;
	resolveNewSessionTarget(): Promise<{ readonly providerId: string; readonly workspace: SessionWorkspaceSelection; readonly devContainer?: boolean; readonly projectId?: string; }>;
	restoreUntitledSession(session: IUntitledChatSession): void;
	selectUntitledSession(untitledSessionId: string): void;
	discardUntitledSession(untitledSessionId: string): void;
	setUntitledSessionCreationKind(untitledSessionId: string, kind: ChatCreationKind | undefined): void;
	setUntitledSessionModel(untitledSessionId: string, model: ModelRef | undefined): void;
	setUntitledSessionDefaultModel(untitledSessionId: string, model: ModelRef | undefined, defaults: NonNullable<IUntitledChatSession['modelDefaults']>, unavailableModel?: ModelRef): void;
	setUntitledSessionReasoningEffort(untitledSessionId: string, effort: NonNullable<IUntitledChatSession['reasoningEffortSelection']> | null): void;
	setUntitledSessionAgent(untitledSessionId: string, agent: ChatAgent | undefined): void;
	setUntitledSessionWorkspace(untitledSessionId: string, workspace: SessionWorkspaceSelection | undefined, options?: { readonly devContainer?: boolean; readonly branchName?: string; readonly providerId?: string; readonly environment?: SessionEnvironmentSelection; readonly clearEnvironment?: boolean; readonly projectId?: string; }): void;
	/** Organization and first send share one creation; creating a durable identity does not submit a request. */
	materializeUntitledSession(untitledSessionId: string, signal?: AbortSignal): Promise<IActiveSessionThread>;
	cancelUntitledSessionPreparation(untitledSessionId: string): void;
	promoteUntitledSession(untitledSessionId: string, active: IActiveSessionThread): void;
	/** Publishes the sent Session and re-arms the same composer for a different Session. */
	completeBackgroundSend(untitledSessionId: string, active: IActiveSessionThread): void;
	ensureActiveThread(): Promise<IActiveSessionThread>;
	startNewSession(title?: string, background?: { readonly workspace: SessionWorkspaceSelection; readonly providerId: string; readonly creation: ISessionCreateOptions; readonly creationId?: string; }): Promise<IActiveSessionThread>;
	stopSession(sessionId: SessionId): Promise<void>;
	archiveSession(sessionId: SessionId): Promise<void>;
	/** Restores the canonical catalog entry without changing foreground selection or drafts. */
	restoreSession(sessionId: SessionId): Promise<void>;
	deleteSession(sessionId: SessionId): Promise<void>;
	renameSession(sessionId: SessionId, title: string): Promise<void>;
	getChatMoveDestinations?(sessionId: SessionId, threadId: ThreadId): readonly ISession[];
	/** Ignore temporary activity when deciding whether to offer a disabled menu action. */
	canChangeDirectory?(sessionId: SessionId, options?: { readonly ignoreActivity?: true; }): boolean;
	canClearDirectory?(sessionId: SessionId): boolean;
	changeDirectory?(sessionId: SessionId, root: string | null, signal?: AbortSignal): Promise<void>;
	moveChat?(sessionId: SessionId, threadId: ThreadId, destination: SessionId): Promise<void>;
	setModel(model: ModelRef): Promise<void>;
}

export const ISessionsManagementService = createServiceIdentifier<ISessionsManagementService>('sessionsManagementService');
