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
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { IsSessionsWindowContext } from '../../../../../workbench/common/contextkeys.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
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
			toggled: { condition: ContextKeyExpr.has('sessions.activity.automationsSelected'), icon: Lxicon.clockfaceFilled },
			menu: { id: Menus.ActivityBar, group: 'navigation', order: 60, when: ContextKeyExpr.has('sessions.automationsAvailable') },
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

registerAction2(class ArchiveSessionAction extends Action2 {
	constructor() { super({ id: archiveId, title: localize2('chatSession.archive', 'Archive') }); }

	override async run(accessor: ServicesAccessor, argument?: unknown): Promise<void> {
		const requested = sessionTarget(argument);
		const sessions = accessor.get(ISessionsManagementService);
		const configuration = accessor.get(IConfigurationService);
		const dialogs = accessor.get(IDialogService);
		const id = requested ?? accessor.get(IChatSessionNavigationService).getActiveConversation()?.sessionId;
		await sessions.initialize();
		const session = sessions.sessions.find(candidate => candidate.sessionId === id && candidate.status === 'active');
		if (!session) throw new Error(localize('chatSession.active.missing', 'Open a session before archiving it.'));
		const action = getChatSessionArchiveActionPresentation(getChatSessionArchiveActionWording(configuration)).archive;
		const result = await dialogs.confirm({
			message: localize('chatSession.archive.confirm', '{0}: {1}?', action.title.value, session.title),
			detail: localize('chatSession.archive.detail', 'Running work in this session will be interrupted. You can restore its root conversation later.'),
			primaryButton: action.title.value,
		});
		if (result.confirmed) await sessions.archiveSession(session.sessionId);
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
