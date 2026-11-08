import * as chatInputStatePersistence from '../../../../../workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import { captureSessionActionTarget, resolveSessionThreadSelection } from '../../../../browser/sessionActionsService.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { ICustomViewService } from '../../../../services/customView/browser/customViewService.js';
import { Menus } from '../../../../browser/menus.js';
import { AUTOMATIONS_CUSTOM_VIEW_ID, SCHEDULED_CUSTOM_VIEW_ID } from '../automationsConstants.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenusRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { SessionsMenuActiveConversationContext, SessionsMenuCanChangeFolderContext, SessionsMenuCanClearFolderContext, SessionsMenuWorkspaceIdleContext, SessionsWorkspaceModeContext } from '../../../../common/contextkeys.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IChatSessionNavigationService } from '../../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { IsSessionsWindowContext } from '../../../../../workbench/common/contextkeys.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IProjectService } from '../../../../../platform/projects/common/projectService.js';
import { ISessionGroupsService } from '../../../../services/sessions/browser/sessionGroupsService.js';
import { ISessionsConversationService } from '../../../../services/sessions/common/sessionsConversation.js';
import { writeNewChatDraftState } from '../../../chat/common/newChatDraftState.js';
import { pickSessionDestination } from '../sessionsPicker.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { isCancellationError } from '../../../../../base/common/errors.js';

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
			writeNewChatDraftState(accessor.get(IStorageService), undefined, `untitled:${selection.session.untitledSessionId}`, chatInputStatePersistence);
		}
	}
});

registerAction2(class ManageAutomationsAction extends Action2 {
	constructor() {
		super({
			id: 'sessionsView.manageAutomations', title: localize2('automations.title', 'Routines'),
			icon: Lxicon.clockface,
			precondition: ContextKeyExpr.has('sessions.automationsAvailable'),
			toggled: ContextKeyExpr.has('sessions.activity.automationsSelected'),
			menu: { id: Menus.ActivityBar, group: 'more', order: 20, when: ContextKeyExpr.and(SessionsWorkspaceModeContext.isEqualTo('code'), ContextKeyExpr.has('sessions.automationsAvailable')) },
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(ICustomViewService).showCustomView(AUTOMATIONS_CUSTOM_VIEW_ID);
	}
});

registerAction2(class ManageScheduledTasksAction extends Action2 {
	constructor() {
		const available = ContextKeyExpr.and(SessionsWorkspaceModeContext.isEqualTo('chat'), ContextKeyExpr.has('sessions.scheduledAvailable'));
		super({
			id: 'sessionsView.manageScheduledTasks',
			title: localize2('scheduled.title', 'Scheduled'),
			icon: Lxicon.clockface,
			precondition: available,
			toggled: ContextKeyExpr.has('sessions.activity.scheduledSelected'),
			menu: { id: Menus.ActivityBar, group: 'navigation', order: 35, when: available },
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(ICustomViewService).showCustomView(SCHEDULED_CUSTOM_VIEW_ID);
	}
});

function sessionActionTarget(accessor: ServicesAccessor, argument: unknown, useActive = false) {
	return captureSessionActionTarget(accessor.get(ISessionsManagementService), accessor.get(IStorageService), accessor.get(IChatSessionNavigationService), argument, useActive);
}

registerAction2(class AddSessionToProjectAction extends Action2 {
	constructor() { super({ id: 'agentSession.addToProject', title: localize2('sessions.list.addToProject', 'Add to project') }); }

	override async run(accessor: ServicesAccessor, argument?: unknown): Promise<void> {
		const target = sessionActionTarget(accessor, argument);
		const projects = accessor.get(IProjectService);
		const input = accessor.get(IQuickInputService);
		const scope = accessor.get(IContextKeyService).getValue(SessionsWorkspaceModeContext.key) === 'code' ? 'code' : 'chat';
		const available = (await projects.list(scope)).filter(project => !project.archived);
		if (!available.length) throw new Error(localize('sessions.list.noProjects', 'Create a project before adding this chat.'));
		const selected = await pickSessionDestination(input, localize('sessions.list.addToProject', 'Add to project'), available.map(project => ({ label: project.name, id: project.id })));
		if (!selected) return;
		const session = await target.resolve();
		// Project identities belong to this host's backend.
		if (session.backendSessionId) throw new Error(localize('sessions.list.projectHost', 'Projects can only include chats from this host.'));
		await projects.addSession(await projects.read(selected.id, scope), session.sessionId);
	}
});

async function promptForSessionGroupName(input: IQuickInputService): Promise<string | undefined> {
	const name = await input.input({
		title: localize('sessions.list.groupName', 'Group name'),
		validateInput: async value => !value.trim() || value.trim().length > 128 ? localize('sessions.list.invalidGroup', 'Enter a name with 1 to 128 characters.') : undefined,
	});
	return name?.trim();
}

MenusRegistry.appendMenuItems([
	{
		id: Menus.SidebarSessionsHeader, item: {
			submenu: Menus.SessionsViewFilter,
			title: localize2('sessions.list.moreActions', 'More Sessions Actions'),
			icon: Lxicon.listFilter,
			group: 'navigation', order: 10,
		}
	},
]);

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
			const name = await promptForSessionGroupName(input);
			if (name === undefined) return;
			const session = await target.resolve();
			await groups.move(session.sessionId, (await groups.create(name)).sectionId);
		} else await groups.move((await target.resolve()).sessionId, selected.id || null);
	}
});

function resolveWorkspaceSessionId(sessions: ISessionsManagementService, argument: unknown): string | undefined {
	if (typeof argument === 'string') return argument;
	const target = resolveSessionThreadSelection(sessions, argument);
	return target && target.active.threadId === target.active.session.sessionId ? target.active.session.sessionId : undefined;
}

registerAction2(class ChangeSessionDirectoryAction extends Action2 {
	constructor() {
		super({
			id: 'agentSession.changeDirectory', title: localize2({ bundle: 'ash.sessions', key: 'sessions.directory.change' }, 'Change Workspace…'),
			icon: Lxicon.folder, precondition: SessionsMenuWorkspaceIdleContext.isEqualTo(true),
			menu: { id: Menus.SidebarCodeSessionContext, group: '4_conversation', when: SessionsMenuCanChangeFolderContext.isEqualTo(true) },
		});
	}

	override async run(accessor: ServicesAccessor, argument?: unknown): Promise<void> {
		const sessions = accessor.get(ISessionsManagementService);
		const id = resolveWorkspaceSessionId(sessions, argument);
		if (!id || !sessions.canChangeDirectory?.(id) || !sessions.changeDirectory) return;
		const workspace = sessions.sessions.find(session => session.sessionId === id)?.workspace;
		const dialogs = accessor.get(IFileDialogService);
		const [folder] = await dialogs.showOpenDialog({
			title: workspace
				? localize({ bundle: 'ash.sessions', key: 'sessions.directory.change' }, 'Change Workspace…')
				: localize({ bundle: 'ash.sessions', key: 'sessions.directory.set' }, 'Set Workspace…'),
			canSelectFolders: true, canSelectFiles: false, canSelectMany: false, availableFileSystems: ['file'],
			defaultUri: workspace ? URI.file(workspace.root) : undefined,
		}) ?? [];
		if (folder?.scheme !== 'file' || folder.authority) return;
		try {
			await sessions.changeDirectory(id, folder.fsPath);
			status(localize({ bundle: 'ash.sessions', key: 'sessions.workspace.enabled' }, 'Workspace set to {0}.', folder.fsPath));
		} catch (error) {
			if (!isCancellationError(error)) throw error;
		}
	}
});

registerAction2(class ClearSessionDirectoryAction extends Action2 {
	constructor() {
		super({
			id: 'agentSession.clearDirectory', title: localize2({ bundle: 'ash.sessions', key: 'sessions.directory.clear' }, 'Remove Workspace'),
			precondition: SessionsMenuWorkspaceIdleContext.isEqualTo(true),
			menu: { id: Menus.SidebarCodeSessionContext, group: '4_conversation', order: 1, when: SessionsMenuCanClearFolderContext.isEqualTo(true) },
		});
	}

	override async run(accessor: ServicesAccessor, argument?: unknown): Promise<void> {
		const sessions = accessor.get(ISessionsManagementService);
		const id = resolveWorkspaceSessionId(sessions, argument);
		if (!id || !sessions.canChangeDirectory?.(id) || !sessions.canClearDirectory?.(id) || !sessions.changeDirectory
			|| !sessions.sessions.find(session => session.sessionId === id)?.workspace) return;
		try {
			await sessions.changeDirectory(id, null);
			status(localize({ bundle: 'ash.sessions', key: 'sessions.workspace.disabled' }, 'Workspace off.'));
		} catch (error) {
			if (!isCancellationError(error)) throw error;
		}
	}
});

registerAction2(class OpenSessionInNewWindowAction extends Action2 {
	constructor() {
		super({
			id: 'sessions.openInNewWindow', title: localize2('sessions.list.openWindow', 'Open in new window'), icon: Lxicon.linkExternal,
			menu: { id: Menus.SidebarCodeSessionContext, group: '4_conversation', when: SessionsMenuActiveConversationContext.isEqualTo(true) },
		});
	}

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
			} else selection = resolveSessionThreadSelection(sessions, argument);
		}
		if (!selection) throw new Error(localize('chatSession.target.invalid', 'Choose a valid session.'));
		view.activateSelection(selection);
		await conversations.openInNewWindow(selection);
	}
});
