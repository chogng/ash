import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { isRecord } from '../../../../base/common/types.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { groupSessionsForPicker, pickSessionDestination, type ISessionPickItem } from './sessionsPicker.js';
import { runSessionsListMove } from './views/sessionsListChatMove.js';
import { Menus } from '../../../browser/menus.js';
import { SHOW_ASH_CHAT_COMMAND } from '../../chat/common/constants.js';
import { SessionsMenuCanMoveConversationContext, SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';

export const SHOW_SESSIONS_PICKER_COMMAND_ID = 'sessions.showSessionsPicker';

function showSessionsPicker(accessor: ServicesAccessor): void {
	const contextKeys = accessor.get(IContextKeyService);
	const mode = contextKeys.getValue(SessionsWorkspaceModeContext.key);
	const nativeChat = mode === 'chat' && CommandsRegistry.hasCommand(SHOW_ASH_CHAT_COMMAND);
	const commands = nativeChat ? accessor.get(ICommandService) : undefined;
	const catalog = accessor.get(ISessionsManagementService);
	const sessions = accessor.get(ISessionsService);
	const lifetime = new DisposableStore();
	const picker = lifetime.add(accessor.get(IQuickInputService).createQuickPick<ISessionPickItem>());
	picker.placeholder = localize({ bundle: 'ash.sessions', key: 'sessions.picker.placeholder' }, 'Select a session');
	picker.ariaLabel = picker.placeholder;
	picker.sortByLabel = false;
	const selected = nativeChat ? sessions.getChatSelection() : sessions.activeSelection;
	const candidates = catalog.sessions.filter(session => {
		if (mode === 'code') return session.kind === 'code';
		if (nativeChat) return session.kind === 'chat' && session.backendSessionId === undefined;
		return true;
	});
	const groups = groupSessionsForPicker(candidates, sessions.recentSessions, entry => sessions.getLastViewedAt(entry), selected?.kind === 'session'
		? { sessionId: selected.active.session.sessionId, threadId: selected.active.threadId } : undefined);
	picker.items = [
		...groups.needsInput,
		...(groups.unread.length ? [
			{ type: 'separator' as const, label: localize({ bundle: 'ash.sessions', key: 'sessions.picker.unread' }, 'Unread'), presentation: 'section' as const },
			...groups.unread,
			...(groups.other.length ? [{ type: 'separator' as const, label: localize({ bundle: 'ash.sessions', key: 'sessions.picker.other' }, 'Other sessions'), presentation: 'section' as const }] : []),
		] : []),
		...groups.other,
	];
	lifetime.add(picker.onDidAccept(() => {
		const item = picker.selectedItems[0];
		if (!item) return;
		picker.hide();
		if (contextKeys.getValue(SessionsWorkspaceModeContext.key) !== mode) return;
		if (commands) {
			void commands.executeCommand(SHOW_ASH_CHAT_COMMAND).then(() => {
				if (contextKeys.getValue(SessionsWorkspaceModeContext.key) === 'chat') sessions.selectChatThread(item.sessionId, item.threadId);
			}).catch(onUnexpectedError);
		} else {
			void sessions.openSession(item.sessionId, item.threadId, mode === 'code' ? { reveal: 'code' } : undefined).catch(onUnexpectedError);
		}
	}));
	lifetime.add(picker.onDidHide(() => lifetime.dispose()));
	picker.show();
}

registerAction2(class ShowSessionsPickerAction extends Action2 {
	constructor() {
		super({
			id: SHOW_SESSIONS_PICKER_COMMAND_ID,
			f1: true,
			title: localize2({ bundle: 'ash.sessions', key: 'command.ShowSessionsChatHistoryAction' }, 'Show Session History'),
			precondition: IsSessionsWindowContext.isEqualTo(true),
		});
	}

	override run(accessor: ServicesAccessor): void { showSessionsPicker(accessor); }
});

CommandsRegistry.register('sessions.chat.history', showSessionsPicker);

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

export const MOVE_CHAT_TO_SESSION_ACTION_ID = 'sessions.list.moveChatToSession';

registerAction2(class MoveChatToSessionAction extends Action2 {
	constructor() {
		super({
			id: MOVE_CHAT_TO_SESSION_ACTION_ID, title: localize2({ bundle: 'ash.sessions', key: 'sessions.list.moveChat' }, 'Move Conversation to Session…'),
			menu: { id: Menus.SidebarCodeSessionContext, group: '4_conversation', when: SessionsMenuCanMoveConversationContext.isEqualTo(true) },
		});
	}

	override async run(accessor: ServicesAccessor, argument?: unknown): Promise<void> {
		if (!isRecord(argument) || typeof argument.sessionId !== 'string' || typeof argument.threadId !== 'string') return;
		const { sessionId, threadId } = argument;
		const sessions = accessor.get(ISessionsManagementService);
		const view = accessor.get(ISessionsService);
		const input = accessor.get(IQuickInputService);
		const destinations = sessions.getChatMoveDestinations?.(sessionId, threadId);
		const moveChat = sessions.moveChat?.bind(sessions);
		if (!destinations?.length || !moveChat) return;
		const selected = await pickSessionDestination(input, localize({ bundle: 'ash.sessions', key: 'sessions.list.moveChat' }, 'Move Conversation to Session…'),
			destinations.map(session => ({ label: session.title, id: session.sessionId, description: session.workspace?.root })));
		if (!selected) return;
		await runSessionsListMove(view, sessionId, threadId, selected.id, moveChat);
	}
});
