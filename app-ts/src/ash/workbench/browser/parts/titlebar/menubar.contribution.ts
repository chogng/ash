import {
	MenuId,
	MenusRegistry,
} from "../../../../platform/actions/common/actions.js";
import { localizedString } from "../../../../platform/action/common/action.js";

const applicationMenus = [
	[localizedString("ash.menu", "file", "File"), MenuId.MenubarFileMenu],
	[localizedString("ash.menu", "edit", "Edit"), MenuId.MenubarEditMenu],
	[localizedString("ash.menu", "selection", "Selection"), MenuId.MenubarSelectionMenu],
	[localizedString("ash.menu", "view", "View"), MenuId.MenubarViewMenu],
	[localizedString("ash.menu", "go", "Go"), MenuId.MenubarGoMenu],
	[localizedString("ash.menu", "run", "Run"), MenuId.MenubarRunMenu],
	[localizedString("ash.menu", "terminal", "Terminal"), MenuId.MenubarTerminalMenu],
	[localizedString("ash.menu", "help", "Help"), MenuId.MenubarHelpMenu],
] as const;

MenusRegistry.appendMenuItems(applicationMenus.map(([title, submenu], index) => ({
	id: MenuId.MenubarMainMenu,
	item: {
		title,
		submenu,
		group: "navigation",
		order: index + 1,
	},
})));
