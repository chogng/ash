import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { groupSessionsForPicker, type ISessionPickItem } from './sessionsPicker.js';

export const SHOW_SESSIONS_PICKER_COMMAND_ID = 'sessions.showSessionsPicker';

function showSessionsPicker(accessor: ServicesAccessor): void {
	const catalog = accessor.get(ISessionsManagementService);
	const sessions = accessor.get(ISessionsService);
	const lifetime = new DisposableStore();
	const picker = lifetime.add(accessor.get(IQuickInputService).createQuickPick<ISessionPickItem>());
	picker.placeholder = localize({ bundle: 'ash.sessions', key: 'sessions.picker.placeholder' }, 'Select a session');
	picker.ariaLabel = picker.placeholder;
	picker.sortByLabel = false;
	const selected = sessions.activeSelection;
	const groups = groupSessionsForPicker(catalog.sessions, sessions.recentSessions, entry => sessions.getLastViewedAt(entry), selected?.kind === 'session'
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
		sessions.openSession(item.sessionId, item.threadId);
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
