import { localizedString } from "../../../platform/action/common/action.js";
import { Action2, MenuId } from "../../../platform/actions/common/actions.js";
import type { ServicesAccessor } from "../../../platform/instantiation/common/instantiation.js";
import { IWorkspaceOpenService } from "../../services/workspaces/browser/workspaceOpenService.js";

export const OpenFolderCommandId = "workbench.action.files.openFolder";

/** Opens a native folder picker through the window workspace service. */
export class OpenFolderAction extends Action2 {
	constructor() {
		super({
			id: OpenFolderCommandId,
			title: localizedString("ash", "workbench.openFolder", "Open Folder..."),
			f1: true,
			menu: { id: MenuId.MenubarFileMenu, group: "2_open", order: 1 },
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IWorkspaceOpenService).openFolder();
	}
}
