import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { ICustomViewService } from '../../../../services/customView/browser/customViewService.js';
import { Menus } from '../../../../browser/menus.js';
import { AUTOMATIONS_CUSTOM_VIEW_ID } from '../automationsConstants.js';

import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ChatSessionArchiveActionWording, ChatSessionArchiveActionWordingSettingId, getChatSessionArchiveActionPresentation, getChatSessionArchiveActionWording, getChatSessionArchivedSectionLabel } from '../../../../../platform/chat/common/sessionArchiveActions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IChatSessionNavigationService } from '../../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import type { ISession } from '../../../../services/sessions/common/session.js';
import { isRecord } from '../../../../../base/common/types.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { IsSessionsWindowContext } from '../../../../../workbench/common/contextkeys.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IProjectService } from '../../../../../platform/projects/common/projectService.js';
import { ISessionGroupsService } from '../../../../services/sessions/browser/sessionGroupsService.js';
import { ISessionsConversationService } from '../../../../services/sessions/common/sessionsConversation.js';
import { readNewChatDraftState, writeNewChatDraftState } from '../../../chat/common/newChatDraftState.js';

registerAction2(class CloseSessionAction extends Action2 {
	constructor() {
		super({
			id: 'sessionsViewPane.closeSession', title: localize2('sessions.closeSession', 'Close Session'),
			f1: true, precondition: IsSessionsWindowContext.isEqualTo(true),
		});
	}

	override run(accessor: ServicesAccessor): void {
		const sessions = accessor.get(ISessionsService);
		const selection = sessions.activeSelection;
		if (!selection) return;
		sessions.closeVisibleSelection(selection);
		if (selection.kind === 'untitled') {
			writeNewChatDraftState(accessor.get(IStorageService), undefined, `untitled:${selection.session.untitledSessionId}`);
		}
	}
});

registerAction2(class ManageAutomationsAction extends Action2 {
	constructor() {
		super({
			id: 'sessionsView.manageAutomations', title: localize2('automations.title', 'Automations'),
			icon: Lxicon.clockface,
			precondition: ContextKeyExpr.has('sessions.automationsAvailable'),
			toggled: ContextKeyExpr.has('sessions.activity.automationsSelected'),
			menu: { id: Menus.CodeActivityBar, group: 'navigation', order: 20, when: ContextKeyExpr.has('sessions.automationsAvailable') },
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(ICustomViewService).showCustomView(AUTOMATIONS_CUSTOM_VIEW_ID);
	}
});

const archiveId = 'agentSession.archive';
const restoreId = 'agentSession.restore';
const archiveAllId = 'workbench.action.chat.archiveAllAgentSessions';

/** Title menus supply a captured conversation; palette invocations omit a target. */
function sessionTarget(argument: unknown): string | undefined {
	if (argument === undefined || typeof argument === 'string') return argument;
	if (argument && typeof argument === 'object') {
		const keys = Object.keys(argument);
		if (!keys.length) return undefined;
		const sessionId = Reflect.get(argument, 'sessionId');
		const threadId = Reflect.get(argument, 'threadId');
		if (keys.every(key => key === 'sessionId' || key === 'threadId') && typeof sessionId === 'string' && (threadId === undefined || typeof threadId === 'string')) return sessionId;
	}
	throw new TypeError(localize('chatSession.target.invalid', 'Choose a valid session.'));
}

/** Resolve the captured item only after its picker/confirmation is accepted. */
function sessionActionTarget(accessor: ServicesAccessor, argument: unknown, useActive = false): { readonly title: string; resolve(): Promise<ISession>; } {
	const sessions = accessor.get(ISessionsManagementService);
	const draftId = isRecord(argument) && typeof argument.untitledSessionId === 'string' && Object.keys(argument).length === 1
		? argument.untitledSessionId
		: argument === undefined && useActive ? sessions.activeUntitledSession?.untitledSessionId : undefined;
	if (draftId !== undefined) {
		const draft = sessions.untitledSessions.find(session => session.untitledSessionId === draftId);
		const promoted = sessions.materializedSessions.get().get(draftId);
		if (!draft && promoted) return sessionActionTarget(accessor, promoted.sessionId);
		if (!draft) throw new Error(localize('chatSession.target.invalid', 'Choose a valid session.'));
		const storage = accessor.get(IStorageService);
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
	const id = sessionTarget(argument) ?? (useActive ? accessor.get(IChatSessionNavigationService).getActiveConversation()?.sessionId : undefined);
	const session = sessions.sessions.find(candidate => candidate.sessionId === id);
	if (!session) throw new Error(localize('chatSession.target.invalid', 'Choose a valid session.'));
	return { title: session.title, resolve: async () => session };
}

registerAction2(class PinSessionAction extends Action2 {
	constructor() { super({ id: 'sessions.list.togglePin', title: localize2('sessions.list.pin', 'Pin chat') }); }

	override async run(accessor: ServicesAccessor, argument?: unknown): Promise<string> {
		const target = sessionActionTarget(accessor, argument, true);
		const storage = accessor.get(IStorageService);
		const session = await target.resolve();
		const key = `sessions.list.pinned.${session.sessionId}`;
		storage.store(key, !storage.getBoolean(key, StorageScope.PROFILE, false), StorageScope.PROFILE, StorageTarget.USER);
		return session.sessionId;
	}
});

registerAction2(class ArchiveSessionAction extends Action2 {
	constructor() { super({ id: archiveId, title: localize2('chatSession.archive', 'Archive') }); }

	override async run(accessor: ServicesAccessor, argument?: unknown): Promise<void> {
		const sessions = accessor.get(ISessionsManagementService);
		const configuration = accessor.get(IConfigurationService);
		const dialogs = accessor.get(IDialogService);
		await sessions.initialize();
		const target = sessionActionTarget(accessor, argument, true);
		const action = getChatSessionArchiveActionPresentation(getChatSessionArchiveActionWording(configuration)).archive;
		const result = await dialogs.confirm({
			message: localize('chatSession.archive.confirm', '{0}: {1}?', action.title.value, target.title),
			detail: localize('chatSession.archive.detail', 'Running work in this session will be interrupted. You can restore its root conversation later.'),
			primaryButton: action.title.value,
		});
		if (result.confirmed) await sessions.archiveSession((await target.resolve()).sessionId);
	}
});

registerAction2(class ArchiveAllSessionsAction extends Action2 {
	constructor() { super({ id: archiveAllId, title: localize2('chatSession.archiveAll', 'Archive All') }); }

	override async run(accessor: ServicesAccessor): Promise<void> {
		const sessions = accessor.get(ISessionsManagementService);
		const configuration = accessor.get(IConfigurationService);
		const dialogs = accessor.get(IDialogService);
		await sessions.initialize();
		const targets = sessions.sessions.filter(session => session.status === 'active').map(session => session.sessionId);
		if (!targets.length) throw new Error(localize('chatSession.active.none', 'No active sessions are available.'));
		const action = getChatSessionArchiveActionPresentation(getChatSessionArchiveActionWording(configuration)).archiveAll;
		const result = await dialogs.confirm({
			message: localize('chatSession.archiveAll.confirm', '{0} ({1} sessions)?', action.title.value, targets.length),
			detail: localize('chatSession.archiveAll.detail', 'Running work in these sessions will be interrupted. Unsent drafts are kept.'),
			primaryButton: action.title.value,
		});
		if (result.confirmed) {
			for (const id of targets) await sessions.archiveSession(id);
		}
	}
});

type ArchivedSessionPick = IQuickPickItem & ({ readonly sessionId: string; } | { readonly all: true; });

registerAction2(class RestoreSessionAction extends Action2 {
	constructor() { super({ id: restoreId, title: localize2('chatSession.restore', 'Restore') }); }

	override async run(accessor: ServicesAccessor, argument?: unknown): Promise<void> {
		sessionTarget(argument);
		const sessions = accessor.get(ISessionsManagementService);
		const navigation = accessor.get(IChatSessionNavigationService);
		const configuration = accessor.get(IConfigurationService);
		const quickInput = accessor.get(IQuickInputService);
		await sessions.initialize();
		const restore = async (id: string, shouldOpen = () => true) => {
			await sessions.restoreSession(id);
			if (!shouldOpen()) return;
			const root = sessions.sessions.find(session => session.sessionId === id)?.chats.find(chat => chat.status === 'active' && chat.origin.type === 'root');
			if (!root) throw new Error(localize('chatSession.restore.rootMissing', 'The restored root conversation is unavailable.'));
			await navigation.openConversation(id, root.threadId);
		};
		if (typeof argument === 'string') { await restore(argument); return; }
		const archived = sessions.sessions.filter(session => session.status === 'archived');
		if (!archived.length) throw new Error(localize('chatSession.archived.none', 'No archived sessions are available.'));
		const wording = getChatSessionArchiveActionWording(configuration);
		const presentation = getChatSessionArchiveActionPresentation(wording);
		const resources = new DisposableStore();
		const picker = resources.add(quickInput.createQuickPick<ArchivedSessionPick>());
		picker.ariaLabel = localize('chatSession.restore.picker', '{0} — {1}', presentation.unarchive.title.value, getChatSessionArchivedSectionLabel(wording));
		picker.placeholder = picker.ariaLabel;
		picker.items = [
			{ label: presentation.unarchiveAll.title.value, all: true },
			{ type: 'separator', label: getChatSessionArchivedSectionLabel(wording) },
			...archived.map(session => ({ label: session.title, sessionId: session.sessionId, description: session.workspace?.root })),
		];
		try {
			await new Promise<void>((resolve, reject) => {
				let pending = false;
				let closed = false;
				resources.add(picker.onDidHide(() => { closed = true; if (!pending) resolve(); }));
				resources.add(picker.onDidAccept(async () => {
					const item = picker.selectedItems[0];
					if (!item || pending) return;
					pending = true;
					picker.busy = true;
					try {
						if ('all' in item) {
							// Bulk restoration updates the catalog without taking focus from a draft.
							for (const session of archived) await sessions.restoreSession(session.sessionId);
						} else await restore(item.sessionId, () => !closed);
						resolve();
					} catch (error) { reject(error); }
					finally { picker.hide(); }
				}));
				picker.show();
			});
		} finally { resources.dispose(); }
	}
});

// The command IDs stay stable while each window resolves its configured wording.
for (const wording of [ChatSessionArchiveActionWording.Archive, ChatSessionArchiveActionWording.MarkAsDone]) {
	const presentation = getChatSessionArchiveActionPresentation(wording);
	const done = ContextKeyExpr.equals(`config.${ChatSessionArchiveActionWordingSettingId}`, 'done');
	const when = wording === ChatSessionArchiveActionWording.MarkAsDone ? done : ContextKeyExpr.notEquals(`config.${ChatSessionArchiveActionWordingSettingId}`, 'done');
	for (const [id, action] of [[archiveId, presentation.archive], [restoreId, presentation.unarchive], [archiveAllId, presentation.archiveAll]] as const) {
		MenusRegistry.appendMenuItem(MenuId.CommandPalette, { command: { id, title: localize2('chatSession.paletteAction', 'Chat: {0}', action.title.value), icon: action.icon }, when });
		if (id !== archiveAllId) MenusRegistry.appendMenuItem(MenuId.ChatTitle, { command: { id, title: action.title, icon: action.icon }, when, group: 'sessionLifecycle' });
	}
}


registerAction2(class RenameSessionAction extends Action2 {
	constructor() { super({ id: 'agentSession.rename', title: localize2('chatSession.rename', 'Chat: Rename Session'), f1: true }); }

	override async run(accessor: ServicesAccessor, argument?: unknown): Promise<void> {
		const sessions = accessor.get(ISessionsManagementService);
		await sessions.initialize();
		const target = sessionActionTarget(accessor, argument, true);
		const title = await accessor.get(IQuickInputService).input({
			title: localize('chatSession.rename.prompt', 'Session name'), value: target.title,
			validateInput: async value => !value.trim() || Array.from(value.trim()).length > 256 ? localize('chat.rename.invalid', 'Enter a name with 1 to 256 characters.') : undefined,
		});
		if (title !== undefined) await sessions.renameSession((await target.resolve()).sessionId, title.trim());
	}
});

registerAction2(class DeleteArchivedSessionAction extends Action2 {
	constructor() { super({ id: 'agentSession.delete', title: localize2('chatSession.delete', 'Chat: Delete Archived Session'), f1: true }); }

	override async run(accessor: ServicesAccessor, argument?: unknown): Promise<void> {
		const sessions = accessor.get(ISessionsManagementService);
		// Untitled chats are local drafts; deleting one must not create a backend Session.
		if (argument && typeof argument === 'object' && Reflect.get(argument, 'kind') === 'untitled') {
			const draftId = Reflect.get(Reflect.get(argument, 'session') ?? {}, 'untitledSessionId');
			if (typeof draftId !== 'string') throw new TypeError(localize('chatSession.target.invalid', 'Choose a valid session.'));
			const draft = sessions.untitledSessions.find(session => session.untitledSessionId === draftId);
			if (draft) {
				sessions.discardUntitledSession(draftId);
				writeNewChatDraftState(accessor.get(IStorageService), undefined, `untitled:${draftId}`);
			}
			return;
		}
		const requested = sessionTarget(argument);
		const input = accessor.get(IQuickInputService);
		const dialogs = accessor.get(IDialogService);
		await sessions.initialize();
		const archived = sessions.sessions.filter(session => session.status === 'archived');
		let id = requested;
		if (!id) {
			if (!archived.length) throw new Error(localize('chatSession.archived.none', 'No archived sessions are available.'));
			using resources = new DisposableStore();
			const picker = resources.add(input.createQuickPick<IQuickPickItem & { sessionId: string; }>());
			picker.ariaLabel = picker.placeholder = localize('chatSession.delete.pick', 'Choose an archived session to delete');
			picker.items = archived.map(session => ({ label: session.title, sessionId: session.sessionId }));
			id = await new Promise<string | undefined>(resolve => {
				resources.add(picker.onDidAccept(() => { const item = picker.selectedItems[0]; if (item) { resolve(item.sessionId); picker.hide(); } }));
				resources.add(picker.onDidHide(() => resolve(undefined)));
				picker.show();
			});
		}
		if (!id) return;
		const session = sessions.sessions.find(candidate => candidate.sessionId === id);
		if (!session) throw new Error(localize('chatSession.archived.missing', 'Archived session is unavailable: {0}', id));
		const confirmation = await dialogs.confirm({
			message: localize('chatSession.delete.confirm', 'Permanently delete {0}?', session.title),
			detail: localize('chatSession.delete.detail', 'This removes the session and its conversation history and cannot be undone. Any resumed work in this session will be stopped. Other sessions and unsent drafts are kept.'),
			primaryButton: localize('chatSession.delete.button', 'Delete permanently'),
		});
		if (confirmation.confirmed) {
			if (session.status === 'active') await sessions.archiveSession(session.sessionId);
			await sessions.deleteSession(session.sessionId);
		}
	}
});

registerAction2(class AddSessionToProjectAction extends Action2 {
	constructor() { super({ id: 'agentSession.addToProject', title: localize2('sessions.list.addToProject', 'Add to project') }); }

	override async run(accessor: ServicesAccessor, argument?: unknown): Promise<void> {
		const target = sessionActionTarget(accessor, argument);
		const projects = accessor.get(IProjectService);
		const input = accessor.get(IQuickInputService);
		const available = (await projects.list()).filter(project => !project.archived);
		if (!available.length) throw new Error(localize('sessions.list.noProjects', 'Create a project before adding this chat.'));
		const selected = await pickSessionDestination(input, localize('sessions.list.addToProject', 'Add to project'), available.map(project => ({ label: project.name, id: project.id })));
		if (!selected) return;
		const session = await target.resolve();
		// Project identities belong to this host's backend.
		if (session.backendSessionId) throw new Error(localize('sessions.list.projectHost', 'Projects can only include chats from this host.'));
		await projects.addSession(await projects.read(selected.id), session.sessionId);
	}
});

registerAction2(class MoveSessionToGroupAction extends Action2 {
	constructor() { super({ id: 'agentSession.moveToGroup', title: localize2('sessions.list.moveToGroup', 'Move to group') }); }

	override async run(accessor: ServicesAccessor, argument?: unknown): Promise<void> {
		const target = sessionActionTarget(accessor, argument);
		const groups = accessor.get(ISessionGroupsService);
		const input = accessor.get(IQuickInputService);
		const selected = await pickSessionDestination(input, localize('sessions.list.moveToGroup', 'Move to group'), [
			{ label: localize('sessions.list.newGroup', 'New group…'), id: 'new', create: true },
			{ label: localize('sessions.list.noGroup', 'No group'), id: '' },
			...groups.groups.map(group => ({ label: group.name, id: group.sectionId })),
		]);
		if (!selected) return;
		if (selected.create) {
			const name = await input.input({
				title: localize('sessions.list.groupName', 'Group name'),
				validateInput: async value => !value.trim() || value.trim().length > 128 ? localize('sessions.list.invalidGroup', 'Enter a name with 1 to 128 characters.') : undefined,
			});
			if (name === undefined) return;
			const session = await target.resolve();
			await groups.move(session.sessionId, (await groups.create(name.trim())).sectionId);
		} else await groups.move((await target.resolve()).sessionId, selected.id || null);
	}
});

async function pickSessionDestination(input: IQuickInputService, title: string, items: readonly (IQuickPickItem & { id: string; create?: boolean; })[]) {
	using resources = new DisposableStore();
	const picker = resources.add(input.createQuickPick<(typeof items)[number]>());
	picker.ariaLabel = picker.placeholder = title;
	picker.items = items;
	return await new Promise<(typeof items)[number] | undefined>(resolve => {
		resources.add(picker.onDidAccept(() => { const item = picker.selectedItems[0]; if (item) { resolve(item); picker.hide(); } }));
		resources.add(picker.onDidHide(() => resolve(undefined)));
		picker.show();
	});
}

registerAction2(class OpenSessionInNewWindowAction extends Action2 {
	constructor() { super({ id: 'sessions.openInNewWindow', title: localize2('sessions.list.openWindow', 'Open in new window') }); }

	override async run(accessor: ServicesAccessor, argument?: unknown): Promise<void> {
		const sessions = accessor.get(ISessionsManagementService);
		const view = accessor.get(ISessionsService);
		const conversations = accessor.get(ISessionsConversationService);
		let selection = view.activeSelection;
		if (argument !== undefined) {
			if (!argument || typeof argument !== 'object') throw new TypeError(localize('chatSession.target.invalid', 'Choose a valid session.'));
			if (Reflect.get(argument, 'kind') === 'untitled') {
				const id = Reflect.get(Reflect.get(argument, 'session') ?? {}, 'untitledSessionId');
				const session = sessions.untitledSessions.find(candidate => candidate.untitledSessionId === id);
				selection = session ? { kind: 'untitled', session } : undefined;
			} else if (Reflect.get(argument, 'kind') === 'session') {
				const active = Reflect.get(argument, 'active');
				const id = active && Reflect.get(Reflect.get(active, 'session') ?? {}, 'sessionId');
				const threadId = active && Reflect.get(active, 'threadId');
				const session = sessions.sessions.find(candidate => candidate.sessionId === id && candidate.status === 'active');
				selection = session?.chats.some(chat => chat.threadId === threadId && chat.status === 'active') ? { kind: 'session', active: { session, threadId } } : undefined;
			} else throw new TypeError(localize('chatSession.target.invalid', 'Choose a valid session.'));
		}
		if (!selection) throw new Error(localize('chatSession.target.invalid', 'Choose a valid session.'));
		view.activateSelection(selection);
		await conversations.openInNewWindow(selection);
	}
});
