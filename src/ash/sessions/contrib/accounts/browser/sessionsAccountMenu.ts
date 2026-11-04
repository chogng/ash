import type { IAction } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import type { SessionsPreferences } from '../../preferences/browser/sessionsPreferences.js';
import { OPEN_ASH_WINDOW_COMMAND_ID, OPEN_SESSIONS_KEYBOARD_SHORTCUTS_COMMAND_ID } from '../../../common/sessionCommands.js';

/** Sessions account actions shown beside the Activity Bar account button. */
export class SessionsAccountMenu {
	constructor(
		private readonly preferences: SessionsPreferences,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@ICommandService private readonly commands: ICommandService,
	) { }

	public show(anchor: HTMLElement, autoSelectFirstItem = false): void {
		const settingsLabel = localize('workbench.manageSettings', 'Settings');
		const accountLabel = localize('sessions.settings.account', 'Account');
		const ideLabel = localize('sessions.menu.openIde', 'Open IDE');
		const shortcutsLabel = localize('sessions.settings.shortcuts', 'Keyboard Shortcuts');
		const actions: IAction[] = [
			{ id: 'ash.sessions.settings', label: settingsLabel, tooltip: settingsLabel, icon: Lxicon.gear, enabled: true, run: () => this.preferences.open() },
			{ id: 'workbench.action.manageAccounts', label: accountLabel, tooltip: accountLabel, icon: Lxicon.account, enabled: true, run: () => this.commands.executeCommand('workbench.action.manageAccounts') },
			{ id: OPEN_ASH_WINDOW_COMMAND_ID, label: ideLabel, tooltip: ideLabel, icon: Lxicon.code, enabled: true, run: () => this.commands.executeCommand(OPEN_ASH_WINDOW_COMMAND_ID) },
			{ id: OPEN_SESSIONS_KEYBOARD_SHORTCUTS_COMMAND_ID, label: shortcutsLabel, tooltip: shortcutsLabel, icon: Lxicon.recordKeys, enabled: true, run: () => this.commands.executeCommand(OPEN_SESSIONS_KEYBOARD_SHORTCUTS_COMMAND_ID) },
		];
		anchor.setAttribute('aria-expanded', 'true');
		this.contextMenus.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
			getMenuClassName: () => 'ash-sessions-account-menu',
			autoSelectFirstItem,
			onHide: () => anchor.setAttribute('aria-expanded', 'false'),
		});
	}
}
