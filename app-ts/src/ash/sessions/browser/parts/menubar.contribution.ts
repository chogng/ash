import { localizedString } from '../../../platform/action/common/action.js';
import { MenuId, MenusRegistry } from '../../../platform/actions/common/actions.js';
import { RETURN_TO_WORKBENCH_COMMAND_ID } from '../../common/windowNavigation.js';
import { Menus } from '../menus.js';

const sections = [
	[localizedString('ash.menu', 'file', 'File'), Menus.MenubarFileMenu, 1],
	[localizedString('ash.menu', 'edit', 'Edit'), MenuId.MenubarEditMenu, 2],
	[localizedString('ash.menu', 'selection', 'Selection'), MenuId.MenubarSelectionMenu, 3],
	[localizedString('ash.menu', 'view', 'View'), MenuId.MenubarViewMenu, 4],
	[localizedString('ash.menu', 'go', 'Go'), MenuId.MenubarGoMenu, 5],
	[localizedString('ash.menu', 'terminal', 'Terminal'), MenuId.MenubarTerminalMenu, 7],
	[localizedString('ash.menu', 'help', 'Help'), MenuId.MenubarHelpMenu, 8],
] as const;

MenusRegistry.appendMenuItems(sections.map(([title, submenu, order]) => ({
	id: Menus.MenubarMainMenu,
	item: { title, submenu, group: 'navigation', order },
})));

// Common sections are explicitly shared; window-specific commands belong to the Sessions File menu.
MenusRegistry.appendMenuItem(Menus.MenubarFileMenu, {
	command: {
		id: RETURN_TO_WORKBENCH_COMMAND_ID,
		title: localizedString('ash', 'sessions.menu.workbench', 'Return to Workbench'),
	},
	group: '6_close',
	order: 4,
});
