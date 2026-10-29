import { localize2 } from '../../../nls.js';

import { MenuId, MenusRegistry } from '../../../platform/actions/common/actions.js';
import { RETURN_TO_WORKBENCH_COMMAND_ID } from '../../common/windowNavigation.js';
import { Menus } from '../menus.js';

const sections = [
	[localize2({ bundle: 'ash.menu', key: 'file' }, 'File'), Menus.MenubarFileMenu, 1],
	[localize2({ bundle: 'ash.menu', key: 'edit' }, 'Edit'), MenuId.MenubarEditMenu, 2],
	[localize2({ bundle: 'ash.menu', key: 'selection' }, 'Selection'), MenuId.MenubarSelectionMenu, 3],
	[localize2({ bundle: 'ash.menu', key: 'view' }, 'View'), MenuId.MenubarViewMenu, 4],
	[localize2({ bundle: 'ash.menu', key: 'go' }, 'Go'), MenuId.MenubarGoMenu, 5],
	[localize2({ bundle: 'ash.menu', key: 'terminal' }, 'Terminal'), MenuId.MenubarTerminalMenu, 7],
	[localize2({ bundle: 'ash.menu', key: 'help' }, 'Help'), MenuId.MenubarHelpMenu, 8],
] as const;

MenusRegistry.appendMenuItems(sections.map(([title, submenu, order]) => ({
	id: Menus.MenubarMainMenu,
	item: { title, submenu, group: 'navigation', order },
})));

// Common sections are explicitly shared; window-specific commands belong to the Sessions File menu.
MenusRegistry.appendMenuItem(Menus.MenubarFileMenu, {
	command: {
		id: RETURN_TO_WORKBENCH_COMMAND_ID,
		title: localize2({ bundle: 'ash', key: 'sessions.menu.workbench' }, 'Return to Workbench'),
	},
	group: '6_close',
	order: 4,
});
