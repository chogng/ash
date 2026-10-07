import { localize2 } from '../../../../nls.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';
import { OpenKeyboardShortcutsCommandId, OpenSettingsCommandId, OpenSettingsJsonCommandId } from '../common/preferences.js';

registerAction2(class OpenSettingsAction extends Action2 {
	constructor() {
		super({
			id: OpenSettingsCommandId,
			title: localize2({ bundle: 'ash', key: 'workbench.settings' }, 'Ash Settings'),
			tooltip: localize2({ bundle: 'ash', key: 'workbench.settings' }, 'Ash Settings'),
			icon: Lxicon.gear,
			menu: [
				{
					id: MenuId.EditorTitle,
					group: 'settings',
					order: 100,
				},
				{
					id: MenuId.MenubarFileMenu,
					group: '5_preferences',
					order: 1,
				},
			],
			keybinding: {
				primary: Keybinding.single(logicalKey(',', { primaryKey: true })),
			},
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor, target?: unknown): Promise<void> {
		if (target !== undefined && (typeof target !== 'string' || target.length === 0)) throw new TypeError('Settings target must be a non-empty string');
		return accessor.get(IPreferencesService).openSettings(target);
	}
});

MenusRegistry.appendMenuItem(MenuId.GlobalActivity, {
	command: { id: OpenSettingsCommandId, title: localize2({ bundle: 'ash', key: 'workbench.manageSettings' }, 'Settings') },
	group: '2_configuration',
	order: 2,
});

registerAction2(class OpenKeyboardShortcutsAction extends Action2 {
	constructor() {
		super({
			id: OpenKeyboardShortcutsCommandId,
			title: localize2({ bundle: 'ash', key: 'workbench.openKeyboardShortcuts' }, 'Preferences: Open Keyboard Shortcuts'),
			f1: true,
			menu: { id: MenuId.MenubarHelpMenu, group: '2_reference', order: 1 },
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IPreferencesService).openGlobalKeybindingSettings(false);
	}
});

MenusRegistry.appendMenuItem(MenuId.GlobalActivity, {
	command: { id: OpenKeyboardShortcutsCommandId, title: localize2({ bundle: 'ash', key: 'workbench.manageKeyboardShortcuts' }, 'Keyboard Shortcuts') },
	group: '2_configuration',
	order: 4,
});

registerAction2(class OpenSettingsJsonAction extends Action2 {
	constructor() {
		super({
			id: OpenSettingsJsonCommandId,
			title: localize2({ bundle: 'ash.settings', key: 'json.openCommand' }, 'Preferences: Open User Settings (JSON)'),
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IPreferencesService).openUserSettings();
	}
});

registerAction2(class OpenKeybindingsJsonAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.openGlobalKeybindingsFile',
			title: localize2({ bundle: 'ash', key: 'keybindings.openJson' }, 'Preferences: Open Keyboard Shortcuts (JSON)'),
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IPreferencesService).openGlobalKeybindingSettings(true);
	}
});
