import "./code.contribution.js";
import { createAppServerDebugAdapterCapability } from "../../../../platform/debug/browser/appServerDebugAdapterProcessService.js";
import { WorkbenchModeId } from "../../../../workbench/common/workbenchMode.js";
import { codeSessionsProfile } from "../../../common/codeSessionsProfile.js";
import { Action2, MenuId, registerAction2 } from "../../../../platform/actions/common/actions.js";
import { ILayoutService } from "../../../../platform/layout/browser/layoutService.js";
import type { ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { navigateToDedicatedWindowPage } from "../../../../platform/windows/browser/dedicatedWindowNavigation.js";
import { ashTitlebarMark } from "../../../../workbench/browser/parts/titlebar/titlebarMark.js";
import { startBrowserWorkbench } from "../../../../workbench/browser/web.bootstrap.js";

registerAction2(class OpenCodeSessionsAction extends Action2 {
	constructor() {
		super({
			id: codeSessionsProfile.titlebarActionId,
			title: "Open Code Sessions",
			tooltip: "Open Code Sessions",
			icon: ashTitlebarMark,
			menu: { id: MenuId.TitleBarAdjacentCenter, group: "navigation", order: 1 },
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): void {
		navigateToDedicatedWindowPage("../sessions/sessions-code.html", accessor.get(ILayoutService).activeContainer.ownerDocument.location);
	}
});
startBrowserWorkbench(WorkbenchModeId.Code, [createAppServerDebugAdapterCapability]);
