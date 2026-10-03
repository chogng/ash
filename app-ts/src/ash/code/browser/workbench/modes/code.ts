import { localize2 } from '../../../../nls.js';
import "./code.contribution.js";
import "../../../../sessions/contrib/providers/appServer/browser/workbenchSessionsService.contribution.js";
import "../../../../sessions/browser/workbenchChat.contribution.js";
import "../../../../sessions/browser/turnMultiDiffSource.contribution.js";
import { createAppServerDebugAdapterCapability } from "../../../../platform/debug/browser/appServerDebugAdapterProcessService.js";
import { WorkbenchModeId } from "../../../../workbench/common/workbenchMode.js";
import { codeSessionsProfile } from "../../../common/codeSessionsProfile.js";
import { Action2, MenuId, registerAction2 } from "../../../../platform/actions/common/actions.js";
import { ILayoutService } from "../../../../platform/layout/browser/layoutService.js";
import type { ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { ashTitlebarMark } from "../../../../workbench/browser/parts/titlebar/titlebarMark.js";
import { startBrowserWorkbench } from "../../../../workbench/browser/web.bootstrap.js";

registerAction2(class OpenCodeSessionsAction extends Action2 {
	constructor() {
		super({
			id: codeSessionsProfile.titlebarActionId,
			title: localize2({ bundle: 'ash.workbench', key: 'command.OpenCodeSessionsAction' }, "Open Code Sessions"),
			tooltip: "Open Code Sessions",
			icon: ashTitlebarMark,
			menu: { id: MenuId.TitleBarAdjacentCenter, group: "navigation", order: 1 },
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): void {
		const location = accessor.get(ILayoutService).activeContainer.ownerDocument.location;
		location.assign(new URL('../sessions/sessions-code.html', location.href).href);
	}
});
await startBrowserWorkbench(WorkbenchModeId.Code, [createAppServerDebugAdapterCapability]);
