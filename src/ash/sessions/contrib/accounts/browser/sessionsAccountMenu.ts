import type { IAction } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { OpenKeyboardShortcutsCommandId } from '../../../../workbench/contrib/preferences/common/preferences.js';
import type { SessionsPreferences } from '../../preferences/browser/sessionsPreferences.js';

/** Sessions account actions shown beside the Activity Bar account button. */
export class SessionsAccountMenu {
	constructor(
		private readonly preferences: SessionsPreferences,
		private readonly returnToWorkbench: () => void,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@ICommandService private readonly commands: ICommandService,
	) { }

	public show(anchor: HTMLElement): void {
		const settingsLabel = localize('workbench.manageSettings', 'Settings');
		const accountLabel = localize('sessions.settings.account', 'Account');
		const ideLabel = localize('sessions.menu.openIde', 'Open IDE');
		const shortcutsLabel = localize('sessions.settings.shortcuts', 'Keyboard Shortcuts');
		const actions: IAction[] = [
			{ id: 'ash.sessions.settings', label: settingsLabel, tooltip: settingsLabel, icon: Lxicon.gear, enabled: true, run: () => this.preferences.open() },
			{ id: 'workbench.action.manageAccounts', label: accountLabel, tooltip: accountLabel, icon: Lxicon.account, enabled: true, run: () => this.commands.executeCommand('workbench.action.manageAccounts') },
			{ id: 'ash.sessions.returnToWorkbench', label: ideLabel, tooltip: ideLabel, icon: Lxicon.code, enabled: true, run: this.returnToWorkbench },
			{ id: OpenKeyboardShortcutsCommandId, label: shortcutsLabel, tooltip: shortcutsLabel, icon: Lxicon.command, enabled: true, run: () => this.commands.executeCommand(OpenKeyboardShortcutsCommandId) },
		];
		anchor.setAttribute('aria-expanded', 'true');
		this.contextMenus.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
			getMenuClassName: () => 'ash-sessions-account-menu',
			onHide: () => anchor.setAttribute('aria-expanded', 'false'),
		});
	}
}
