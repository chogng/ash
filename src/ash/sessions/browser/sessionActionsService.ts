import { isRecord } from '../../base/common/types.js';
import { localize } from '../../nls.js';
import { IStorageService, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import { IChatSessionNavigationService } from '../../workbench/services/chat/common/chatSessionNavigationService.js';
import {
	getAgentSessionId,
	type IAgentSessionActionsService,
	type IAgentSessionActionItem,
	type IAgentSessionActionTarget,
} from '../../workbench/contrib/chat/browser/agentSessions/agentSessionsService.js';
import { ISessionsManagementService } from '../services/sessions/common/sessionsManagement.js';
import type { ISession } from '../services/sessions/common/session.js';
import { readNewChatDraftState, writeNewChatDraftState } from '../contrib/chat/common/newChatDraftState.js';

/** Resolve the captured item only after its picker/confirmation is accepted. */
export function captureSessionActionTarget(sessions: ISessionsManagementService, storage: IStorageService, navigation: IChatSessionNavigationService, argument: unknown, useActive = false): { readonly title: string; resolve(): Promise<ISession>; } {
	const draftId = isRecord(argument) && typeof argument.untitledSessionId === 'string' && Object.keys(argument).length === 1
		? argument.untitledSessionId
		: argument === undefined && useActive ? sessions.activeUntitledSession?.untitledSessionId : undefined;
	if (draftId !== undefined) {
		const draft = sessions.untitledSessions.find(session => session.untitledSessionId === draftId);
		const promoted = sessions.materializedSessions.get().get(draftId);
		if (!draft && promoted) return captureSessionActionTarget(sessions, storage, navigation, promoted.sessionId);
		if (!draft) throw new Error(localize('chatSession.target.invalid', 'Choose a valid session.'));
		return {
			title: draft.title,
			resolve: async () => {
				const active = await sessions.materializeUntitledSession(draftId);
				if (sessions.untitledSessions.some(session => session.untitledSessionId === draftId)) {
					// Park an unmounted composer's draft before the catalog removes its
					// local identity. Mounted composers retain and migrate their live input.
					const key = `untitled:${draftId}`;
					const input = readNewChatDraftState(storage, key);
					if (input) writeNewChatDraftState(storage, input, active.threadId);
					sessions.promoteUntitledSession(draftId, active);
					writeNewChatDraftState(storage, undefined, key);
				}
				return sessions.sessions.find(session => session.sessionId === active.session.sessionId) ?? active.session;
			},
		};
	}
	const id = getAgentSessionId(argument) ?? (useActive ? navigation.getActiveConversation()?.sessionId : undefined);
	const session = sessions.sessions.find(candidate => candidate.sessionId === id);
	if (!session) throw new Error(localize('chatSession.target.invalid', 'Choose a valid session.'));
	return { title: session.title, resolve: async () => session };
}


function actionItem(session: ISession): IAgentSessionActionItem {
	return {
		sessionId: session.sessionId, title: session.title, status: session.status,
		description: session.workspace?.root,
		threadIds: session.chats.map(chat => chat.threadId),
		rootThreadId: session.chats.find(chat => chat.status === 'active' && chat.origin.type === 'root')?.threadId,
	};
}

/** Implements Session semantics for Workbench actions without owning their prompts or menus. */
export class SessionActionsService implements IAgentSessionActionsService {
	constructor(
		@ISessionsManagementService private readonly sessionsOwner: ISessionsManagementService,
		@IStorageService private readonly storage: IStorageService,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
	) { }

	get sessions(): readonly IAgentSessionActionItem[] { return this.sessionsOwner.sessions.map(actionItem); }
	initialize(): Promise<void> { return this.sessionsOwner.initialize(); }
	archiveSession(id: string): Promise<void> { return this.sessionsOwner.archiveSession(id); }
	restoreSession(id: string): Promise<void> { return this.sessionsOwner.restoreSession(id); }
	renameSession(id: string, title: string): Promise<void> { return this.sessionsOwner.renameSession(id, title); }
	deleteSession(id: string): Promise<void> { return this.sessionsOwner.deleteSession(id); }

	resolveTarget(argument: unknown, useActive = false): IAgentSessionActionTarget {
		const captured = captureSessionActionTarget(this.sessionsOwner, this.storage, this.navigation, argument, useActive);
		return { title: captured.title, resolve: async () => actionItem(await captured.resolve()) };
	}

	discardDraft(argument: unknown): boolean {
		if (!isRecord(argument) || argument.kind !== 'untitled') return false;
		const draftId = Reflect.get(argument.session ?? {}, 'untitledSessionId');
		if (typeof draftId !== 'string') throw new TypeError(localize('chatSession.target.invalid', 'Choose a valid session.'));
		if (this.sessionsOwner.untitledSessions.some(session => session.untitledSessionId === draftId)) {
			this.sessionsOwner.discardUntitledSession(draftId);
			writeNewChatDraftState(this.storage, undefined, `untitled:${draftId}`);
		}
		return true;
	}

	async togglePin(argument: unknown): Promise<string> {
		const target = await this.resolveTarget(argument, true).resolve();
		const key = `sessions.list.pinned.${target.sessionId}`;
		this.storage.store(key, !this.storage.getBoolean(key, StorageScope.PROFILE, false), StorageScope.PROFILE, StorageTarget.USER);
		return target.sessionId;
	}

	captureSelection() {
		const owner = this.sessionsOwner;
		const active = owner.active;
		const untitled = owner.activeUntitledSession;
		let switched = false;
		const listener = owner.onDidChange(() => {
			switched ||= owner.active?.session.sessionId !== active?.session.sessionId
				|| owner.active?.threadId !== active?.threadId || owner.activeUntitledSession !== untitled;
		});
		return { isCurrent: () => !switched, dispose: () => listener.dispose(), [Symbol.dispose]: () => listener.dispose() };
	}
}
