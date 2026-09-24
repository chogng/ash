import {
	Action2,
} from "../../../platform/actions/common/actions.js";
import type {
	ServicesAccessor,
} from "../../../platform/instantiation/common/instantiation.js";
import { INativeHostService } from "../../common/services.js";

export const ToggleDeveloperToolsCommandId =
	"workbench.action.toggleDevTools";

/** Toggles the developer tools for the active Electron window. */
export class ToggleDeveloperToolsAction extends Action2 {
	constructor() {
		super({
			id: ToggleDeveloperToolsCommandId,
			title: "Developer: Toggle Developer Tools",
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(INativeHostService).toggleDeveloperTools();
	}
}
