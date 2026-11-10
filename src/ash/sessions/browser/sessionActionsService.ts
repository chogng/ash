import { ISessionsListModelService } from '../services/sessions/browser/sessionsListModelService.js';
import * as chatInputStatePersistence from '../../workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import { isRecord } from '../../base/common/types.js';
import { localize } from '../../nls.js';
import { IStorageService } from '../../platform/storage/common/storage.js';
import { IChatSessionNavigationService } from '../../workbench/services/chat/common/chatSessionNavigationService.js';
import {
	getAgentSessionId,
	type IAgentSessionActionsService,
	type IAgentSessionActionItem,
	type IAgentSessionActionTarget,
	type IAgentSessionReviewEnvironmentTarget,
} from '../../workbench/contrib/chat/browser/agentSessions/agentSessionsService.js';
import { ISessionsManagementService } from '../services/sessions/common/sessionsManagement.js';
import type { ISession } from '../services/sessions/common/session.js';
import { readNewChatDraftState, writeNewChatDraftState } from '../contrib/chat/common/newChatDraftState.js';
import type { IWorkspace } from '../../platform/workspace/common/workspace.js';
import { selectionFromWorkspace } from '../common/agentHostSessionWorkspace.js';
import type { IChatListCatalog } from '../contrib/chat/browser/chatListModel.js';
import type { SessionsViewSelection } from '../services/sessions/browser/sessionsService.js';

/** Resolve the exact saved conversation named by a sidebar command. */
export function resolveSessionThreadSelection(sessions: ISessionsManagementService, argument: unknown): Extract<SessionsViewSelection, { kind: 'session'; }> | undefined {
	if (!isRecord(argument) || typeof argument.sessionId !== 'string' || typeof argument.threadId !== 'string') return;
	const session = sessions.sessions.find(session => session.sessionId === argument.sessionId && session.status === 'active');
	return session?.chats.some(chat => chat.threadId === argument.threadId && chat.status === 'active')
		? { kind: 'session', active: { session, threadId: argument.threadId } }
		: undefined;
}

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
					const input = readNewChatDraftState(storage, key, chatInputStatePersistence);
					if (input) writeNewChatDraftState(storage, input, active.threadId, chatInputStatePersistence);
					sessions.promoteUntitledSession(draftId, active);
					writeNewChatDraftState(storage, undefined, key, chatInputStatePersistence);
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
		private readonly catalog: IChatListCatalog | undefined,
		@ISessionsManagementService private readonly sessionsOwner: ISessionsManagementService,
		@IStorageService private readonly storage: IStorageService,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
		@ISessionsListModelService private readonly listModel: ISessionsListModelService,
	) { }

	get sessions(): readonly IAgentSessionActionItem[] { return this.sessionsOwner.sessions.map(actionItem); }
	initialize(): Promise<void> { return this.sessionsOwner.initialize(); }
	archiveSession(id: string): Promise<void> { return this.sessionsOwner.archiveSession(id); }
	restoreSession(id: string): Promise<void> { return this.sessionsOwner.restoreSession(id); }
	renameSession(id: string, title: string): Promise<void> { return this.sessionsOwner.renameSession(id, title); }
	deleteSession(id: string): Promise<void> { return this.sessionsOwner.deleteSession(id); }

	resolveCatalogArchiveTarget(catalogId: string): { readonly title: string; archive(): Promise<boolean>; } {
		const entry = this.getCatalogEntry(catalogId);
		if (!entry.archive) {
			throw new Error(localize('chatSession.target.invalid', 'Choose a valid session.'));
		}
		return { title: entry.title, archive: entry.archive };
	}

	resolveCatalogDeleteTarget(catalogId: string, preferenceKey: string | undefined): { readonly title: string; remove(): Promise<void>; } {
		const entry = this.getCatalogEntry(catalogId);
		// A menu opened under a previous account must not resolve to the new account's row.
		if (!entry.remove || entry.preferenceKey !== preferenceKey) {
			throw new Error(localize('chatSession.target.invalid', 'Choose a valid session.'));
		}
		return { title: entry.title, remove: entry.remove };
	}

	private getCatalogEntry(catalogId: string) {
		const entry = this.catalog?.sources.flatMap(source => source.snapshot.get().entries).find(row => row.id === catalogId);
		if (!entry || entry.disabled || entry.actionsDisabled) {
			throw new Error(localize('chatSession.target.invalid', 'Choose a valid session.'));
		}
		return entry;
	}

	resolveTarget(argument: unknown, useActive = false): IAgentSessionActionTarget {
		const captured = captureSessionActionTarget(this.sessionsOwner, this.storage, this.navigation, argument, useActive);
		return { title: captured.title, resolve: async () => actionItem(await captured.resolve()) };
	}

	getReviewEnvironmentTargets(target: { readonly sessionId?: string; readonly threadId?: string; readonly untitledSessionId?: string; }, currentWorkspace: IWorkspace): readonly IAgentSessionReviewEnvironmentTarget[] {
		if (target.threadId) {
			const session = this.sessionsOwner.sessions.find(session => session.sessionId === target.sessionId);
			const chat = session?.chats.find(chat => chat.threadId === target.threadId);
			if (!chat || chat.workspace === null) return [];
			const workspace = chat.workspace ?? session?.workspace;
			// An unknown directory cannot establish which backend owns the Thread.
			if (!workspace) return [];
			return [{ label: workspace.root, scope: workspace.authorityId === 'local' ? { type: 'thread', threadId: target.threadId } : { type: 'remote' } }];
		}
		const draft = this.sessionsOwner.untitledSessions.find(session => session.untitledSessionId === target.untitledSessionId);
		if (!draft) return [];
		const workspace = draft.workspace.type === 'current' ? selectionFromWorkspace(currentWorkspace) : draft.workspace;
		const folders = workspace.type === 'multiple' ? workspace.folders : workspace.type === 'current' ? [] : [{ label: workspace.root, target: workspace }];
		return folders.map(({ label, target }) => ({
			label, description: target.type === 'ssh' ? `${target.host}:${target.root}` : target.root,
			scope: target.type === 'local' ? { type: 'directory', root: target.root } : { type: 'remote' },
		}));
	}

	discardDraft(argument: unknown): boolean {
		if (!isRecord(argument)) return false;
		const canonical = Object.keys(argument).length === 1 && 'untitledSessionId' in argument;
		if (!canonical && argument.kind !== 'untitled') return false;
		const draftId = canonical ? argument.untitledSessionId : Reflect.get(argument.session ?? {}, 'untitledSessionId');
		if (typeof draftId !== 'string') throw new TypeError(localize('chatSession.target.invalid', 'Choose a valid session.'));
		if (this.sessionsOwner.untitledSessions.some(session => session.untitledSessionId === draftId)) {
			this.sessionsOwner.discardUntitledSession(draftId);
			writeNewChatDraftState(this.storage, undefined, `untitled:${draftId}`, chatInputStatePersistence);
		}
		return true;
	}

	async togglePin(argument: unknown): Promise<string> {
		const target = await captureSessionActionTarget(this.sessionsOwner, this.storage, this.navigation, argument, true).resolve();
		if (this.listModel.isSessionPinned(target)) {
			this.listModel.unpinSession(target);
		} else {
			this.listModel.pinSession(target);
		}
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
