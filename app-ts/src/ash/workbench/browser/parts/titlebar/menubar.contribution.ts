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

for (const [index, [title, submenu]] of applicationMenus.entries()) {
	MenusRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
		title,
		submenu,
		group: "navigation",
		order: index + 1,
	});
}
