import type { Event } from "../../../../base/common/event.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import type { IActiveSessionThread, IUntitledChatSession, SessionId, ThreadId } from "../../../services/sessions/common/session.js";

/** One visible slot in the dedicated Sessions Workbench. */
export type SessionsViewSelection =
	| { readonly kind: "session"; readonly active: IActiveSessionThread }
	| { readonly kind: "untitled"; readonly session: IUntitledChatSession };

/** Owns dedicated-window visibility, active selection, and navigation history. */
export interface ISessionsService {
	readonly onDidChange: Event<void>;
	readonly visibleSelections: readonly SessionsViewSelection[];
	readonly activeSelection: SessionsViewSelection | undefined;
	readonly canNavigateBack: boolean;
	readonly canNavigateForward: boolean;
	initialize(): Promise<void>;
	openSession(sessionId: SessionId, threadId: ThreadId): void;
	openUntitledSession(untitledSessionId: string): void;
	openNewSession(title?: string): IUntitledChatSession;
	activateSelection(selection: SessionsViewSelection): void;
	closeVisibleSelection(selection: SessionsViewSelection): void;
	navigateBack(): void;
	navigateForward(): void;
}

export const ISessionsService = createServiceIdentifier<ISessionsService>("sessionsService");
