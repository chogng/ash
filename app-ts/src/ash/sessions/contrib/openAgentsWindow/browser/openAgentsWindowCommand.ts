import "./media/openAgentsWindowCommand.css";
import ashMarkSvg from "../../../../workbench/browser/media/ash-mark.svg?raw";
import { registerLxicon } from "../../../../base/common/lxiconsUtil.js";
import { Action2, MenuId, registerAction2 } from "../../../../platform/actions/common/actions.js";
import { ILayoutService } from "../../../../platform/layout/browser/layoutService.js";
import type { ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { navigateToDedicatedWindowPage } from "../../../../platform/windows/browser/dedicatedWindowNavigation.js";

export const ashSessionsMark = registerLxicon("ash-sessions-mark", () =>
	ashMarkSvg.replace("<svg ", '<svg class="ash-sessions-titlebar-mark" '));

/** Adds the product's dedicated Sessions entry to the existing Workbench titlebar. */
export function registerOpenAgentsWindowBrowserCommand(actionId: string, title: string, relativePath: string): void {
	registerAction2(class OpenSessionsAction extends Action2 {
		constructor() {
			super({
				id: actionId,
				title,
				tooltip: title,
				icon: ashSessionsMark,
				menu: {
					id: MenuId.TitleBarAdjacentCenter,
					group: "navigation",
					order: 1,
				},
				f1: true,
			});
		}

		override run(accessor: ServicesAccessor): void {
			navigateToDedicatedWindowPage(relativePath, accessor.get(ILayoutService).activeContainer.ownerDocument.location);
		}
	});
}
