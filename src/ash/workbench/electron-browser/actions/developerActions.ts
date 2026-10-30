import { localize2 } from '../../../nls.js';

import {
	Action2,
	MenuId,
} from '../../../platform/actions/common/actions.js';
import type {
	ServicesAccessor,
} from '../../../platform/instantiation/common/instantiation.js';
import { INativeHostService } from '../../common/services.js';
import { Keybinding, logicalKey } from '../../../base/common/keybindings.js';
import { IsDevelopmentContext } from '../../../platform/contextkey/common/contextkeys.js';
import { KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';

export const ToggleDeveloperToolsCommandId =
	'workbench.action.toggleDevTools';

/** Toggles the developer tools for the active Electron window. */
export class ToggleDevToolsAction extends Action2 {
	constructor() {
		super({
			id: ToggleDeveloperToolsCommandId,
			title: localize2({ bundle: 'ash', key: 'workbench.toggleDeveloperTools' }, 'Developer: Toggle Developer Tools'),
			f1: true,
			keybinding: {
				primary: Keybinding.single(logicalKey('i', { primaryKey: true, shiftKey: true })),
				mac: { primary: Keybinding.single(logicalKey('i', { primaryKey: true, altKey: true })) },
				when: IsDevelopmentContext.isEqualTo(true),
				weight: KeybindingWeight.WorkbenchContrib + 50,
			},
			menu: { id: MenuId.MenubarHelpMenu, group: '5_tools', order: 1 },
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(INativeHostService).toggleDeveloperTools();
	}
}
