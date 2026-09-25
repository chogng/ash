import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localizedString } from '../../../../platform/action/common/action.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';
import { OpenKeyboardShortcutsCommandId, OpenSettingsCommandId, OpenSettingsJsonCommandId } from '../common/preferences.js';

registerAction2(class OpenSettingsAction extends Action2 {
	constructor() {
		super({
			id: OpenSettingsCommandId,
			title: localizedString('ash', 'workbench.settings', 'Ash Settings'),
			tooltip: localizedString('ash', 'workbench.settings', 'Ash Settings'),
			icon: Lxicon.gear,
			menu: [
				{
					id: MenuId.TitleBar,
					group: 'navigation',
					order: 100,
				},
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

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IPreferencesService).openSettings();
	}
});

registerAction2(class OpenKeyboardShortcutsAction extends Action2 {
	constructor() {
		super({
			id: OpenKeyboardShortcutsCommandId,
			title: localizedString('ash', 'workbench.openKeyboardShortcuts', 'Preferences: Open Keyboard Shortcuts'),
			f1: true,
			menu: { id: MenuId.MenubarHelpMenu, group: '2_reference', order: 1 },
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IPreferencesService).openKeybindings();
	}
});

registerAction2(class OpenSettingsJsonAction extends Action2 {
	constructor() {
		super({
			id: OpenSettingsJsonCommandId,
			title: 'Preferences: Open User Settings (JSON)',
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IPreferencesService).openUserSettingsJson();
	}
});
