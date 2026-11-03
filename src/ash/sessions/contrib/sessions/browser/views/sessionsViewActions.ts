import * as chatInputStatePersistence from '../../../../../workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import { captureSessionActionTarget } from '../../../../browser/sessionActionsService.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { ICustomViewService } from '../../../../services/customView/browser/customViewService.js';
import { Menus } from '../../../../browser/menus.js';
import { AUTOMATIONS_CUSTOM_VIEW_ID } from '../automationsConstants.js';

import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IChatSessionNavigationService } from '../../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { IsSessionsWindowContext } from '../../../../../workbench/common/contextkeys.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IProjectService } from '../../../../../platform/projects/common/projectService.js';
import { ISessionGroupsService } from '../../../../services/sessions/browser/sessionGroupsService.js';
import { ISessionsConversationService } from '../../../../services/sessions/common/sessionsConversation.js';
import { writeNewChatDraftState } from '../../../chat/common/newChatDraftState.js';

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

registerAction2(class ReopenLastClosedItemAction extends Action2 {
	constructor() {
		super({
			id: 'sessions.reopenLastClosedItem',
			title: localize2('reopenLastClosedItem', 'Reopen Closed Chat or Session'),
			f1: true,
			precondition: IsSessionsWindowContext.isEqualTo(true),
			keybinding: {
				weight: KeybindingWeight.SessionsContrib,
				when: ContextKeyExpr.not('sessions.editorTool'),
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyT,
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ISessionsService).reopenLastClosedItem();
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

function sessionActionTarget(accessor: ServicesAccessor, argument: unknown, useActive = false) {
	return captureSessionActionTarget(accessor.get(ISessionsManagementService), accessor.get(IStorageService), accessor.get(IChatSessionNavigationService), argument, useActive);
}

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
