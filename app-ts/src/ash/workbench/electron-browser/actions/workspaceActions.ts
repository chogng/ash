import { Action2 } from "../../../platform/actions/common/actions.js";
import type { ServicesAccessor } from "../../../platform/instantiation/common/instantiation.js";
import { IWorkspaceOpenService } from "../../services/workspaces/browser/workspaceOpenService.js";

export const OpenFolderCommandId = "workbench.action.files.openFolder";

/** Opens a native folder picker through the window workspace service. */
export class OpenFolderAction extends Action2 {
	constructor() {
		super({
			id: OpenFolderCommandId,
			title: "Open Folder...",
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IWorkspaceOpenService).openFolder();
	}
}
