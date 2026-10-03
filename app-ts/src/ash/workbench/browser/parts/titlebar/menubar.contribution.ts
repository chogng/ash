import { localize2 } from '../../../../nls.js';
import {
	MenuId,
	MenusRegistry,
} from "../../../../platform/actions/common/actions.js";

const applicationMenus = [
	[localize2({ bundle: "ash.menu", key: "file" }, "File"), MenuId.MenubarFileMenu],
	[localize2({ bundle: "ash.menu", key: "edit" }, "Edit"), MenuId.MenubarEditMenu],
	[localize2({ bundle: "ash.menu", key: "selection" }, "Selection"), MenuId.MenubarSelectionMenu],
	[localize2({ bundle: "ash.menu", key: "view" }, "View"), MenuId.MenubarViewMenu],
	[localize2({ bundle: "ash.menu", key: "go" }, "Go"), MenuId.MenubarGoMenu],
	[localize2({ bundle: "ash.menu", key: "run" }, "Run"), MenuId.MenubarRunMenu],
	[localize2({ bundle: "ash.menu", key: "terminal" }, "Terminal"), MenuId.MenubarTerminalMenu],
	[localize2({ bundle: "ash.menu", key: "help" }, "Help"), MenuId.MenubarHelpMenu],
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
